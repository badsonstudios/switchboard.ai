// File a GitHub issue from inside the app (#815).
//
// THIS IS NOT A NEW TRUST BOUNDARY, and that is why it is allowed to exist at
// all under P8 (local-first): the update checker has polled
// `api.github.com/repos/badsonstudios/switchboard.ai/releases` hourly since
// P2-E19-03. Same host, same credential chain, same repo. What is new is the
// DIRECTION — this writes — which is why it carries its own capability rather
// than borrowing `update.check` (the argument `push.send` makes in
// `shared/ipc/capabilities.ts`).
//
// THE LIMIT, STATED WHERE SOMEONE WILL LOOK FOR IT: **GitHub's REST API cannot
// attach a file to an issue.** Attachments are a web-form-only capability. So
// this posts TEXT, and the diagnostic zip stays on disk and is revealed. A
// button that claimed to send the logs and silently dropped them would be the
// worst possible shape for a feature whose entire job is moving evidence.
//
// The request shape — headers, timeout, AbortController, injectable `fetch` —
// is `update/checker.ts`'s, deliberately: two ways of talking to one host is
// how they drift.
//
// ONE CASE THAT CANNOT BE FIXED FROM HERE, recorded rather than hidden: a POST
// aborted by the timeout AFTER GitHub accepted it reports `'network'`, and a
// user who tries again gets a second issue. The REST API offers no idempotency
// key, so there is nothing to deduplicate against. The neighbouring case — a
// 201 whose body we cannot parse — IS handled, and is reported as created
// precisely so it does not invite the same duplicate.
import { errorText } from '../../shared/error-text';
import { resolveUpdateToken, type TokenSource } from '../update/token';
import { REPORT_REPO, type ReportProblem } from '../../shared/diagnostics';
import type { LogFields } from '../log/logger';

/** GitHub gets this long to answer before we give up and say so. */
export const REQUEST_TIMEOUT_MS = 15_000;

export interface CreateIssueDeps {
  title: string;
  body: string;
  /** `owner/repo`; defaults to this project's own */
  repo?: string;
  /** for the User-Agent GitHub insists on */
  version: string;
  tokenSources?: TokenSource[];
  fetchImpl?: typeof globalThis.fetch;
  /** never receives the token or the body — only shapes and counts */
  log?: (msg: string, fields?: LogFields) => void;
}

export interface CreateIssueResult {
  ok: boolean;
  url: string | null;
  number: number | null;
  problem?: ReportProblem;
}

const fail = (problem: ReportProblem): CreateIssueResult => ({
  ok: false,
  url: null,
  number: null,
  problem,
});

/**
 * Which refusal this was, so the dialog can say something TRUE about it.
 *
 * The status alone is not enough, and getting this wrong sends the user to fix
 * the one thing that is not broken:
 *
 * - **429, and 403 carrying `retry-after`**, are GitHub's *secondary* rate
 *   limit — the one that actually bites content-creating POSTs like this one.
 *   It does NOT zero `x-ratelimit-remaining`, so keying only on that count
 *   reported "your token may have expired" to somebody who had simply filed
 *   two reports in a row. `update/checker.ts` already maps 429 this way.
 * - **404 is still read as AUTH**, though the repo is public now (#1494) and
 *   its existence is no secret. The repo name is a constant that is known to
 *   be right, and `createIssue` has already short-circuited when there is no
 *   token at all — so a 404 on this POST is GitHub's documented habit of
 *   answering 404 rather than 403 to a token that lacks write permission (a
 *   classic token without `public_repo`, or a fine-grained one not granted
 *   this repo). Calling it "refused" would send someone hunting for a typo in
 *   a repo name that is correct, when the fix is the token.
 */
function problemForStatus(status: number, headers: Headers): ReportProblem {
  if (status === 429) return 'rate-limited';
  const rateLimited =
    headers.get('retry-after') !== null || headers.get('x-ratelimit-remaining') === '0';
  if (status === 403 && rateLimited) return 'rate-limited';
  if (status === 401 || status === 403 || status === 404) return 'auth';
  return 'refused';
}

/**
 * Create the issue. Never throws; every outcome is a result.
 */
export async function createIssue(deps: CreateIssueDeps): Promise<CreateIssueResult> {
  const repo = deps.repo ?? REPORT_REPO;
  const doFetch = deps.fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== 'function') return fail('network');

  const { token } = await resolveUpdateToken(deps.tokenSources);
  if (!token) {
    // Not an error state to shout about: a machine with no `gh` and nothing
    // pasted cannot POST, and `diag:submit` hands the report to GitHub's
    // new-issue form in the browser instead (#1494).
    deps.log?.('issue not filed: no credential could be resolved locally');
    return fail('no-token');
  }

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), REQUEST_TIMEOUT_MS);
  try {
    let res: Response;
    try {
      res = await doFetch(`https://api.github.com/repos/${repo}/issues`, {
        method: 'POST',
        headers: {
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          // GitHub rejects requests without a User-Agent.
          'user-agent': `switchboard.ai/${deps.version}`,
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ title: deps.title, body: deps.body }),
        signal: abort.signal,
        redirect: 'follow',
      });
    } catch (err) {
      // Offline, DNS, TLS, or our own abort. One outcome for the user.
      deps.log?.('issue could not reach github', { error: errorText(err) });
      return fail('network');
    }

    if (!res.ok) {
      const problem = problemForStatus(res.status, res.headers);
      deps.log?.('github refused the issue', { status: res.status, problem });
      return fail(problem);
    }

    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch (err) {
      // A 201 whose body we cannot read still CREATED the issue, so this is
      // not reported as a failure — it is reported as a success we cannot link
      // to, which is the truth.
      deps.log?.('github accepted the issue but its answer could not be read', {
        error: errorText(err),
      });
      return { ok: true, url: null, number: null };
    }

    const o = (parsed ?? {}) as { html_url?: unknown; number?: unknown };
    const url = typeof o.html_url === 'string' ? o.html_url : null;
    const number = typeof o.number === 'number' ? o.number : null;
    deps.log?.('issue filed', { number: number ?? -1 });
    return { ok: true, url, number };
  } finally {
    clearTimeout(timer);
  }
}
