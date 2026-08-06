/**
 * The build-time half of P2-E15-15: ask git who we are, so the bundler can
 * stamp the answer into the app (`electron.vite.config.ts` → `define`).
 *
 * **This file runs in the vite config, in Node — never in the app.** That is
 * exactly why it does not live in `src/shared`: shared is bundled into the
 * renderer, and one stray import of it there would drag `child_process` across
 * the context-isolation boundary. `src/build` is the Node-only build support
 * corner; nothing under `src/main`, `src/preload` or `src/renderer` may import
 * from it.
 *
 * Everything here is fail-open by construction. `npm run build` on a machine
 * with no git, or in an exported tarball, must still produce a working app —
 * it just produces one that says "unknown" when asked what it is.
 */
import { execFileSync } from 'child_process';
import { BuildIdentity, UNKNOWN_BUILD_IDENTITY } from '../shared/build-identity';

/** Runs `git <args>` and returns stdout, or throws. Injected in tests. */
export type GitRunner = (args: string[]) => string;

/** Length of the short SHA we stamp. Long enough to stay unambiguous in a repo
 *  this size, short enough to sit in a title bar chip. */
const SHORT_SHA_LENGTH = 8;

function execGit(cwd: string): GitRunner {
  return (args) =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      // stderr to 'ignore': a git failure is a normal, expected outcome here
      // (no repo, no git on PATH) and must not spray red into a clean build log
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    });
}

/** One git question. Returns null instead of throwing — every caller here
 *  treats "couldn't ask" and "answer was empty" identically. */
function ask(run: GitRunner, args: string[]): string | null {
  try {
    const out = run(args).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

export interface ProbeOptions {
  /** repo to ask about; defaults to the process CWD (i.e. the project root) */
  cwd?: string;
  /** injected git, for tests */
  run?: GitRunner;
  /** injected clock, for tests */
  now?: () => Date;
  /** injected environment, for the CI branch fallback */
  env?: Record<string, string | undefined>;
}

/**
 * Ask git what this build is.
 *
 * The branch is the fiddly part. `rev-parse --abbrev-ref HEAD` answers `HEAD`
 * on a detached checkout — which is precisely what CI does (`actions/checkout`
 * lands on a detached commit), so a CI artefact would otherwise report no
 * branch at all. GitHub hands the real name over in the environment instead:
 * `GITHUB_HEAD_REF` on a pull_request build (the source branch), `GITHUB_REF_NAME`
 * elsewhere. Local detached checkouts — a worktree parked on a SHA — still
 * report null, which is honest and is rendered as "detached".
 *
 * The fallback chain is `||`, NOT `??`, and that is the whole of #300: GitHub
 * defines `GITHUB_HEAD_REF` on *every* event and sets it to the EMPTY STRING on
 * the ones that have no head ref (push, schedule, workflow_dispatch). `'' ?? x`
 * is `''`, so a `??` chain stops at the empty string and every push build —
 * including every build of `main` — stamped itself "detached" while
 * `GITHUB_REF_NAME` sat right there holding the answer. An absent variable and
 * an empty one mean the same thing here ("GitHub has no head ref for you"), so
 * the operator that treats them the same is the correct one.
 */
export function probeBuildIdentity(opts: ProbeOptions = {}): BuildIdentity {
  const now = opts.now ?? ((): Date => new Date());
  const env = opts.env ?? process.env;
  const builtAt = now().toISOString();
  const run = opts.run ?? execGit(opts.cwd ?? process.cwd());

  const commit = ask(run, ['rev-parse', `--short=${SHORT_SHA_LENGTH}`, 'HEAD']);
  if (!commit) {
    // No commit means no repo (or no git). Nothing else is worth asking, but
    // the build time is still real and still the most useful stale-build tell.
    return { ...UNKNOWN_BUILD_IDENTITY, builtAt };
  }

  const head = ask(run, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const branch =
    head && head !== 'HEAD' ? head : env.GITHUB_HEAD_REF || env.GITHUB_REF_NAME || null;

  // `--porcelain` is silent on a clean tree and already excludes .gitignore'd
  // paths, so `out/` and `node_modules/` never make a build look dirty.
  // Untracked-but-not-ignored files DO count: a new source file that is not in
  // the commit means the SHA does not describe what was built.
  const dirty = ask(run, ['status', '--porcelain']) !== null;

  return { commit, branch, dirty, builtAt };
}

/** One-line summary for the build log — the same string the app will show. */
export function describeIdentity(id: BuildIdentity): string {
  const sha = id.commit ? `${id.commit}${id.dirty ? '*' : ''}` : 'unknown';
  return `${sha} on ${id.branch ?? 'detached'} at ${id.builtAt ?? 'unknown time'}`;
}
