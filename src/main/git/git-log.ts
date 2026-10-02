// `git log`, as a COMMAND SHAPE and a PURE PARSER (E24 Git v2 item 1, §5.7).
//
// Split out of `git-service.ts` on purpose: everything here is a pure function
// over bytes, so the hard part — the framing — is tested against fixture bytes
// rather than against whatever history the test repository happens to have. The
// service's own suite then only has to prove that real git produces bytes of
// this shape.
//
// ⚠️ **THE HISTORY TAB SHIPPED IN TWO DOCUMENTS AND IN NO CODE.** `docs/DESIGN.md`
// §5.7's as-built note and `docs/plans/06-phase-3-ide.md`'s E24 both claimed the
// History tab's read-only log had shipped; `GitService` was `root`/`status`/
// `diff`/`fileVersions` and the tab was `enabled: () => false`. The owner found
// it by opening the app. This file is the first line of the thing those
// documents described.
//
// THE FORMAT IS COPIED, NOT INVENTED. It is VS Code's own, read off
// `resources/app/extensions/git/dist/main.js` — see
// `docs/reference-implementations.md` §4, which this item added. The reason to
// copy rather than derive is the framing: a commit body contains newlines, so
// records cannot be separated by one, and `-z` is the only separator a commit
// message cannot contain (measured below).

import { EMPTY_TREE } from './repo-config-guard';

/** Where a `%D` decoration came from. */
export type GitRefKind = 'head' | 'branch' | 'remote' | 'tag' | 'other';

export interface GitRef {
  kind: GitRefKind;
  /** the name to draw: `main`, `origin/main`, `v1.2.0` */
  name: string;
  /** the full refname git gave us, for a consumer that needs to be exact */
  full: string;
  /** this ref is where `HEAD` points — the checked-out branch */
  isHead?: boolean;
}

/** `--shortstat`'s three numbers, or `null` when git printed none. */
export interface GitCommitStats {
  files: number;
  insertions: number;
  deletions: number;
}

/**
 * One commit.
 *
 * ⚠️ **THE FIELD NAMES ARE VS CODE'S `provideHistoryItems` MODEL, DELIBERATELY**
 * (design record §2.1). Not for compatibility — nothing is shared — but because
 * that shape is already known to be exactly what a lane renderer needs, and
 * item 3's allocator consumes `parentIds` directly. Inventing our own names
 * here would have meant discovering the same set one field at a time.
 */
export interface GitCommit {
  /** full 40-hex sha */
  id: string;
  /** full shas of every parent: 0 for a root commit, 2+ for a merge */
  parentIds: string[];
  /** the abbreviated sha a human reads */
  displayId: string;
  /** first line of the message */
  subject: string;
  /** the whole message, trailing newlines trimmed */
  message: string;
  author: string;
  authorEmail: string;
  /**
   * Author date, seconds since epoch (`%at`) — or `null` when git printed none.
   *
   * ⚠️ **`null` AND NOT `0`, BECAUSE `Number('') === 0` AND THAT IS 1 JANUARY
   * 1970 (found in review, measured).** A commit object with an out-of-range
   * author date — writable with `hash-object -t commit -w --literally`, and
   * produced by tools that are not git — makes git print `%at` as an EMPTY LINE.
   * The obvious `Number(field)` turns that into zero, which is a real-looking
   * date, so the row drew `1970-01-01` with a matching tooltip: a confident wrong
   * fact about the user's project, in the tab built to stop making those. A
   * `NaN` guard does not catch it, because there is no `NaN`.
   */
  timestamp: number | null;
  /** commit date, seconds since epoch (`%ct`) — differs after a rebase */
  committedTimestamp: number | null;
  /**
   * `--shortstat`'s numbers, or `null`.
   *
   * ⚠️ **`null` IS A REAL ANSWER, NOT A PARSE FAILURE (measured).** An empty
   * commit — `git commit --allow-empty`, which is what a `--allow-empty`
   * checkpoint or a signed-off release tag commit often is — makes git print no
   * shortstat line at all, so the NUL is followed immediately by the next
   * commit's sha. A parser that assumed the line was always there consumed the
   * next record's first field as a statistic and then failed to find a sha
   * where one plainly was. Rendering it as `0 files` would also be a lie of its
   * own: "git said nothing" and "git said zero" are different, and only one of
   * them is reachable.
   */
  stats: GitCommitStats | null;
  references: GitRef[];
}

