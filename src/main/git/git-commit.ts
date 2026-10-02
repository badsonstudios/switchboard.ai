// Making a commit (E24 Git v2 item 13, §5.7) — screen 1's commit box.
//
// ⚠️ **ONE COMMIT PATH, NOT TWO, AND THE DESIGN RECORD CALLS THAT "E24's OWN
// RULE".** Amend, sign-off and no-verify are MODIFIERS of the one path, reached
// behind a ⋯ — never a second primary button. Two buttons that both commit is how
// a user ends up amending by accident, and an amend rewrites history.
//
// ⚠️ **THE MESSAGE TRAVELS ON STDIN (`commit --file=-`), NEVER `-m`**, and the
// design record (§2.1) states why: *"a multi-line body with quotes in it is a
// Windows quoting bug waiting to happen."* Measured through this exact path — a
// body containing `"` double quotes, a `$`, a `%` and several lines arrives
// byte-exact in `%B`.
//
// ⚠️⚠️ **AND A COMMIT RUNS THE USER'S HOOKS, which is a deliberate relaxation of
// the #776 guard and the biggest decision in this item.** `guardArgs({ hooks:
// 'allow' })` carries the argument; the short version is that a guard which
// exists because we read UNBIDDEN does not apply to a button the user pressed,
// and a commit that silently skipped their `pre-commit` would be switchboard
// reimplementing `git commit` — the one thing the hard constraints forbid.
import { type GitWriteResult, refused } from './git-write';

/** What the user asked for, beyond the message. */
export interface CommitOptions {
  /**
   * Rewrite the last commit instead of making a new one.
   *
   * ⚠️ **BEHIND THE ⋯ AND NEVER THE DEFAULT**, because it REWRITES HISTORY: if
   * the commit has been pushed, the next push needs a force. Measured: `--amend
   * --file=-` works, and amending with NOTHING staged succeeds — it just replaces
   * the message, which is the commonest reason to reach for it.
   */
  amend?: boolean;
  /** add a `Signed-off-by` trailer — measured through stdin, git appends it */
  signoff?: boolean;
  /**
   * Skip the hooks.
   *
   * ⚠️ **THIS OPTION IS ONLY MEANINGFUL BECAUSE HOOKS OTHERWISE RUN**, and that
   * is the clearest argument for the hooks relaxation above: the design record
   * asked for `--no-verify` as a user choice, and a build where hooks never ran
   * would be offering to skip something that never happened.
   */
  noVerify?: boolean;
}

/**
 * The argv for one commit.
 *
 * `--file=-` is always there, because the message is always on stdin. `--cleanup`
 * is deliberately NOT set: git's default (`strip` for a message that did not come
 * from an editor) removes trailing whitespace and comment lines, which is what a
 * user typing into a box expects, and overriding it would be this surface having
 * an opinion git already has.
 */
export function commitArgs(opts: CommitOptions = {}): string[] {
  const args = ['commit', '--file=-'];
  if (opts.amend) args.push('--amend');
  if (opts.signoff) args.push('--signoff');
  if (opts.noVerify) args.push('--no-verify');
  return args;
}

/**
 * How long a commit may take.
 *
 * ⚠️ **LONGER THAN ANY OTHER WRITE, AND THE HOOKS ARE THE WHOLE REASON.** A
 * `pre-commit` that runs a formatter over a large change, or a test suite, is an
 * ordinary thing for a repository to have — and since this item deliberately lets
 * those hooks run, the budget has to allow for them. Two minutes is far past
 * anything typical and still bounded, because a hook that hangs must not become a
 * surface that never answers.
 */
export const COMMIT_BUDGET_MS = 120_000;

/**
 * Is this a message git will accept?
 *
 * ⚠️ **GIT REFUSES AN EMPTY MESSAGE ITSELF** — measured: *"Aborting commit due to
 * empty commit message"*, exit 1. So this is not the only line of defence and is
 * not trying to be; it exists so the BUTTON can be disabled rather than live and
 * then failing, which is the difference between a surface that tells you the rule
 * and one that lets you break it and then complains.
 *
 * Whitespace-only counts as empty for the same reason git thinks so: `--cleanup`
 * strips it, leaving nothing.
 */
export function isCommittableMessage(raw: unknown): raw is string {
  return typeof raw === 'string' && raw.trim() !== '';
}

/** The refusal for a message we will not even try. */
export function emptyMessageRefusal(): GitWriteResult {
  return refused('a commit needs a message');
}

/**
 * What came back from a commit attempt that git rejected.
 *
 * ⚠️ **GIT'S OWN FIRST LINE, AND FOR A COMMIT THAT IS NOT A STYLE CHOICE — IT IS
 * THE ONLY USEFUL THING TO SAY.** The commonest failures here are a `pre-commit`
 * hook's own output and *"no changes added to commit"*, and both are messages the
 * user has to read to act on. A sentence of ours in their place would be
 * switchboard claiming to know why a hook somebody else wrote said no.
 *
 * The LAST non-empty line, not the first: a hook prints its own report and git
 * appends its verdict after it, so the first line is a formatter's banner while
 * the last is the reason the commit did not happen.
 */
export function commitRefusal(stderr: string, stdout: string): string {
  const lines = `${stderr}\n${stdout}`
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');
  return lines[lines.length - 1] ?? 'git refused the commit and said nothing switchboard could pass on';
}
