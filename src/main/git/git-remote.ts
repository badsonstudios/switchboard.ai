// Branch and sync (E24 Git v2 item 15, §5.7) — fetch, pull, push, checkout, branch.
//
// ⚠️ **THE ONLY COMMANDS IN THIS SERVICE THAT TOUCH THE NETWORK, and the failure
// mode that matters is not an error — it is a HANG.** `git fetch` against a
// remote that wants credentials will sit waiting for a password on a terminal
// that does not exist, for ever, and our budget would then kill it and report a
// timeout: a bug that reads as "the network is slow".
//
// **`GIT_TERMINAL_PROMPT=0` is what prevents that**, and it is measured: against
// an unreachable host it fails in under a second with *"Could not resolve host"*
// rather than blocking. ⚠️ **AND IT IS DELIBERATELY NOT `GIT_ASKPASS`** — the
// user's own credential helper (Windows Credential Manager, the macOS keychain,
// a `gh` helper) must go on working exactly as it does outside switchboard. That
// is host-don't-reimplement: we stop git asking a *terminal we do not have*, and
// we do not touch how the user has arranged to be authenticated.
//
// WHAT ELSE WAS MEASURED, because each one changes what the surface may claim:
//
//  * **`fetch` with no remote configured exits 0 and says nothing.** So "nothing
//    happened" is a SUCCESS here, and a surface that reported it as a failure
//    would be wrong about an ordinary local-only repository.
//  * **`push` with no upstream exits 128** with *"No configured push
//    destination"* — a clear message, which is why it is passed through rather
//    than replaced.
//  * **`checkout` carries an uncommitted modification across** when it can, and
//    refuses only when the switch would clobber it. So it is not the destructive
//    operation it looks like, and needs no confirm of its own — git's refusal is
//    the protection, and quoting it is the job.
import type { GitWriteResult } from './git-write';

/**
 * How long a network command gets.
 *
 * ⚠️ **FAR LONGER THAN ANY LOCAL WRITE, because the bound is somebody else's
 * server.** A `pull` on a large repository over a slow link is legitimately slow,
 * and a budget tuned for `git add` would kill it and call the repository broken.
 * Still bounded: a remote that accepts the connection and then stops talking must
 * not become a surface that never answers.
 */
export const NETWORK_BUDGET_MS = 180_000;

/**
 * The environment a network command runs in.
 *
 * One variable, and the comment at the top of this file is the argument for why
 * it is exactly one.
 */
export function networkEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...base, GIT_TERMINAL_PROMPT: '0' };
}

/**
 * Is this a branch name git will accept, and that cannot be anything else?
 *
 * ⚠️ **DELIBERATELY NARROWER THAN `git check-ref-format`, and the reason is argv
 * rather than git.** A name reaching a command line must not be able to become a
 * FLAG, so a leading `-` is refused outright even though git permits it inside a
 * name; and `..` is refused because it would turn one ref into a RANGE. The same
 * two rules `safeRevs` carries in `git-log.ts`, for the same reason, and the same
 * finding behind them: a character class alone accepted `--all`.
 */
const BRANCH_RE = /^[A-Za-z0-9_./-]+$/;

export function isBranchName(raw: unknown): raw is string {
  if (typeof raw !== 'string' || raw === '' || raw.length > 255) return false;
  if (!BRANCH_RE.test(raw)) return false;
  if (raw.startsWith('-')) return false;
  if (raw.includes('..')) return false;
  // git's own refusals, kept because a name that cannot exist is better refused
  // here than as a `fatal:` the user has to decode.
  if (raw.endsWith('/') || raw.endsWith('.') || raw.endsWith('.lock')) return false;
  if (raw.startsWith('/') || raw.includes('//')) return false;
  return true;
}

export function refusedBranch(): GitWriteResult {
  return {
    ok: false,
    applied: 0,
    reason:
      'that is not a branch name switchboard will use — letters, digits, and ' +
      '. _ / - only, and not starting with a dash',
  };
}

/** Bring the remote's refs up to date without touching the working tree. */
export function fetchArgs(): string[] {
  // `--prune` so a branch deleted on the remote stops appearing in the graph.
  // Without it the History tab's ref chips accumulate names nobody can push to,
  // which is a confidently wrong answer about where a branch is.
  return ['fetch', '--prune'];
}

/**
 * Bring the remote's commits INTO this branch.
 *
 * ⚠️ **`--ff-only`, AND THAT IS THE WHOLE DESIGN OF THIS BUTTON.** A plain `pull`
 * either merges or rebases depending on the user's config, and both can stop
 * halfway with a conflict — which would leave switchboard's one-click "Pull"
 * having started a merge the user now has to finish, with no surface for it. With
 * `--ff-only` the button either works completely or changes nothing at all, and
 * git says which: *"Not possible to fast-forward"*. That refusal is useful
 * information; a half-finished merge is not.
 */
export function pullArgs(): string[] {
  return ['pull', '--ff-only'];
}

/**
 * Send this branch to the remote.
 *
 * `setUpstream` is for a branch that has never been pushed — git refuses
 * otherwise with *"The current branch has no upstream branch"*, and the fix it
 * suggests is exactly this flag.
 *
 * ⚠️ **NO `--force`, NOT EVEN BEHIND A MENU.** A force-push can destroy commits
 * on the remote that exist nowhere else, which puts it past the line this epic
 * draws at discard — and unlike discard there is no confirm that makes it safe,
 * because what is at risk may be somebody else's work. The terminal is where that
 * belongs.
 */
export function pushArgs(opts: { setUpstream?: boolean } = {}): string[] {
  return opts.setUpstream ? ['push', '--set-upstream', 'origin', 'HEAD'] : ['push'];
}

/** Switch branches. */
export function checkoutArgs(branch: string): string[] {
  // `--` so a branch name can never be read as a pathspec, which is the one way
  // `checkout` can quietly do something entirely different from what was asked.
  return ['checkout', branch, '--'];
}

/**
 * Make a branch and switch to it.
 *
 * `from` is a commit the History tab's graph pointed at — the design record's
 * *"create branch from the graph"*. Absent, it branches from HEAD.
 */
export function createBranchArgs(name: string, from?: string): string[] {
  return from ? ['checkout', '-b', name, from, '--'] : ['checkout', '-b', name, '--'];
}