/**
 * The format string, and it is load-bearing in two ways.
 *
 * **`%B` IS LAST BECAUSE IT IS THE ONLY MULTI-LINE FIELD.** git refuses a
 * newline in an author name or an email, and `%D` cannot contain one, so every
 * field before the body is exactly one line. That is what makes "split the first
 * seven lines off, the rest is the body" a correct parse rather than a hopeful
 * one.
 *
 * **BOTH DATES, NOT ONE.** `%at` is when the work was done and `%ct` is when
 * this commit object was written; a rebase, a cherry-pick or an amend moves the
 * second and not the first. A graph ordered by one and labelled with the other
 * is the classic "these commits are out of order" bug report.
 *
 * ⚠️ **`%aN` AND `%aE` ARE REPOSITORY-SUPPLIED VALUES, NOT FACTS (measured, found
 * in review).** The capitals mean "after `.mailmap`" — and `.mailmap` is an
 * ordinary file in the working tree that an edit-only agent can write. Measured:
 * one line of it turned `A <a@a>` into `Spoofed Name <spoof@evil.test>` while
 * `%an`/`%ae` stayed truthful. Kept anyway, because mailmap exists for a real
 * reason and every other git GUI honours it — but the History tab is RENDERING
 * this, so it is a display name a project chose and not an identity we are
 * vouching for. If a surface is ever built that makes a decision about who an
 * author is, it wants the lowercase pair.
 */
export const LOG_FORMAT = '--format=%H%n%aN%n%aE%n%at%n%ct%n%P%n%D%n%B';

/**
 * The flags that come after the format, in the order VS Code uses them.
 *
 * - **`-z`** NUL-frames the records. The whole reason this parser works: a
 *   commit body may contain newlines — *this repository's bodies are nothing
 *   but newlines* — and a NUL is the one byte a commit message cannot hold.
 *   **Measured (E24 item 1):** `git commit-tree -F -` with a NUL in the message
 *   is refused outright — *"error: a NUL byte in commit log message not
 *   allowed."* So the frame cannot be forged from inside a repository, which
 *   matters because #776's threat model has another agent writing this one.
 *   The parser is still defensive about it; see `parseLog`.
 * - **`--shortstat`** and **`--diff-merges=first-parent`** are in `STATS_FLAGS`,
 *   not here, because they cost 95% of the query — see that constant for the
 *   numbers. Two things about them belong with the framing, though:
 *
 *   `--shortstat` output trails **after** the NUL, so it arrives at the head of
 *   the *next* chunk and belongs to the *previous* commit. Measured byte layout:
 *   `<fields>\0\n<shortstat>\n<next sha>` — and, for an empty commit,
 *   `<fields>\0<next sha>` with no line at all.
 *
 *   ⚠️ **`--diff-merges=first-parent` HAS A SECOND EFFECT NOBODY ASKS FOR: IT
 *   UN-SIMPLIFIES A PATH-FILTERED LOG (measured).** `git log -- s.txt` lists only
 *   the commit that created the file; add this flag and the merge that brought it
 *   to this branch is listed too. That is history simplification being switched
 *   off, not a diff-format change. Kept deliberately — an "evil merge" that
 *   really did change a file during conflict resolution must not be invisible —
 *   and pinned by a test, so item 10 inherits the fact rather than rediscovering
 *   it when a per-file timeline shows the same change twice.
 * - **`--decorate=full`** spells refs as `refs/heads/main`, `refs/tags/v1`,
 *   `refs/remotes/origin/main`. The short form is ambiguous — a tag and a branch
 *   can share a name, and the History tab draws them as different chips — so the
 *   full form is what lets `parseRefs` answer the question at all.
 * - **`--topo-order`** so a branch's commits stay contiguous. Date order
 *   interleaves two branches by timestamp, which is correct as a list and wrong
 *   as a graph: item 3's lane allocator is a topological walk and would have to
 *   re-sort its input.
 * - ⚠️ **`--no-show-signature` IS A #776 SECURITY FLAG, AND IT IS THE FIRST HOLE
 *   OF THAT CLASS THIS COMMAND OPENED (found in review, measured).** The #776
 *   probes covered `diff.external`, `textconv` and `filter.<n>.clean`, all of
 *   which `--shortstat` was measured not to reach — and all of which are about
 *   reading a BLOB. `log` is the first command in this service that reads COMMIT
 *   objects, and a commit object can carry a `gpgsig` header. Two repo-local
 *   config keys, both inside #776's threat model, then make git launch a program
 *   of the repository's choosing:
 *
 *   ```
 *   [log] showSignature = true      # in .git/config
 *   [gpg] program = <anything>      # ditto; gpg.ssh.program / gpg.<fmt>.program too
 *   ```
 *
 *   Measured: **one spawn per signed commit** — so up to `MAX_LOG_LIMIT` of them
 *   — and `git log` **exits 0 with stdout that parses perfectly**, so nothing in
 *   the answer records that it happened. Completely silent. Neither `guardArgs()`
 *   (fsmonitor + hooksPath) nor `guardEnv()` (filter drivers) closes it, so
 *   *paying* the config guard would not have helped either. A forged commit object
 *   with a `gpgsig` header needs no gpg to create (`git hash-object -t commit -w`),
 *   so this does not even require a real signature. git ≥ 2.10, well below the
 *   2.25.1 floor this file already works to.
 * - ⚠️ **`--encoding=UTF-8` STOPS THE REPOSITORY RE-FRAMING THE WHOLE STREAM
 *   (found in review, measured).** The `-z` note above says a NUL cannot be
 *   forged from inside a repository. That is true of the *message* and NOT of the
 *   *stream*: repo-local `i18n.logOutputEncoding = UTF-16LE` re-encodes
 *   everything git writes, and measured with `od -c`, every byte then has a `\0`
 *   after it. Fed that, the parser finds no record anywhere, git exits 0, and the
 *   History tab would have drawn **"this project has no commits yet"** for a
 *   repository with a thousand of them. `--encoding=UTF-8` overrides the config
 *   (measured) and, as a bonus, normalises a commit that carries its own
 *   non-UTF-8 `encoding` header instead of handing us mojibake. `log()` carries a
 *   second belt for the same class: non-empty output that parses to zero commits
 *   is reported as unreadable, not as an empty history.
 * - **`--no-color` / `--no-textconv` / `--no-ext-diff`** are **belt and braces
 *   here, not load-bearing, and that is measured.** With
 *   `diff.external = sh -c "echo PWNED"`, with a `.gitattributes`-selected
 *   `textconv` driver, and with a `filter.<n>.clean`, **none of the three ran
 *   under `--shortstat`** — it uses git's internal diffstat machinery and never
 *   materialises a blob through a driver. They are passed anyway because the day
 *   somebody adds `-p` or `--numstat` to this command they become load-bearing
 *   instantly, and because `diff()` learned that lesson the expensive way
 *   (#764: `--no-textconv` does not stop `diff.external`; `--no-ext-diff` does).
 */
