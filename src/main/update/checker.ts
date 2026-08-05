// The update check itself (P2-E19-03, plan §E19).
//
// One function, one network call, one plain result record — the `preflight.ts`
// shape. It reports facts; what to DO about them is `service.ts`, and what the
// user reads is the renderer's.
//
// ── THE ONE HARD PROBLEM, and why the endpoint is what it is ────────────────
//
// The repo is PRIVATE. GitHub answers **404** both for "you may not see this
// repo" and for "this repo has no `latest` release", and ClaudeMon's checker —
// which asked `/releases/latest` anonymously — read that 404 as "no releases,
// you're up to date" and would have said so forever (plan §E19 decision 5).
//
// So we do not ask that question. We ask `GET /repos/{owner}/{repo}/releases`,
// whose two answers are genuinely different:
//
//   • **200 with `[]`** — we can see the repo, and it has no releases yet.
//     That is honestly "nothing to offer".
//   • **404** — we cannot see the repo at all. That is an AUTH problem, and it
//     is reported as one. Never as up to date.
//
// The list endpoint costs one extra decision (pick `latest` ourselves, below)
// and buys the distinction the item's done-when asks for.
//
// ── what this may talk to ───────────────────────────────────────────────────
//
// The GitHub API host, for this repo's releases, and nothing else (PHILOSOPHY
// local-first; §E19's own note). No telemetry, no version-ping, no analytics.
import { UpdateCheckResult, UpdateFailureReason } from '../../shared/update';
import { isNewerVersion, normalizeVersion, parseVersion } from './version';
import { resolveUpdateToken, TokenSource } from './token';

/**
 * The feed. Hard-coded rather than read from package.json's `repository`,
 * which this project deliberately does not set — electron-builder infers a
 * publish target from that field, and #257 owns packaging's configuration.
 */
export const RELEASES_ENDPOINT =
  'https://api.github.com/repos/badsonstudios/switchboard.ai/releases?per_page=30';

/** How long the API gets before we give up and call it a network failure. */
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Release bodies are rendered in-app, so they are also an input. A tag with a
 * megabyte of body in it should make the dialog boring, not the renderer sad.
 */
const MAX_NOTES_CHARS = 20_000;

/** The subset of GitHub's release object this cares about. */
interface GithubRelease {
  tag_name?: unknown;
  name?: unknown;
  body?: unknown;
  html_url?: unknown;
  draft?: unknown;
  prerelease?: unknown;
  published_at?: unknown;
}

export interface CheckDeps {
  /** package.json semver of the running build (`app.getVersion()`) */
  currentVersion: string;
  /** overridable for tests and for the dev/test feed seam */
  endpoint?: string;
  /** injected in unit tests; defaults to the runtime's own fetch */
  fetchImpl?: typeof fetch;
  /** injected in unit tests; defaults to the §E19 resolution order */
  tokenSources?: TokenSource[];
  /**
   * Skip token resolution entirely. Set by the dev/test feed seam, where the
   * feed is a local stub that wants no credentials — and where reaching for
   * `gh auth token` would be a live call to a real credential store from a
   * test.
   */
  skipToken?: boolean;
  now?: () => Date;
  /** debug/warn only; the update path never reports itself to the user */
  log?: (msg: string, meta?: Record<string, unknown>) => void;
}

function fail(
  currentVersion: string,
  checkedAt: string,
  state: 'failed' | 'disabled',
  reason: UpdateFailureReason
): UpdateCheckResult {
  return { ok: false, state, currentVersion, reason, checkedAt };
}

/**
 * Ask the feed whether there is a newer build. Never throws.
 *
 * The result is a record in every case, including the ones that are nobody's
 * fault: no token, no network, no releases.
 */
