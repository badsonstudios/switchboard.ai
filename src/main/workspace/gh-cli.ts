// The GitHub CLI, for "Push & open pull request…" and the removal check (E42
// step 3, #1638). Decision 1 on #1636: a PR is the merge, and `gh` is how a PR
// is opened here, the same tool the user already signed in with. We never hold
// a token of our own.
//
// `gh` may be missing or signed out. Both are ANSWERS (`missing`, `auth`), not
// errors: the dialog says which, and nothing half-done is left behind.
//
// The runner is injectable so tests never touch the network or a real account:
// the default one runs `gh` with `execFile`-style argv (never a shell), a bound,
// no prompts, and the body on stdin (a multi-line body with quotes in it is a
// Windows quoting bug waiting to happen as an argument).
import { spawn } from 'child_process';
import type { PullRequestInfo } from '../../shared/projects';
import { killTree } from '../transport/kill-tree';

/** `gh` gets this long per call before we stop waiting. */
export const GH_BUDGET_MS = 30_000;

export type GhFailure = 'missing' | 'auth' | 'timeout' | 'failed';

export interface GhRun {
  ok: boolean;
  out: string;
  err: string;
  failure?: GhFailure;
}

export type GhRunner = (args: string[], cwd: string, opts?: { input?: string; budgetMs?: number }) => Promise<GhRun>;

/** Did `gh` say it is not signed in? Its wording, as of 2.x. */
function saysNotAuthed(err: string): boolean {
  return /gh auth login|not logged in|authentication required|GH_TOKEN/i.test(err);
}

export const runGh: GhRunner = (args, cwd, opts = {}) =>
  new Promise((resolve) => {
    let out = '';
    let err = '';
    let done = false;
    const finish = (r: GhRun): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('gh', args, {
        cwd,
        windowsHide: true,
        env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1' },
      });
    } catch {
      resolve({ ok: false, out: '', err: '', failure: 'missing' });
      return;
    }
    const budget = opts.budgetMs ?? GH_BUDGET_MS;
    const timer = setTimeout(() => {
      killTree(child);
      finish({ ok: false, out, err, failure: 'timeout' });
    }, budget);
    child.stdout?.on('data', (c: Buffer) => (out = (out + c.toString('utf8')).slice(-200_000)));
    child.stderr?.on('data', (c: Buffer) => (err = (err + c.toString('utf8')).slice(-20_000)));
    child.on('error', (e: NodeJS.ErrnoException) =>
      finish({ ok: false, out, err: e.message, failure: e.code === 'ENOENT' ? 'missing' : 'failed' })
    );
    child.on('close', (code) => {
      if (code === 0) finish({ ok: true, out, err });
      else finish({ ok: false, out, err, failure: saysNotAuthed(err) ? 'auth' : 'failed' });
    });
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(opts.input ?? '');
  });

/** `gh`'s last non-empty line, which is where it puts the reason. */
export function ghSaid(r: GhRun): string {
  const lines = `${r.err}\n${r.out}`
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '');
  return (lines[lines.length - 1] ?? '').slice(0, 300);
}

function toInfo(x: unknown): PullRequestInfo | null {
  if (!x || typeof x !== 'object') return null;
  const o = x as Record<string, unknown>;
  const state = o.state === 'OPEN' || o.state === 'CLOSED' || o.state === 'MERGED' ? o.state : null;
  if (typeof o.number !== 'number' || typeof o.url !== 'string' || !state) return null;
  if (!/^https:\/\//.test(o.url)) return null;
  const sha = typeof o.headRefOid === 'string' && /^[0-9a-f]{40,64}$/.test(o.headRefOid) ? o.headRefOid : null;
  return { number: o.number, url: o.url, state, draft: o.isDraft === true, ...(sha ? { headSha: sha } : {}) };
}

/**
 * The pull requests for a branch, newest first, any state. `{ failure }` when
 * `gh` could not say (missing, signed out, offline).
 */
export async function prsForBranch(
  gh: GhRunner,
  cwd: string,
  branch: string
): Promise<{ prs: PullRequestInfo[] } | { failure: GhFailure; detail: string }> {
  const r = await gh(
    ['pr', 'list', `--head=${branch}`, '--state', 'all', '--limit', '20', '--json', 'number,url,state,isDraft,headRefOid'],
    cwd
  );
  if (!r.ok) return { failure: r.failure ?? 'failed', detail: ghSaid(r) };
  try {
    const parsed: unknown = JSON.parse(r.out || '[]');
    const prs = Array.isArray(parsed) ? parsed.map(toInfo).filter((p): p is PullRequestInfo => p !== null) : [];
    return { prs: prs.sort((a, b) => b.number - a.number) };
  } catch {
    return { failure: 'failed', detail: 'gh answered something that is not a list of pull requests' };
  }
}

/**
 * Open a PR for `branch` into `base`. The body goes on stdin. Answers the PR
 * (read back with `gh pr view`, so the number and state are gh's) or why not.
 */
export async function createPr(
  gh: GhRunner,
  cwd: string,
  req: { branch: string; base: string; title: string; body: string; draft: boolean }
): Promise<{ pr: PullRequestInfo } | { failure: GhFailure; detail: string }> {
  const r = await gh(
    [
      'pr',
      'create',
      // one argument each, so a title starting with a dash is never a flag
      `--head=${req.branch}`,
      `--base=${req.base}`,
      `--title=${req.title}`,
      '--body-file=-',
      ...(req.draft ? ['--draft'] : []),
    ],
    cwd,
    { input: req.body, budgetMs: GH_BUDGET_MS * 2 }
  );
  if (!r.ok) return { failure: r.failure ?? 'failed', detail: ghSaid(r) };
  const found = await prsForBranch(gh, cwd, req.branch);
  const open = 'prs' in found ? found.prs.find((p) => p.state === 'OPEN') : undefined;
  if (open) return { pr: open };
  // created, but the read-back failed: gh printed the URL as its last line
  const url = r.out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^https:\/\/\S+\/pull\/\d+$/.test(l))
    .pop();
  if (url) return { pr: { number: Number(url.split('/').pop()), url, state: 'OPEN', draft: req.draft } };
  return { failure: 'failed', detail: 'gh said it opened the pull request but did not say where' };
}