const LOG_FLAGS = [
  '-z',
  '--decorate=full',
  '--topo-order',
  '--encoding=UTF-8',
  '--no-show-signature',
  '--no-color',
  '--no-textconv',
  '--no-ext-diff',
];

/**
 * The two flags that produce the per-commit numbers — **and they are switchable,
 * because they are 95% of the cost.**
 *
 * ⚠️ **MEASURED ON THIS REPOSITORY (941 commits, essay-length bodies, Windows
 * 11 with Defender), and it is not a rounding error:**
 *
 * | query | wall time |
 * |---|---|
 * | 100 commits **with** `--shortstat` | **1,331 ms** |
 * | 100 commits **without** it | **64 ms** |
 * | every commit (941) with it | 2,858 ms |
 * | a bare `git --version`, for the spawn floor | 38 ms |
 *
 * So the stats cost about **13 ms per commit** — git diffs every listed commit
 * against its first parent to get them — and the metadata itself is nearly free.
 * That is the whole reason `DEFAULT_LOG_LIMIT` is 50 rather than a few hundred,
 * and the reason this is a query option rather than part of `LOG_FLAGS`: a
 * surface that only needs subjects and refs (the graph, a ref picker, a "which
 * commits are unpushed" count) should not pay a second and a half for numbers it
 * will not draw.
 *
 * `--diff-merges=first-parent` belongs with `--shortstat` and not in the base
 * flags, because without a diff being computed there is nothing for it to
 * format — and because its side effect on path filtering (see below) should not
 * apply to a query that asked for no stats at all.
 */
const STATS_FLAGS = ['--shortstat', '--diff-merges=first-parent'];

export interface GitLogQuery {
  /** how many commits to ask for */
  limit?: number;
  /** how many to skip — paging, for the History tab's "load more" */
  skip?: number;
  /**
   * Which refs to walk. Empty means `HEAD`, i.e. the current branch.
   *
   * ⚠️ **EVERY ENTRY IS VALIDATED, AND A BAD ONE DROPS THE WHOLE QUERY TO
   * `HEAD`** — see `safeRevs`. A ref name is not a safe thing to put in argv.
   */
  refs?: string[];
  /** one path to follow, for item 10's per-file history */
  path?: string;
  /** follow renames — only meaningful with `path` */
  follow?: boolean;
  /**
   * Ask for the per-commit `+/−` numbers. **Default `true`, and it is the
   * expensive half of the query** — ~13 ms per commit, measured; see
   * `STATS_FLAGS`. Pass `false` from a surface that draws subjects and refs and
   * no numbers.
   */
  stats?: boolean;
}

/**
 * How many commits a query asks for when it does not say.
 *
 * **FIFTY, AND THE NUMBER IS MEASURED RATHER THAN CHOSEN FOR LOOKS.** At the
 * ~13 ms per commit `--shortstat` costs, a hundred is 1.3 s of a spinner on a tab
 * the user just clicked and two hundred is nearly three seconds. Fifty rows fill
 * the pane, cost about 650 ms, and the History tab pages with `skip` for the
 * rest — which is what `skip` is for.
 */
export const DEFAULT_LOG_LIMIT = 50;