export async function checkForUpdate(deps: CheckDeps): Promise<UpdateCheckResult> {
  const now = deps.now ?? (() => new Date());
  const checkedAt = now().toISOString();
  const currentVersion = deps.currentVersion;
  const endpoint = deps.endpoint ?? RELEASES_ENDPOINT;
  const doFetch = deps.fetchImpl ?? globalThis.fetch;

  if (typeof doFetch !== 'function') {
    // Should be unreachable on Node 22 / Electron; a missing fetch is still a
    // record, not a TypeError escaping into the startup path.
    return fail(currentVersion, checkedAt, 'failed', 'network');
  }

  let token: string | null = null;
  if (!deps.skipToken) {
    const resolved = await resolveUpdateToken(deps.tokenSources);
    token = resolved.token;
    if (!token) {
      // THE done-when, verbatim: with no token the app behaves identically to
      // today — no dialog, no error, ONE debug line.
      deps.log?.('update check disabled: no token could be resolved locally');
      return fail(currentVersion, checkedAt, 'disabled', 'no-token');
    }
  }

  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    // GitHub requires a User-Agent and rejects requests without one.
    'user-agent': `switchboard.ai/${currentVersion}`,
  };
  if (token) headers.authorization = `Bearer ${token}`;

  // AbortController rather than a bare race: a check that has given up must
  // also stop the socket, or a dead feed leaks one connection per day.
  //
  // The deadline covers the BODY, not just the headers, and that is the whole
  // point of where `clearTimeout` sits. A server that answers 200 and then
  // stalls the body would otherwise leave `res.json()` pending forever — and
  // because the service caches its in-flight promise, every later check
  // (including a manual one) would join that same promise and never resolve.
  // Update checks would silently stop working for the life of the process,
  // with no log line to say why.
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), REQUEST_TIMEOUT_MS);
  try {
    let res: Response;
    try {
      res = await doFetch(endpoint, { headers, signal: abort.signal, redirect: 'follow' });
    } catch (err) {
      deps.log?.('update check could not reach the release host', { error: String(err) });
      return fail(currentVersion, checkedAt, 'failed', 'network');
    }

    if (!res.ok) {
      const reason = statusReason(res);
      deps.log?.('update check refused by the release host', { status: res.status, reason });
      return fail(currentVersion, checkedAt, 'failed', reason);
    }

    let body: unknown;
    try {
      body = await res.json();
    } catch (err) {
      // An aborted body read lands here too, which is right: a feed that stops
      // mid-answer told us nothing usable.
      deps.log?.('update check got a response it could not read', { error: String(err) });
      return fail(currentVersion, checkedAt, 'failed', 'bad-response');
    }
    if (!Array.isArray(body)) {
      deps.log?.('update check got a non-list from the releases endpoint');
      return fail(currentVersion, checkedAt, 'failed', 'bad-response');
    }
    return decide(body as GithubRelease[], currentVersion, checkedAt, deps);
  } finally {
    clearTimeout(timer);
  }
}

/** The comparison, once a list is in hand. Split out to keep the timer scope tidy. */
function decide(
  body: GithubRelease[],
  currentVersion: string,
  checkedAt: string,
  deps: CheckDeps
): UpdateCheckResult {
  const best = pickLatest(body, deps.log);
  if (!best) {
    // 200 and nothing eligible: we can SEE the repo, it has published nothing
    // we would offer. This is the branch the 404 must never be confused with.
    return { ok: true, state: 'up-to-date', currentVersion, checkedAt };
  }

  const latestVersion = normalizeVersion(String(best.tag_name));
  if (!isNewerVersion(latestVersion, currentVersion)) {
    return { ok: true, state: 'up-to-date', currentVersion, latestVersion, checkedAt };
  }
  return {
    ok: true,
    state: 'available',
    currentVersion,
    latestVersion,
    notes: notesOf(best),
    url: typeof best.html_url === 'string' ? best.html_url : undefined,
    publishedAt: typeof best.published_at === 'string' ? best.published_at : undefined,
    checkedAt,
  };
}

/**
 * Which failure a non-2xx is.
 *
 * **404 is `auth`** — the whole point (decision 5). 401/403 are the same
 * family; a 403 with the rate-limit counter at zero is the one case worth
 * telling apart, because "ask again tomorrow" is genuinely different advice
 * from "your token cannot see this repo".
 */
export function statusReason(res: {
  status: number;
  headers: { get(name: string): string | null };
}): UpdateFailureReason {
  if (res.status === 429) return 'rate-limit';
  if (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0') return 'rate-limit';
  if (res.status === 401 || res.status === 403 || res.status === 404) return 'auth';
  return 'bad-response';
}

/**
 * The release we would offer: the highest version among the published,
 * non-pre-release entries.
 *
 * Highest VERSION rather than "the first one GitHub listed": the list is
 * ordered by creation date, and a re-published or back-dated older release
 * would otherwise be offered as an upgrade. Drafts are excluded because drafts
 * are §E19's staging mechanism — a draft is a release nobody has decided to
 * ship yet, and offering one to every install is the failure the notes-required
 * gate in #258 exists to prevent, arriving by another door.
 *
 * Exported for its own unit tests.
 */
export function pickLatest(
  releases: GithubRelease[],
  log?: (msg: string, meta?: Record<string, unknown>) => void
): GithubRelease | null {
  let best: GithubRelease | null = null;
  let skipped = 0;
  for (const r of releases) {
    if (!r || typeof r !== 'object') continue;
    if (r.draft === true || r.prerelease === true) continue;
    if (typeof r.tag_name !== 'string') continue;
    if (!parseVersion(r.tag_name)) {
      skipped++;
      continue;
    }
    if (!best || isNewerVersion(r.tag_name, String(best.tag_name))) best = r;
  }
  if (skipped) log?.('update check skipped releases with unreadable tags', { skipped });
  return best;
}

function notesOf(r: GithubRelease): string {
  const body = typeof r.body === 'string' ? r.body.trim() : '';
  if (!body) return '';
  return body.length > MAX_NOTES_CHARS ? `${body.slice(0, MAX_NOTES_CHARS)}\n\n…` : body;
}