/**
 * The hard ceiling on one query, whatever the caller asks for.
 *
 * Bounds the BYTES, which is the thing `MAX_GIT_OUTPUT` (32 MB) would otherwise
 * bound by killing the read. A commit message in this repository runs to
 * kilobytes — the close-out commits are essays — so 2,000 of them is a plausible
 * several megabytes, and that is already far past what any surface shows at
 * once. The History tab pages with `skip`.
 */
export const MAX_LOG_LIMIT = 2_000;

/**
 * Build the argv.
 *
 * ⚠️ **PATHS GO AFTER `--`, REVS GO BEFORE IT, AND NEITHER IS PASSED
 * UNVALIDATED.** `git log` reads a leading `-` as a flag, and a caller-supplied
 * ref or path reaching argv as a flag is the shape of every argument-injection
 * bug. `--end-of-options` would also close the ref half; the validation below is
 * preferred because refusing a nonsense ref outright is a better answer than
 * passing it through and letting git produce a confusing error about it.
 *
 * ⚠️ **AND `--` DOES NOT CONTAIN THE PATH — THE FIRST VERSION OF THIS COMMENT
 * CLAIMED IT DID (found in review, measured).** Two things get through a `--`:
 *
 * - **`..` escapes the session folder.** git resolves a pathspec against the
 *   cwd, not against the repository root, so in a monorepo session whose folder
 *   is `<repo>/sub` — an ordinary shape here — `-- ../secret.txt` lists the
 *   commits touching a file the session was never scoped to. `git:fileVersions`
 *   has guarded exactly this since it shipped; this channel did not.
 * - **Pathspec magic.** `:(exclude)src/**` and `:!src` are read as magic after
 *   the `--`, so a caller could silently ask a different question than the one
 *   it looks like. Wrong answers rather than a leak, but a surface whose whole
 *   job is being trustworthy about a repository should not have that gap.
 *
 * So `safePath` refuses both, and refuses an absolute path for the same reason
 * it refuses `..`.
 */
export function logArgs(query: GitLogQuery = {}): string[] {
  const limit = clampLimit(query.limit);
  // The SUBCOMMAND is part of this list, the way `CONFIG_LIST_SCOPED` carries
  // `config`. `GitService.run` prepends only the guards, so a caller that had to
  // remember to say `log` itself would be a caller that could forget.
  const args = ['log', ...LOG_FLAGS, LOG_FORMAT, `--max-count=${limit}`];
  if (query.stats !== false) args.push(...STATS_FLAGS);
  const skip = clampSkip(query.skip);
  if (skip > 0) args.push(`--skip=${skip}`);
  const pathspec = safePath(query.path);
  if (query.follow && pathspec) args.push('--follow');
  args.push(...safeRevs(query.refs));
  // `--` ALWAYS, even with no path. It is what stops a rev that happens to name
  // an existing file from being read as a pathspec, which git calls ambiguous
  // and refuses — and refusing to list a branch because somebody has a file of
  // the same name is the kind of answer this codebase files tickets about.
  args.push('--');
  if (pathspec) args.push(pathspec);
  return args;
}

function clampLimit(limit: number | undefined): number {
  const n = Math.floor(limit ?? DEFAULT_LOG_LIMIT);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LOG_LIMIT;
  return Math.min(n, MAX_LOG_LIMIT);
}

/**
 * How many commits to skip, clamped the same way the limit is.
 *
 * ⚠️ **`Number.isFinite` IS NOT ENOUGH, AND THE REASON IS STRING FORMATTING
 * (found in review, measured).** `1e21` is finite, so the old guard passed it
 * through and template interpolation spelled it **`--skip=1e+21`** — which git
 * refuses, surfacing to the user as an unreadable history for a query that was
 * merely silly. `isSafeInteger` plus a ceiling keeps it a number git can read. The
 * ceiling is the same `MAX_LOG_LIMIT`-scaled one the limit uses: a skip past the
 * end of any real history returns nothing, which is the honest answer.
 */
function clampSkip(skip: number | undefined): number {
  const n = Math.floor(skip ?? 0);
  if (!Number.isFinite(n) || n <= 0) return 0;
  // CLAMPED, not dropped. A skip that falls back to 0 answers a different
  // question — the tab's "load more" would re-serve the first page and the user
  // sees the same rows twice. The ceiling answers the question honestly: nothing,
  // because there is nothing that far back.
  if (!Number.isSafeInteger(n)) return MAX_SKIP;
  return Math.min(n, MAX_SKIP);
}

/** A skip no real history reaches, and one `--skip=` can always spell. */
const MAX_SKIP = 1_000_000;

/**
 * The pathspec, or `undefined` when the caller's path is not one we will pass.
 *
 * ⚠️ **THREE REFUSALS, ALL THREE MEASURED (found in review).** `--` separates
 * revs from paths and it does NOT confine the path:
 *
 * - **`..`** escapes the session folder, because git resolves a pathspec against
 *   the cwd. Measured: in `<repo>/sub`, `-- ../secret.txt` happily lists the
 *   commits that touched a file outside the scope.
 * - **an absolute path** reaches anywhere in the repository for the same reason,
 *   and on Windows it can be spelled `C:/…` as well as `/…`.
 * - **a leading `:`** is pathspec MAGIC — `:(exclude)src/**`, `:!src` — read as
 *   magic even after the `--`. Measured. Wrong answers rather than a leak, but a
 *   surface whose job is being trustworthy about a repository should not have the
 *   gap.
 *
 * `undefined` rather than a throw: the caller gets the unfiltered history, which
 * is a wider answer and never a wrong one. Nothing user-reachable produces these
 * shapes — the paths come from `status()` and from the log itself — so a refusal
 * here means a bug or an attack, and in both cases the unfiltered list is the safe
 * side to fail to.
 */
function safePath(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const p = toGitPath(raw);
  if (p === '' || p.startsWith(':')) return undefined;
  // Absolute in either spelling: POSIX root, a UNC share, or a drive letter.
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) return undefined;
  if (p.split('/').includes('..')) return undefined;
  return p;
}

/**
 * The revs to walk, or `['HEAD']`.
 *
 * ⚠️ **ONE BAD ENTRY DROPS THE WHOLE LIST, RATHER THAN BEING FILTERED OUT.** A
 * filtered list is a quietly different question — "show me these five branches"
 * answered with four of them, and the graph then draws a history with a branch
 * missing and no indication that anything was dropped. A confident wrong answer,
 * which is the failure mode this service keeps being corrected for. Falling back
 * to `HEAD` is wrong too, but it is *visibly* wrong: one lane where five were
 * expected.
 *
 * The pattern is deliberately narrower than `git check-ref-format`: no leading
 * `-` (the injection), no `..` (which would turn one rev into a range), no
 * whitespace, no `~^:?*[\` or control characters. `@` and `/` are allowed
 * because `@{u}` and `origin/main` are the two most useful things to ask for.
 */
function safeRevs(refs: readonly string[] | undefined): string[] {
  if (!refs || refs.length === 0) return ['HEAD'];
  const ok = refs.every((r) => SAFE_REV.test(r) && !r.startsWith('-') && !r.includes('..'));
  return ok ? [...refs] : ['HEAD'];
}

/**
 * ⚠️ **A LEADING `-` IS CHECKED SEPARATELY, AND THE FIRST VERSION OF THIS GOT IT
 * WRONG.** `-` has to be IN the class — `feature/e24-git-v2` is an ordinary
 * branch name — so the class alone accepted `--all`, which is a flag, not a ref.
 * A test written for the injection is what caught it. The two rules are
 * separate because they are different facts: which characters a refname may
 * contain, and which position a `-` may not occupy.
 */
const SAFE_REV = /^[A-Za-z0-9_@/{}.+-]+$/;

function toGitPath(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * Parse the whole of `git log`'s stdout.
 *
 * **THE FRAMING, MEASURED (git 2.51.0.windows.2), because it is not what the
 * flag names suggest.** `--shortstat` output lands AFTER the record's NUL:
 *
 *     <sha>\n<author>\n<email>\n<at>\n<ct>\n<parents>\n<refs>\n<body>\0
 *     \n 3 files changed, 9 insertions(+), 1 deletion(-)\n
 *     <sha>\n…
 *
 * So splitting on NUL gives chunks where chunk *n* holds commit *n*'s fields
 * with commit *n−1*'s statistics glued to the front. The statistics are
 * therefore attributed BACKWARDS, and the line is OPTIONAL — an empty commit has
 * none, and then the NUL abuts the next sha directly.
 *
 * ⚠️ **A CHUNK THAT IS NOT A RECORD IS SKIPPED, NOT THROWN ON.** The measurement
 * above says a NUL cannot be forged from inside a commit message (git refuses to
 * write one), so a malformed chunk should be unreachable — but "should be
 * unreachable" is how every entry in this file's `⚠️` list started, and the
 * consumer is a pane that must not blank out because one commit in two thousand
 * surprised us. Fail open: return the commits we could read.
 */
export function parseLog(out: string): GitCommit[] {
  const commits: GitCommit[] = [];
  /**
   * Did the chunk immediately before this one yield a commit?
   *
   * ⚠️ **NOT the same question as "is `commits` non-empty" (found in review,
   * measured).** The diffstat at the head of a chunk belongs to the PREVIOUS
   * CHUNK's commit — so if that chunk was skipped, the numbers are orphans.
   * Attaching them to `commits[commits.length - 1]` instead OVERWRITES a commit
   * whose numbers were already right: measured, a commit that legitimately
   * changed one file reported `99 files changed` inherited from a dropped
   * record. A confident wrong number, which is the exact failure class this file
   * is written against, introduced by the recovery path for another one.
   */
  let previousChunkWasCommit = false;
  for (const raw of out.split('\0')) {
    let chunk = raw;
    if (chunk.startsWith('\n')) {
      const trailing = takeShortstat(chunk);
      if (trailing) {
        if (previousChunkWasCommit) commits[commits.length - 1].stats = trailing.stats;
        chunk = trailing.rest;
      } else {
        // A leading newline that is NOT a diffstat. `parseRecord` recovers from a
        // junk prefix by finding the first sha-shaped line, so the chunk is handed
        // over as it is — losing a statistic is cheap, and losing the commit would
        // contradict what this function promises two paragraphs up.
        chunk = chunk.slice(1);
      }
    }
    const commit = parseRecord(chunk);
    if (commit) commits.push(commit);
    previousChunkWasCommit = commit !== null;
  }
  return commits;
}

/**
 * Split a leading `\n<shortstat>\n` off a chunk, if there is one.
 *
 * The leading newline is part of the shape and is checked for: a chunk that
 * starts with a sha starts with a hex digit, so the newline alone separates
 * "this chunk begins with the previous commit's statistics" from "this chunk
 * begins with a commit".
 */
function takeShortstat(chunk: string): { stats: GitCommitStats; rest: string } | null {
  if (!chunk.startsWith('\n')) return null;
  const end = chunk.indexOf('\n', 1);
  const line = end === -1 ? chunk.slice(1) : chunk.slice(1, end);
  const stats = parseShortstat(line);
  if (!stats) return null;
  return { stats, rest: end === -1 ? '' : chunk.slice(end + 1) };
}

/**
 * ` 3 files changed, 9 insertions(+), 1 deletion(-)` → the three numbers.
 *
 * **INSERTIONS AND DELETIONS ARE BOTH OPTIONAL AND THE SINGULARS ARE REAL.** git
 * writes `1 file changed, 1 insertion(+)` with no deletions clause at all, and a
 * pure-deletion commit has no insertions clause. A regex that required both
 * matched nothing on a one-line change, which is the most common commit there
 * is — so the absent clause reads as zero, which is what git means by leaving it
 * out.
 *
 * ⚠️ **ANCHORED AT THE START, because a commit message ends up next to this.**
 * Searching for the phrase anywhere would let a body ending in
 * `…so 2 files changed, 1 insertion(+)` be read as the previous commit's
 * statistics. It cannot reach position 0 of the chunk — `takeShortstat` only
 * looks at the first line after the NUL — but the anchor is what makes that true
 * rather than incidental.
 */
export function parseShortstat(line: string): GitCommitStats | null {
  const m = SHORTSTAT.exec(line);
  if (!m) return null;
  return {
    files: Number(m[1]),
    insertions: m[2] ? Number(m[2]) : 0,
    deletions: m[3] ? Number(m[3]) : 0,
  };
}

const SHORTSTAT =
  /^\s*(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?\s*$/;

/**
 * One record's seven fields plus its body, or `null` when the chunk is not one.
 *
 * Walked with `indexOf` rather than `split('\n')` with a count: the body is
 * everything after the seventh newline *including its newlines*, and a `split`
 * that was handed a limit would drop the rest of it.
 *
 * ⚠️ **A JUNK PREFIX IS SKIPPED TO THE FIRST SHA-SHAPED LINE.** Reached when
 * something arrives ahead of the record that is not a diffstat — a translated
 * one git wrote under a locale `git()` did not pin, or anything else unforeseen.
 * Without the skip the whole commit is lost, because field 0 becomes the junk and
 * fails the sha test. The search only runs when the chunk does NOT already start
 * with a sha, i.e. only when the chunk is already malformed, so a commit body
 * containing a bare 40-hex line can never be mistaken for a record boundary.
 */
function parseRecord(chunk: string): GitCommit | null {
  // A trailing empty chunk after the final NUL is the normal end of the stream,
  // not a malformed record.
  if (chunk === '') return null;
  const start = SHA_LINE.test(chunk) ? 0 : findShaLine(chunk);
  if (start === -1) return null;
  chunk = chunk.slice(start);
  const fields: string[] = [];
  let at = 0;
  for (let f = 0; f < FIELD_COUNT; f++) {
    const nl = chunk.indexOf('\n', at);
    if (nl === -1) return null;
    fields.push(chunk.slice(at, nl));
    at = nl + 1;
  }
  const [id, author, authorEmail, authored, committed, parents, decoration] = fields;
  if (!/^[0-9a-f]{40}$/.test(id)) return null;
  const body = chunk.slice(at);
  return {
    id,
    // `%P` is space-separated, and EMPTY for a root commit — `''.split(' ')` is
    // `['']`, a single empty parent, which would make the root commit look like
    // it had one. `filter` is what stops item 3's lane allocator drawing an edge
    // to nowhere and item 4's diff asking for `<empty>..<sha>`.
    parentIds: parents.split(' ').filter((p) => p !== ''),
    displayId: id.slice(0, SHORT_SHA),
    subject: firstLine(body),
    // Trailing whitespace off the end — `%B` ends with the newline git stores.
    // Leading whitespace is the author's own and is left alone.
    //
    // ⚠️ **`trimEnd()` AND NOT `/\s+$/`, AND THE DIFFERENCE IS 48 SECONDS OF
    // FROZEN APP (found in review, measured).** That regex backtracks once per
    // position inside a trailing whitespace run, so one commit message decides how
    // long the main process stops: 60,000 trailing spaces took 818 ms, 120,000
    // took 6.1 s and 240,000 took **48.3 s**, where `trimEnd()` is immeasurable.
    // And `LOG_BUDGET_MS` cannot save it — this runs in the Electron main process
    // AFTER git has already returned, with `MAX_GIT_OUTPUT` allowing 32 MB of
    // body. "Our breakage never blocks a session" is a hard constraint, and a
    // commit message is a thing a session writes.
    message: body.trimEnd(),
    author,
    authorEmail,
    timestamp: epochOrNull(authored),
    committedTimestamp: epochOrNull(committed),
    stats: null,
    references: parseRefs(decoration),
  };
}

/** %H %aN %aE %at %ct %P %D — seven lines before the body. */
const FIELD_COUNT = 7;

/** A chunk that begins with a record begins with a sha on its own line. */
const SHA_LINE = /^[0-9a-f]{40}\n/;

/**
 * Where the first sha-shaped line starts, or `-1`.
 *
 * A plain scan of line starts rather than a global regex: this is a recovery path
 * over caller-adjacent bytes, and a backtracking regex over a 32 MB body is how
 * the trailing-whitespace freeze happened.
 */
function findShaLine(chunk: string): number {
  let at = chunk.indexOf('\n');
  while (at !== -1) {
    const lineStart = at + 1;
    if (SHA_LINE.test(chunk.slice(lineStart, lineStart + 41))) return lineStart;
    at = chunk.indexOf('\n', lineStart);
  }
  return -1;
}

/**
 * How much of a sha a human reads.
 *
 * Eight rather than git's default seven: this repository is past 1,000 commits
 * and seven hex digits collide at a rate worth not thinking about. It is a
 * DISPLAY length only — `id` is always full, and every git call is made with the
 * full sha, so a collision here can never select the wrong commit.
 */
const SHORT_SHA = 8;

/**
 * A `%at` / `%ct` field as seconds since the epoch, or `null`.
 *
 * ⚠️ **THE EMPTY STRING IS THE CASE THIS EXISTS FOR** — see `GitCommit.timestamp`.
 * `Number('')` is `0`, not `NaN`, so the only guard that works is a positive
 * check. Also bounded to what `Date` can actually hold: a value past ±8.64e15 ms
 * makes `toISOString()` THROW, and a throw in a renderer row is eaten by the
 * contribution boundary and costs the whole tab. git will not emit one; the bound
 * is here because the alternative to a cheap clamp is a blank panel.
 */
function epochOrNull(field: string): number | null {
  const n = Number(field);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n * 1000 > MAX_DATE_MS ? null : n;
}

/** `Date`'s own range, past which `toISOString()` throws rather than returns. */
const MAX_DATE_MS = 8.64e15;

function firstLine(body: string): string {
  const nl = body.indexOf('\n');
  return (nl === -1 ? body : body.slice(0, nl)).trim();
}

/**
 * Parse `%D` under `--decorate=full`.
 *
 * The shape is a comma-separated list, with two special spellings:
 *
 * - `HEAD -> refs/heads/main` — the checked-out branch. The arrow is why this is
 *   not a plain split: the entry names two things.
 * - `tag: refs/tags/v1` — a tag, and the only entry that carries its kind in the
 *   text rather than in the refname.
 * - a bare `HEAD` — a detached HEAD, with no branch to point at.
 *
 * **WHY `--decorate=full` AND NOT THE SHORT FORM.** Short decoration gives
 * `main` and `v1` with nothing to tell a branch from a tag, and they can share a
 * name. The History tab draws them as different chips, so a parse that cannot
 * tell them apart would draw one of them wrong — silently, and only in the
 * repository that happens to have the collision.
 */
export function parseRefs(decoration: string): GitRef[] {
  const text = decoration.trim();
  if (text === '') return [];
  const refs: GitRef[] = [];
  for (const raw of text.split(',')) {
    const entry = raw.trim();
    if (entry === '') continue;
    const arrow = entry.indexOf(' -> ');
    if (arrow !== -1) {
      // `HEAD -> refs/heads/main`: one entry, two facts. The branch is what is
      // drawn; that it is current is a flag on it, not a second chip.
      const target = entry.slice(arrow + 4).trim();
      const ref = refFrom(target);
      if (ref) refs.push({ ...ref, isHead: true });
      continue;
    }
    if (entry === 'HEAD') {
      refs.push({ kind: 'head', name: 'HEAD', full: 'HEAD', isHead: true });
      continue;
    }
    const ref = refFrom(entry);
    if (ref) refs.push(ref);
  }
  return refs;
}

function refFrom(full: string): GitRef | null {
  // `tag: refs/tags/v1` — the prefix is git's, not part of the refname.
  const tagged = full.startsWith('tag: ');
  const name = tagged ? full.slice('tag: '.length).trim() : full;
  if (name === '') return null;
  for (const [prefix, kind] of REF_PREFIXES) {
    if (name.startsWith(prefix)) return { kind, name: name.slice(prefix.length), full: name };
  }
  // An unrecognised namespace — `refs/stash`, `refs/notes/commits`, a
  // `refs/pull/*` a forge wrote. Shown under its own name rather than dropped:
  // §5's fail-open rule is that we say what we found, and a ref we have no chip
  // for is still a true thing about this commit.
  return { kind: tagged ? 'tag' : 'other', name, full: name };
}

const REF_PREFIXES: [string, GitRefKind][] = [
  ['refs/heads/', 'branch'],
  ['refs/remotes/', 'remote'],
  ['refs/tags/', 'tag'],
];

/**
 * Is this thing off the wire a `GitLogQuery`?
 *
 * ⚠️ **IT LIVES HERE, NOT IN `main/index.ts`, BECAUSE THAT FILE HAS NO TESTS** —
 * it says so itself, and it is the reason every seam it owns is a thin call into
 * something that does. A guard whose job is to keep caller-controlled values out
 * of argv has to be the tested kind.
 *
 * Deliberately NOT a validator that reports what was wrong: an unrecognised shape
 * becomes `{}`, which asks for the default query. `logArgs` is the actual
 * boundary — it clamps the limit and validates the refs whatever reaches it — so
 * this only has to stop a wrong TYPE (a string where a number goes, an object
 * where a string goes) from being formatted into a flag.
 */
export function isLogQuery(value: unknown): value is GitLogQuery {
  if (value === null || typeof value !== 'object') return false;
  const q = value as Record<string, unknown>;
  if (q.limit !== undefined && typeof q.limit !== 'number') return false;
  if (q.skip !== undefined && typeof q.skip !== 'number') return false;
  if (q.path !== undefined && typeof q.path !== 'string') return false;
  if (q.follow !== undefined && typeof q.follow !== 'boolean') return false;
  if (q.stats !== undefined && typeof q.stats !== 'boolean') return false;
  if (q.refs !== undefined) {
    if (!Array.isArray(q.refs)) return false;
    if (!q.refs.every((r) => typeof r === 'string')) return false;
  }
  return true;
}

/**
 * Is this a revision we will put in argv?
 *
 * ⚠️ **THE SAME GUARD `safeRevs` APPLIES, AND FOR THE SAME REASON** — `git`
 * reads a leading `-` as a flag, and `..` turns one revision into a range. This
 * is the exported form, because item 4's channels take two revisions from the
 * renderer and a caller must not have to remember the rule.
 */
export function isRev(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    SAFE_REV.test(value) &&
    !value.startsWith('-') &&
    !value.includes('..')
  );
}

/**
 * Is this thing off the wire a commit reference — an id and its parents?
 *
 * ⚠️ **EVERY PARENT IS CHECKED, NOT JUST THE ID.** `diffBaseFor` reaches for
 * `parentIds[0]` and puts it in argv, so an unvalidated parent list is the same
 * injection as an unvalidated ref — one step further from the caller, which is
 * where this kind of hole usually lives.
 */
export function isCommitRef(value: unknown): value is { id: string; parentIds: string[] } {
  if (value === null || typeof value !== 'object') return false;
  const c = value as Record<string, unknown>;
  if (!/^[0-9a-f]{40}$/.test(String(c.id))) return false;
  if (!Array.isArray(c.parentIds)) return false;
  return c.parentIds.every((p) => isRev(p));
}

/**
 * The base to diff a commit against: its first parent, or git's empty tree.
 *
 * ⚠️ **THE ROOT COMMIT IS THE CASE THAT FAILS SILENTLY** (design record §2.1,
 * and `diff()` already carries the same fallback for an unborn HEAD). A root
 * commit has no parent, so `git diff <nothing> <sha>` is not an error that
 * surfaces — it is an empty diff, and the repository's first commit renders as
 * "this commit changed nothing" with no explanation anywhere. Every file in it
 * reads as an addition against the empty tree, which is what it is.
 *
 * Exported here rather than written at each call site because items 4 and 10
 * both need it and a fallback that is remembered at two call sites out of three
 * is the shape of the bug it prevents.
 */
export function diffBaseFor(commit: Pick<GitCommit, 'parentIds'>): string {
  return commit.parentIds[0] ?? EMPTY_TREE;
}
