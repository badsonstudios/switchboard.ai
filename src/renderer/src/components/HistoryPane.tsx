// The History tab (E24 Git v2 item 2, §5.7) — mockup screen 6, minus the lanes.
//
// ⚠️ **THIS TAB EXISTED AS `enabled: () => false, render: () => null` WHILE TWO OF
// OUR OWN DOCUMENTS SAID ITS READ-ONLY LOG HAD SHIPPED.** `docs/DESIGN.md` §5.7's
// as-built note and `docs/plans/06-phase-3-ide.md`'s E24 both claimed it; the
// owner found out by clicking the tab. That is why this file exists and it is why
// nothing in it is allowed to look finished while being hollow — see the
// incoming/outgoing rows, which carry counts and deliberately no buttons.
//
// Follows `FileTree`'s shape rather than `DiffPane`'s: all the arithmetic is in
// `lib/git-log-dto.ts` (pure, tested without React), the bridge call is injected
// so a test needs no Electron, and the component paints rows and answers keys.
//
// ⚠️ **THE LANES LANDED (item 3), AND THE GAP ITEM 2 RESERVED IS WHAT THEY FILLED.**
// The geometry is `lib/git-lanes.ts` — a pure topological walk tested at eight
// lanes without a DOM — and the ink is `LaneGutter`. Nothing about the rows moved
// to make room, which was the point of reserving the column up front.
import React from 'react';
import { useTranslation } from 'react-i18next';
import { answered } from '../../../shared/ipc/refusal';
import {
  HISTORY_PAGE,
  MAX_HISTORY,
  commitMatches,
  currentBranch,
  historyPaneState,
  isDetached,
  relativeTime,
  syncCounts,
  type CommitFilesDto,
  type GitCommitDto,
  type GitLogDto,
  type GitRefDto,
} from '../lib/git-log-dto';

// Re-exported because the tests and a future host reach for them here, where the
// component that uses them is — but DEFINED in `lib/git-log-dto.ts`, which is a
// plain `.ts` module. That is not tidiness: `tsconfig.node.json` has no `--jsx`,
// so main's test suite cannot import a `.tsx` at all, and the test that pins
// these two against main's own `DEFAULT_LOG_LIMIT` / `MAX_LOG_LIMIT` lives there.
export { HISTORY_PAGE, MAX_HISTORY };
import type { GitStatusDto } from '../lib/git-status';
import { allocateLanes, type LaneRow } from '../lib/git-lanes';
import { LETTER_INKS } from './ScmSidebar';
import { letterKey } from '../lib/scm-groups';
import { openDiff } from '../lib/diff-open';
import { clearFileHistory, fileHistoryRequest, subscribeFileHistory } from '../lib/file-history';
import { canSync, createBranch } from '../lib/git-sync';
/**
 * git's canonical empty tree.
 *
 * Spelled here rather than imported: `repo-config-guard` is a MAIN-process module
 * (it reaches for `fs`, `os` and `crypto`), and the renderer importing it would
 * pull all three into the web bundle. One constant copied is the smaller cost —
 * and it is a git constant, not ours, so it cannot drift.
 */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
import { LaneGutter, laneGutterWidth } from './LaneGutter';

/** How the pane asks for commits. Injected so a test needs no bridge. */
export type ReadLog = (
  folder: string,
  query: { limit: number; skip: number; path?: string; follow?: boolean }
) => Promise<unknown>;
/** How the pane asks for ahead/behind. Same reason. */
export type ReadStatus = (folder: string) => Promise<unknown>;
/** How the pane asks what one commit changed (E24 Git v2 item 4). */
export type ReadCommitFiles = (
  folder: string,
  commit: { id: string; parentIds: string[] }
) => Promise<unknown>;

const bridgeReadLog: ReadLog = (folder, query) => window.switchboard.git.log(folder, query);
const bridgeReadStatus: ReadStatus = (folder) => window.switchboard.git.status(folder);
const bridgeReadCommitFiles: ReadCommitFiles = (folder, commit) =>
  window.switchboard.git.commitFiles(folder, commit);

const REFUSED = 'switchboard could not ask git for more history';

/** The same shape of sentence for a commit that could not be read. */
const REFUSED_COMMIT = 'switchboard could not ask git what that commit changed';

/**
 * The platform's prompt, as the default for the injected one (item 15).
 *
 * ⚠️ **THE SAME ARGUMENT THE DISCARD CONFIRM MAKES**: synchronous, impossible
 * to mistake for part of the page, and impossible to fail to render — where an
 * in-app field that something failed to draw would be a branch button that does
 * nothing. Guarded because `window` is not there in a node-environment test, and
 * NO PROMPT MEANS NO BRANCH rather than a branch with a name nobody chose.
 */
function defaultPrompt(message: string): string | null {
  const w = (globalThis as { prompt?: (m: string) => string | null }).prompt;
  return typeof w === 'function' ? w(message) : null;
}

export function HistoryPane(props: {
  folder: string;
  /** is this tab on screen? drives the refresh-on-return, nothing else */
  active?: boolean;
  readLog?: ReadLog;
  readStatus?: ReadStatus;
  readCommitFiles?: ReadCommitFiles;
  /** the card a diff opened from here is attributed to (§5.24) */
  attributionCardId?: string;
  /** this card, so ⏱ from the Changes tab can pin this tab to one path (item 10) */
  cardId?: string;
  /** the clock, injected — see `relativeTime` for why it is not read in here */
  now?: () => number;
  /**
   * Ask the user for a branch name (item 15).
   *
   * ⚠️ **INJECTED, with the platform's `prompt` as the default — the same bargain
   * the sidebar's discard confirm makes.** A bare `window.prompt` inside this
   * component would be unmockable, so every test of the branch path would pop a
   * real dialog or have to stub a global.
   */
  onPrompt?: (message: string) => string | null;
}): React.JSX.Element {
  const { t } = useTranslation();
  const readLog = props.readLog ?? bridgeReadLog;
  const readStatus = props.readStatus ?? bridgeReadStatus;
  const readCommitFiles = props.readCommitFiles ?? bridgeReadCommitFiles;
  const now = props.now ?? Date.now;

  const [log, setLog] = React.useState<GitLogDto | null>(null);
  const [status, setStatus] = React.useState<GitStatusDto | null>(null);
  const [query, setQuery] = React.useState('');
  /**
   * What the last LANDED page asked for, and what it got.
   *
   * ⚠️ **ADVANCED WHEN A PAGE LANDS, NEVER WHEN ONE IS REQUESTED (found in
   * review), AND THE OLD WAY HID HISTORY.** `wanted` used to be bumped on the
   * click: if the bigger read then came back refused or unreadable, `wanted` was
   * 100 while `commits.length` was 50, so `mayHaveMore` went false, the
   * **Show more button disappeared**, and fifty commits were presented as the
   * whole history. Reachable on a real repository rather than only in theory —
   * `--shortstat` costs ~13 ms per commit against a 15 s budget, so the growing
   * window walks into the timeout at roughly a thousand commits, and sooner on
   * the laptop.
   */
  const [page, setPage] = React.useState({ asked: 0, got: 0 });
  /**
   * BOTH NUMBERS, because they answer different questions and a test caught the
   * difference: `got` is how much history is on screen (so the next window is
   * bigger than it), while `asked` is what the landed page requested — and "did we
   * get as many as we asked for" is the only available way to guess whether there
   * is more. Collapsing them made a two-commit repository offer "Show 50 more".
   */
  const loaded = page.got;
  /** the window the next click asks for; grows only behind a landed page */
  const nextWindow = Math.max(page.asked, loaded) + HISTORY_PAGE;
  const [loadingMore, setLoadingMore] = React.useState(false);
  /**
   * The reason the LAST "show more" could not be answered.
   *
   * Kept apart from `log.unreadable` so a failed page is non-destructive: the
   * commits already on screen stay on screen and the reason appears on the button
   * row. Replacing the list with the error — which is what `setLog(next)` did —
   * threw away a screen of good history to report that there was not more of it.
   */
  const [moreError, setMoreError] = React.useState<string | null>(null);
  /**
   * What a branch attempt said, when it failed (item 15).
   *
   * Its own state rather than `moreError`'s: that one is about a PAGE of history
   * and is deliberately non-destructive of the list, while this is about an
   * action the user took. Two facts, two sentences.
   */
  const [branchError, setBranchError] = React.useState<string | null>(null);
  /**
   * Which commit is expanded, and what it changed (E24 Git v2 item 4) — screen 7.
   *
   * ⚠️ **ONE AT A TIME, AND THAT IS A DECISION.** VS Code's
   * `provideHistoryItemChanges` expands in place and so does this; allowing many
   * would mean a list whose rows move under the pointer as each answer lands, and
   * the file list is a detail view rather than something to compare side by side —
   * that is what the `gitdiff-` panel is for, and every file row opens one.
   *
   * Keyed by sha, so a page landing underneath cannot leave the expansion pointing
   * at a different commit — which an INDEX would.
   */
  /**
   * The path this tab is pinned to, if any (E24 Git v2 item 10).
   *
   * ⚠️ **A STORE RATHER THAN STATE, because the gesture starts in ANOTHER TAB.**
   * ⏱ is on a Changes-tab row, and card tabs are mutually exclusive — so the
   * request has to outlive this component being unmounted while the user is
   * looking at the conversation. `lib/file-history` holds it per card and checks
   * the folder, so a resumed session cannot inherit a path from a different
   * repository.
   */
  const pinned = React.useSyncExternalStore(subscribeFileHistory, () =>
    fileHistoryRequest(props.cardId, props.folder)
  );
  const [openCommit, setOpenCommit] = React.useState<string | null>(null);
  const [commitFiles, setCommitFiles] = React.useState<CommitFilesDto | null>(null);
  /**
   * Which round of asking we are on.
   *
   * The same guard `FileTree` carries, for the same reason: an answer from a
   * superseded round must be DROPPED rather than written over a fresher one.
   * Reachable here by the visibility flip while a page is in flight — and a stale
   * page landing after a fresh one shows older history with nothing to say so.
   *
   * Bumped on unmount as well, which is `FileTree`'s trick too: it doubles as the
   * after-unmount guard, so a late answer sets no state on a gone component.
   */
  const round = React.useRef(0);
  React.useEffect(() => {
    return () => {
      ++round.current;
    };
  }, []);

  const fetchPage = React.useCallback(
    (limit: number) => {
      const mine = ++round.current;
      const isMore = limit > HISTORY_PAGE;
      if (isMore) setLoadingMore(true);
      // ⚠️ **`.catch` ON BOTH, AND `FileTree` IS WHERE THAT WAS LEARNED.** A
      // rejected invoke — a handler that throws, a window torn down mid-call — is
      // not a refusal and `answered()` never sees it. Without the catch it is an
      // unhandled rejection AND `loadingMore` latches `true` for ever: the button
      // sits permanently disabled reading "Reading more…". Fail-open here is to
      // learn nothing and say so, not to hang.
      // ⚠️ `--follow` WITH THE PATH, which is the whole of `log --follow -- <path>`
      // from design §4 item 10: without it a rename ENDS a file's history, and the
      // commits before the `git mv` simply are not there — which reads as "this
      // file is new" about a file somebody has been editing for a year.
      void readLog(props.folder, {
        limit,
        skip: 0,
        ...(pinned ? { path: pinned.path, follow: true } : {}),
      })
        .then((raw) => {
          if (round.current !== mine) return;
          setLoadingMore(false);
          // `answered` BEFORE the cast, like every other consumer of a declared
          // `Promise<unknown>` channel (#650). A refusal teaches us nothing: the
          // pane keeps what it had, which on first mount is `null` — the loading
          // state, which says nothing about the repository.
          const next = answered(raw) as GitLogDto | undefined;
          if (!next) {
            if (isMore) setMoreError(REFUSED);
            return;
          }
          // A FAILED PAGE DOES NOT REPLACE A GOOD LIST. Only the first page — the
          // one with nothing behind it — is allowed to put the pane into the
          // unreadable state.
          if (isMore && next.unreadable) {
            setMoreError(next.unreadable);
            return;
          }
          setMoreError(null);
          setLog(next);
          setPage({ asked: limit, got: next.commits.length });
        })
        .catch(() => {
          if (round.current !== mine) return;
          setLoadingMore(false);
          if (isMore) setMoreError(REFUSED);
        });
    },
    [props.folder, readLog, pinned]
  );

  /**
   * Ahead/behind, fetched per FOLDER and per visibility flip — not per page.
   *
   * ⚠️ It used to ride along with every `fetchPage`, so "Show 50 more" re-ran a
   * `git status` that carries the whole #776 config guard — a config read, a
   * submodule enumeration and several extra git processes — for two numbers that
   * cannot have changed between one page of the same history and the next.
   */
  const fetchStatus = React.useCallback(() => {
    const mine = round.current;
    void readStatus(props.folder)
      .then((raw) => {
        if (round.current !== mine) return;
        const next = answered(raw) as GitStatusDto | undefined;
        if (next) setStatus(next);
      })
      .catch(() => {
        /* the two counts are an extra, never a precondition for the list */
      });
  }, [props.folder, readStatus]);

  React.useEffect(() => {
    setLog(null);
    setStatus(null);
    setPage({ asked: 0, got: 0 });
    setMoreError(null);
    fetchPage(HISTORY_PAGE);
    fetchStatus();
  }, [props.folder, fetchPage, fetchStatus]);

  /**
   * What this reading was ACTUALLY filtered by, and whether a path was refused.
   *
   * ⚠️ **BOTH COME OFF THE ANSWER, WHICH IS THE WHOLE FIX (found in review).**
   * `pinned` is what the user ASKED for; these two are what git was given. They
   * differ in two reachable ways — main refusing the path, and the moment between
   * a pin and the page that honours it — and in both of those the list on screen
   * is NOT one file's history. Keying the chip off the request made the pane say
   * it was in exactly the cases where it was not.
   */
  const applied = log?.filteredBy;
  const pathRefused = log?.pathRefused === true;

  /**
   * Start a branch at a commit (item 15) — the design record's *"create branch
   * from the graph"*.
   *
   * ⚠️ **THE NAME IS ASKED FOR WITH THE PLATFORM'S `prompt`, AND THAT IS THE SAME
   * BARGAIN THE DISCARD CONFIRM MAKES.** It is synchronous, it cannot be mistaken
   * for part of the page, and it cannot fail to render — where an in-app field
   * that something failed to draw would be a branch button that does nothing. An
   * injected prompt (as the sidebar's confirm is) is how a test drives it, and
   * how a nicer dialog replaces this later without touching the rest.
   *
   * ⚠️ **AND THE NAME IS VALIDATED IN MAIN, NOT HERE.** `isBranchName` is the one
   * definition — a second copy in the renderer is a second thing that can be
   * relaxed, which is the argument `git-paths.ts` makes at length.
   */
  const onBranch = React.useMemo(
    () =>
      canSync()
        ? (sha: string, displayId: string): void => {
            const ask = props.onPrompt ?? defaultPrompt;
            const name = ask(t('scm.newBranchPrompt', { commit: displayId }));
            if (name === null || name.trim() === '') return;
            void createBranch(props.folder, name.trim(), sha).then((outcome) => {
              setBranchError(outcome.ok ? null : (outcome.reason ?? null));
              // A new branch changes HEAD, so the whole page is a different
              // question now — and `ahead`/`behind` are gone until it is pushed.
              if (outcome.ok) fetchPage(HISTORY_PAGE);
            });
          }
        : undefined,
    [props.folder, props.onPrompt, t, fetchPage]
  );

  // Back on screen: ask again. A history goes stale the moment the session
  // commits anything, and this tab has no watcher — the same trade `FileTree`
  // makes, and for the same reason (a watch per card per repository is a cost
  // #719 is a standing warning about).
  //
  // ⚠️ `active` is CARD/WINDOW visibility, not tab selection: this panel is not
  // kept mounted, so leaving the tab unmounts it and returning re-runs the mount
  // effect above. This handles the other case — the card scrolled out of view, or
  // its window hidden — where the component survives and goes stale.
  const wasActive = React.useRef(props.active);
  React.useEffect(() => {
    if (props.active && !wasActive.current) {
      // The window we HAVE, so a refresh does not quietly become a bigger, slower
      // query — and `Math.max` because `loaded` is 0 until the first page lands.
      fetchPage(Math.max(loaded, HISTORY_PAGE));
      fetchStatus();
    }
    wasActive.current = props.active;
  }, [props.active, loaded, fetchPage, fetchStatus]);

  const state = historyPaneState(log);
  const commits = log?.commits ?? [];
  const filtered = React.useMemo(
    () => commits.filter((c) => commitMatches(c, query)),
    [commits, query]
  );
  /**
   * Ask what a commit changed, when one is opened.
   *
   * ⚠️ **GUARDED BY THE SAME `round` REF AS THE PAGES, and that matters more here**
   * — a slow commit read landing after the user has opened a different row would
   * draw one commit's files under another commit's subject, which is a worse lie
   * than a stale list. And the folder is in the deps, so switching folders drops
   * the expansion rather than keeping a file list from a different repository.
   */
  React.useEffect(() => {
    if (!openCommit) {
      setCommitFiles(null);
      return;
    }
    const commit = commits.find((c) => c.id === openCommit);
    if (!commit) return;
    const mine = ++round.current;
    setCommitFiles(null);
    void readCommitFiles(props.folder, { id: commit.id, parentIds: commit.parentIds })
      .then((raw) => {
        if (round.current !== mine) return;
        const next = answered(raw) as CommitFilesDto | undefined;
        setCommitFiles(next ?? { files: [], unreadable: REFUSED_COMMIT });
      })
      .catch(() => {
        if (round.current !== mine) return;
        setCommitFiles({ files: [], unreadable: REFUSED_COMMIT });
      });
  }, [openCommit, commits, props.folder, readCommitFiles]);

  const sync = syncCounts(status);
  /**
   * The graph, laid out over the UNFILTERED list.
   *
   * ⚠️ **AND THAT IS THE ONLY CORRECT CHOICE.** The lanes come from `parentIds`,
   * so a layout computed over filtered rows would be drawing a different
   * repository: hide the merge and its two branches become two unconnected stubs,
   * hide a commit in the middle of a branch and the line through it breaks. So the
   * geometry is of the whole page and the FILTER hides rows out of it — which is
   * why a filtered list shows gaps in the graph, and why that is honest rather
   * than broken. Memoised on the ids, since typing in the search box must not
   * re-walk it.
   */
  const layout = React.useMemo(() => allocateLanes(commits), [commits]);
  const laneByCommit = React.useMemo(() => {
    const map = new Map<string, LaneRow>();
    for (const r of layout.rows) map.set(r.id, r);
    return map;
  }, [layout]);
  const gutter = laneGutterWidth(layout.lanes);
  const branch = currentBranch(commits);
  const detached = isDetached(commits);
  /**
   * Is there more history behind what we have?
   *
   * Inferred from "we got as many as we asked for", which is the only answer
   * available without a second `rev-list --count` — and that call costs a process
   * to tell the user whether a button should be there. Being wrong here means one
   * extra click that returns the same rows, which is cheap; being wrong the other
   * way would hide history.
   *
   * ⚠️ **AND IT IS TRUE AFTER A FAILED PAGE, which is the point of the rewrite
   * above:** `loaded` only moves behind a landed page, so a page that failed
   * leaves the button exactly where it was, with the reason beside it.
   */
  const atCeiling = loaded >= MAX_HISTORY;
  const mayHaveMore = page.asked > 0 && page.got >= page.asked && !atCeiling;

  const nowMs = now();

  return (
    <div
      style={{
        blockSize: '100%',
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--card-bg)',
        minInlineSize: 0,
      }}
    >
      <div
        style={{
          display: 'flex',
          gap: 8,
          alignItems: 'center',
          padding: '6px 8px',
          borderBlockEnd: '1px solid var(--border)',
          fontSize: 11,
          flexWrap: 'wrap',
        }}
      >
        {/* The branch, read off `%D` rather than asked for separately — a second
            git call for the name could disagree with the rows beside it. */}
        {branch && (
          <span
            className="history-branch"
            style={{ fontFamily: 'var(--font-mono)', color: 'var(--text)', whiteSpace: 'nowrap' }}
          >
            {t('history.branch', { branch })}
          </span>
        )}
        {/* A detached HEAD is a state people reach by accident and cannot explain,
            and every commit made there is one they can lose. Said plainly, in the
            notice ink (blue; yellow is a session needing you, #1165), rather than
            left to be inferred from a missing chip. */}
        {!branch && detached && (
          <span className="history-detached" style={{ color: 'var(--status-working-ink)' }}>
            {t('history.detached')}
          </span>
        )}
        {/* ⚠️ THE PINNED-PATH CHIP, AND ITS ✕ IS THE ONLY WAY BACK. A filtered
            history that did not SAY it was filtered would read as a repository
            with three commits in it — which is the confident wrong answer this
            whole epic is a correction for, in a new shape.

            ⚠️⚠️ **DRAWN FROM THE ANSWER, NOT FROM THE REQUEST (found in review).**
            The first version keyed off `pinned`, so when main's `safePath`
            refused a path the pane rendered the WHOLE history under a chip
            naming one file — the same confident wrong answer, one level up. The
            chip now cannot claim a filter that did not happen: `filteredBy` is
            what git was actually given, and `pathRefused` gets WORDS of its own
            rather than silence. */}
        {applied && (
          <span
            className="history-pinned"
            role="status"
            // ⚠️ **THE SENTENCE GOES WHERE IT IS ANNOUNCED, WHICH IS NOT A `title`
            // (found in review — and `CommitRow` below already records this
            // lesson).** A `title` on a non-focusable span reaches a mouse and
            // nothing else, and the chip's visible content is a bidi-isolated path
            // truncated from the front: no words anywhere said the list was a
            // subset. The label carries the sentence, and the ⌕ glyph makes the
            // filtering visible at a glance instead of inferred from a border.
            aria-label={t('history.pinnedTitle', { path: applied })}
            title={t('history.pinnedTitle', { path: applied })}
            style={{
              display: 'flex',
              gap: 4,
              alignItems: 'center',
              flexShrink: 0,
              maxInlineSize: 200,
              // ⚠️ THE ACCENT IS THE RING, AND THE WORDS TAKE THE NEUTRAL INK —
              // `tokens.drift.test.ts` caught the first draft spending
              // `--accent-blue` on `color:` too (it reads every renderer source,
              // inline styles included, and failed by this file's name). Four of
              // the eight accents are byte-identical to a status hue, so a path
              // written in one reads on screen as a status about that path. The
              // border carries the identity; the text is just text.
              border: '1px solid var(--accent-blue)',
              borderRadius: 3,
              color: 'var(--text)',
              fontFamily: 'var(--font-mono)',
              fontSize: 9.5,
              paddingInlineStart: 4,
            }}
          >
            <span aria-hidden="true" style={{ color: 'var(--muted)' }}>
              {t('history.pinnedIcon')}
            </span>
            <span
              style={{
                minInlineSize: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                direction: 'rtl',
              }}
            >
              {t('diff.pathIsolated', { path: applied })}
            </span>
            <button
              type="button"
              className="history-unpin"
              title={t('history.unpin')}
              aria-label={t('history.unpin')}
              onClick={() => clearFileHistory(props.cardId)}
              style={{
                background: 'transparent',
                border: 'none',
                color: 'inherit',
                cursor: 'pointer',
                fontSize: 10,
                lineHeight: 1,
                padding: '0 3px',
              }}
            >
              {t('history.unpinIcon')}
            </button>
          </span>
        )}
        {/* ⚠️ A PATH MAIN WOULD NOT PASS GETS WORDS, NOT SILENCE. `safePath`
            refuses a leading `:` (pathspec magic) and `..`, and a filename
            beginning with `:` is legal on macOS and Linux — so this is reachable
            by clicking ⏱ on an ordinary file there. Saying it plainly is the only
            honest option: the list below really is the whole history. */}
        {pathRefused && (
          <span
            className="history-pin-refused"
            role="status"
            style={{
              display: 'flex',
              gap: 4,
              alignItems: 'center',
              flexShrink: 0,
              color: 'var(--status-crashed-ink)',
              fontSize: 9.5,
            }}
          >
            {t('history.pinRefused')}
            <button
              type="button"
              className="history-unpin"
              title={t('history.unpin')}
              aria-label={t('history.unpin')}
              onClick={() => clearFileHistory(props.cardId)}
              style={{
                background: 'transparent',
                border: 'none',
                color: 'inherit',
                cursor: 'pointer',
                fontSize: 10,
                lineHeight: 1,
                padding: '0 3px',
              }}
            >
              {t('history.unpinIcon')}
            </button>
          </span>
        )}
        <input
          type="search"
          className="history-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('history.searchPlaceholder')}
          aria-label={t('history.searchLabel')}
          style={{
            flex: '1 1 160px',
            minInlineSize: 100,
            maxInlineSize: 260,
            background: 'var(--input-bg, var(--card-bg))',
            color: 'var(--text)',
            border: '1px solid var(--border)',
            borderRadius: 4,
            padding: '2px 6px',
            fontSize: 11,
          }}
        />
        {/* The count, and it counts what is ON SCREEN when a filter is on. A
            header that said "50 commits" over three visible rows is the kind of
            small untruth that teaches a user not to trust the bigger numbers.

            ⚠️ **GATED ON `commits`, AND A TEST IS WHAT FOUND THAT.** Ungated it
            rendered for every state, so a repository switchboard could not read
            was topped by the words **"no commits"** — the pane below saying "we
            could not find out" and the toolbar above contradicting it with a
            confident zero. Exactly the lie this epic is a correction for,
            reintroduced two inches higher up. */}
        {/* ⚠️ **AND IT SAYS WHOSE COUNT IT IS WHEN A PATH IS PINNED (found in
            review).** Pinned, `history.count` with zero reads **"no commits"** —
            a confident statement about a thousand-commit project, two inches
            above a line about one file. The pinned wording is about the file. */}
        {state.kind === 'commits' && (
          <span style={{ color: 'var(--muted)', fontFamily: 'var(--font-mono)', fontSize: 10 }}>
            {query.trim() !== ''
              ? t('history.countFiltered', { shown: filtered.length, total: commits.length })
              : applied
                ? t('history.countPinned', { count: commits.length })
                : t('history.count', { count: commits.length })}
          </span>
        )}
      </div>

      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          // ⚠️ **`overflowX: hidden` IS LOAD-BEARING (found in review).** Setting
          // only `overflowY: auto` leaves `overflow-x` computing to `auto` per the
          // CSS overflow spec, so a row too wide for a narrow card grew a
          // HORIZONTAL SCROLLBAR and pushed the hash, the stats and the date off
          // the right edge — design record §1.2 cause 2 (the Changes tab cutting
          // off the identifying end of a path) reappearing in a new tab. The rows
          // now shed chips instead; see `CommitRow`.
          overflowX: 'hidden',
          minBlockSize: 0,
        }}
      >
        {/* ⚠️ INCOMING AND OUTGOING CARRY COUNTS AND NO BUTTONS, DELIBERATELY.
            Screen 6 draws Pull and Push on these rows; both belong to item 15,
            the branch/sync surface. The owner's rule governs the gap — *a row
            with a `＋` that does nothing is worse than a row with no `＋`* — so
            the rows ship as the true statement they can make today ("you are
            three commits ahead") and gain their verbs when the verbs work.

            These two numbers are `GitStatus.ahead` and `GitStatus.behind`, which
            that interface has carried since it was written and which, per the
            design record §1.2, NO CONSUMER HAS EVER READ. This is the first.

            ⚠️ **GATED ON `commits` — THEY WERE NOT, AND IT IS THE COMMIT COUNT'S
            BUG EXACTLY (found in review).** `git:status` can succeed while
            `git:log` is unreadable (a log timeout, the 32 MB cap), and these rows
            then drew **"↑ 3 commits to push"** directly above *"switchboard
            couldn't read this project's history"* — two counts of commits sitting
            on top of an admission that the commits could not be read. The count in
            the toolbar was fixed for this and these were missed, which is the
            argument for gating on the state rather than on each row's own data. */}
        {state.kind === 'commits' && sync.hasUpstream && (sync.behind ?? 0) > 0 && (
          <div className="history-incoming" style={syncRowStyle('var(--status-working-ink, var(--text))')}>
            {t('history.incoming', { count: sync.behind ?? 0 })}
          </div>
        )}
        {state.kind === 'commits' && sync.hasUpstream && (sync.ahead ?? 0) > 0 && (
          <div className="history-outgoing" style={syncRowStyle('var(--status-working-ink)')}>
            {t('history.outgoing', { count: sync.ahead ?? 0 })}
          </div>
        )}

        {state.kind === 'loading' && (
          <div style={{ padding: 10, color: 'var(--muted)', fontSize: 11 }}>{t('history.loading')}</div>
        )}
        {/* ⚠️ **A BRANCH THAT WAS NOT CREATED SAYS SO, IN GIT'S OWN WORDS (item
            15).** The common refusals are *"a branch named 'x' already exists"*
            and a name git will not take, and both are things the user has to read
            to fix. `role="status"` so it is announced: the ⑂ that caused it has
            already lost focus by the time this renders. */}
        {branchError !== null && (
          <div
            className="history-branch-error"
            role="status"
            style={{ padding: '4px 8px', color: 'var(--status-crashed-ink)', fontSize: 10.5 }}
          >
            {t('scm.writeFailed', { reason: branchError })}
          </div>
        )}
        {/* The attention ink, not `--muted`: this is something being WRONG, where
            the two below it are ordinary facts about a folder. Same reasoning, and
            the same token, as the Changes tab's unreadable branch. */}
        {state.kind === 'unreadable' && (
          <div
            className="history-unreadable"
            style={{ padding: 10, color: 'var(--status-crashed-ink)', fontSize: 11 }}
          >
            {t('history.unreadable', { reason: state.reason })}
          </div>
        )}
        {state.kind === 'unborn' && (
          <div className="history-unborn" style={{ padding: 10, color: 'var(--muted)', fontSize: 11 }}>
            {t('history.unborn')}
          </div>
        )}
        {state.kind === 'not-repo' && (
          <div style={{ padding: 10, color: 'var(--muted)', fontSize: 11 }}>{t('history.notRepo')}</div>
        )}
        {/* ⚠️ **"Nothing to show", NOT "No commits yet" (found in review).** That
            sentence belongs to `unborn` and to nothing else: this branch is also
            the shape an unexpected payload produces (`answered()` is a brand, not
            a validation, so a reply missing `commits` lands here via `?? []`), and
            a claim about the user's project is not the thing to say about our own
            surprise. */}
        {/* ⚠️ **AND A PINNED EMPTY ANSWER IS ABOUT THE FILE, NOT ABOUT THE
            PROJECT (found in review).** This is the single most likely thing to
            press ⏱ on: the Changes tab lists UNTRACKED files, and git has no
            history at all for a file it has never seen. "Nothing to show" in a
            thousand-commit repository is ambiguous about whose answer it is — so
            the pinned case names the path and says why. */}
        {state.kind === 'commits' && filtered.length === 0 && (
          <div
            className="history-empty"
            style={{ padding: 10, color: 'var(--muted)', fontSize: 11 }}
          >
            {commits.length > 0
              ? t('history.noMatches', { query })
              : applied
                ? t('history.nonePinned', { path: applied })
                : t('history.nothingToShow')}
          </div>
        )}
        {state.kind === 'commits' && filtered.length > 0 && (
          // `role="list"` and `listitem` on the rows: they are not interactive and
          // §5.32's rule is that a composite role goes on only where it is true, so
          // this is not a tree or a grid. What it buys is a screen reader
          // announcing "list, 50 items" and each row as one unit rather than as a
          // run of loose text.
          <div role="list">
            {filtered.map((c) => (
              <React.Fragment key={c.id}>
                <CommitRow
                  commit={c}
                  nowMs={nowMs}
                  lane={laneByCommit.get(c.id)}
                  lanes={layout.lanes}
                  gutter={gutter}
                  open={openCommit === c.id}
                  // ⚠️ A TOGGLE, so clicking the open row closes it. The
                  // alternative — click to open, click again to re-fetch — makes
                  // the row's one gesture do a different thing depending on state
                  // it does not show.
                  onToggle={() => setOpenCommit((cur) => (cur === c.id ? null : c.id))}
                  onBranch={onBranch}
                />
                {openCommit === c.id && (
                  <CommitFiles
                    files={commitFiles}
                    folder={props.folder}
                    commit={c}
                    gutter={gutter}
                    attributionCardId={props.attributionCardId}
                  />
                )}
              </React.Fragment>
            ))}
          </div>
        )}

        {/* ⚠️ THE FAILED-PAGE REASON LIVES HERE, BESIDE THE BUTTON, AND NOT IN
            PLACE OF THE LIST. The whole point of the paging rewrite: a page that
            could not be answered costs you the page, not the fifty commits you were
            already reading. */}
        {state.kind === 'commits' && moreError && (
          <div
            className="history-more-failed"
            style={{ padding: '6px 8px', color: 'var(--status-crashed-ink)', fontSize: 11 }}
          >
            {t('history.moreFailed', { reason: moreError })}
          </div>
        )}
        {state.kind === 'commits' && mayHaveMore && (
          <button
            type="button"
            className="history-more"
            disabled={loadingMore}
            onClick={() => fetchPage(nextWindow)}
            style={{
              display: 'block',
              inlineSize: '100%',
              background: 'transparent',
              border: 'none',
              borderBlockStart: '1px solid var(--border)',
              color: 'var(--muted)',
              cursor: loadingMore ? 'default' : 'pointer',
              padding: '6px 8px',
              fontSize: 11,
              textAlign: 'center',
            }}
          >
            {loadingMore ? t('history.loadingMore') : t('history.more', { count: HISTORY_PAGE })}
          </button>
        )}
        {/* ⚠️ THE CEILING SAYS SO. Without this the last click returned the same
            two thousand rows and the button vanished with no explanation, which
            reads as the button being broken rather than as a limit being reached. */}
        {state.kind === 'commits' && atCeiling && (
          <div
            className="history-ceiling"
            style={{
              padding: '6px 8px',
              borderBlockStart: '1px solid var(--border)',
              color: 'var(--muted)',
              fontSize: 11,
              textAlign: 'center',
            }}
          >
            {t('history.ceiling', { count: MAX_HISTORY })}
          </div>
        )}
      </div>
    </div>
  );
}

function syncRowStyle(ink: string): React.CSSProperties {
  return {
    display: 'flex',
    gap: 6,
    alignItems: 'center',
    padding: '4px 8px',
    borderBlockEnd: '1px solid var(--border)',
    color: ink,
    fontSize: 11,
  };
}

/**
 * One commit.
 *
 * ⚠️ **THE IDENTIFYING END OF THE ROW IS THE PART THAT MUST SURVIVE.** Design
 * record §1.2 cause 2 is the Changes tab truncating the identifying end of a path;
 * the same mistake here is letting the sha, the stats or the date get squeezed out.
 * So: the subject is flexible and ellipsises, and **the ref chips are a second
 * shrinkable group** rather than a run of `flexShrink: 0` children.
 *
 * ⚠️ **THAT SECOND GROUP IS A REVIEW FIX, AND THE FIRST VERSION'S COMMENT HAD IT
 * BACKWARDS.** It said "everything else declares `flexShrink: 0` and keeps its
 * size", as though keeping size were the safe choice. With eight chips, a fixed
 * author column and the three monospace fields, the non-shrinking children alone
 * can exceed a narrow card: the subject collapses to nothing and then the ROW
 * overflows, which cost exactly what the comment claimed to protect.
 */
/**
 * One commit's files, expanded in place (E24 Git v2 item 4) — mockup screen 7.
 *
 * ⚠️ **AND CLICKING ONE OPENS A `gitdiff-` PANEL AT `base..sha`, WHICH IS THE
 * THIRD SHAPE ITEM 5 RESERVED.** Design §3 named all three from the start so
 * that this item added a CALLER rather than a second registry — and the panel
 * refused a commit target until this item gave it a loader, which is why the key
 * includes `left..right`: the same file's working-tree diff and its diff at a
 * commit are two panels, deliberately.
 */
function CommitFiles(props: {
  files: CommitFilesDto | null;
  folder: string;
  commit: GitCommitDto;
  /** the lane gutter's width, so the file list lines up under its commit */
  gutter: number;
  attributionCardId?: string;
}): React.JSX.Element {
  const { t } = useTranslation();
  /**
   * The "before" side.
   *
   * ⚠️ **THE EMPTY TREE FOR A ROOT COMMIT, AND THIS IS THE CASE THAT FAILS
   * SILENTLY.** A root commit has no parent, so without the substitution the
   * repository's FIRST commit shows an empty diff for every file and says nothing
   * about why. `diffBaseFor` in main does the same substitution for the file list;
   * this is the renderer half, for the panel the row opens.
   */
  const base = props.commit.parentIds[0] ?? EMPTY_TREE;
  return (
    <div
      className="history-files"
      style={{
        paddingInlineStart: props.gutter + 8,
        paddingBlock: 2,
        background: 'var(--panel2, var(--panel))',
        borderBlockEnd: '1px solid var(--border)',
      }}
    >
      {props.files === null && (
        <div style={{ padding: '3px 6px', color: 'var(--muted)', fontSize: 10.5 }}>
          {t('history.filesLoading')}
        </div>
      )}
      {/* The attention ink, and the same discipline the pane above uses: a commit
          we could not read says so in git's own words rather than drawing an
          empty list, which would claim the commit changed nothing. */}
      {props.files?.unreadable && (
        <div
          className="history-files-unreadable"
          style={{ padding: '3px 6px', color: 'var(--status-crashed-ink)', fontSize: 10.5 }}
        >
          {t('history.filesUnreadable', { reason: props.files.unreadable })}
        </div>
      )}
      {/* ⚠️ AN EMPTY COMMIT REALLY HAS NO FILES, and it is a thing that exists —
          `--allow-empty`. Saying so beats an empty box, which reads as a load that
          never finished. */}
      {props.files && !props.files.unreadable && props.files.files.length === 0 && (
        <div style={{ padding: '3px 6px', color: 'var(--muted)', fontSize: 10.5 }}>
          {t('history.filesNone')}
        </div>
      )}
      {props.files?.files.map((f) => (
        <button
          key={f.path}
          type="button"
          className="history-file"
          data-path={f.path}
          title={f.from ? t('history.renamedFrom', { from: f.from }) : f.path}
          aria-label={t('history.fileLabel', {
            name: f.path,
            status: t(`scm.letter.${letterKey(f.letter)}`),
          })}
          onClick={() =>
            openDiff({
              folder: props.folder,
              path: f.path,
              left: base,
              right: props.commit.id,
              attributionCardId: props.attributionCardId,
            })
          }
          style={{
            display: 'flex',
            gap: 5,
            alignItems: 'baseline',
            inlineSize: '100%',
            background: 'transparent',
            border: 'none',
            color: 'var(--text)',
            cursor: 'pointer',
            padding: '2px 6px',
            fontSize: 10.5,
            textAlign: 'left',
          }}
        >
          <span
            className={`history-file-letter scm-letter-${letterKey(f.letter)}`}
            aria-hidden="true"
            style={{
              flexShrink: 0,
              inlineSize: 10,
              textAlign: 'center',
              color: `var(${LETTER_INKS[f.letter] ?? '--muted'})`,
              fontFamily: 'var(--font-mono)',
              fontWeight: 600,
              fontSize: 9.5,
            }}
          >
            {f.letter}
          </span>
          <span
            style={{
              flex: 1,
              minInlineSize: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              direction: 'rtl',
              textAlign: 'left',
            }}
          >
            {t('diff.pathIsolated', { path: f.path })}
          </span>
          {/* ⚠️ BINARY SAYS SO; ZERO-AND-ZERO IS NOT DRAWN AT ALL. A pure mode
              change has no lines either way, and `+0 −0` on it would be a number
              about nothing. */}
          <span
            className="history-file-stat"
            style={{ flexShrink: 0, fontFamily: 'var(--font-mono)', fontSize: 9.5 }}
          >
            {f.binary ? (
              <span style={{ color: 'var(--muted)' }}>{t('scm.binary')}</span>
            ) : f.insertions === 0 && f.deletions === 0 ? (
              ''
            ) : (
              <>
                <span style={{ color: 'var(--diff-added)' }}>
                  {t('scm.plus', { n: f.insertions })}
                </span>{' '}
                <span style={{ color: 'var(--diff-removed)' }}>
                  {t('scm.minus', { n: f.deletions })}
                </span>
              </>
            )}
          </span>
        </button>
      ))}
    </div>
  );
}

function CommitRow(props: {
  commit: GitCommitDto;
  nowMs: number;
  /** this commit's geometry — absent only if the layout and the list disagree */
  lane?: LaneRow;
  /** how many lanes the whole page needs — NOT pixels; the gutter converts */
  lanes: number;
  /** the gutter's pixel width, for the fallback box when `lane` is missing */
  gutter: number;
  /** is this commit's file list showing (E24 Git v2 item 4)? */
  open: boolean;
  onToggle: () => void;
  /**
   * Start a branch at this commit (item 15), or `undefined` to draw no ⑂.
   *
   * Takes the full sha AND the short one: the sha is what git is given, the short
   * one is what the prompt shows, and the row is the only place that has both.
   */
  onBranch?: (sha: string, displayId: string) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const c = props.commit;
  const merge = c.parentIds.length > 1;
  const when = relativeTime(c.timestamp, props.nowMs);
  return (
    <div
      className="history-row"
      role="listitem"
      // The whole message in a `title`, which is the cheapest possible version of
      // item 4's expand-in-place: a reader can at least SEE the body of a commit
      // whose subject is not enough. Not a substitute — item 4 still owes the file
      // list — but a row that hides the message entirely until then is a worse
      // version of the same tab.
      //
      // ⚠️ **AND `aria-label` CARRIES THE SAME FACTS, because `title` on a
      // non-focusable div reaches neither a keyboard nor a screen reader (review).**
      // The label is the row said as a sentence, including the merge fact and the
      // date, so the only route to a commit's identity is not a hover.
      title={c.message || c.subject}
      aria-label={t('history.rowLabel', {
        subject: c.subject || t('history.noSubject'),
        author: c.author,
        hash: c.displayId,
        when: when || t('history.noDate'),
        merge: merge ? t('history.mergeTitle', { count: c.parentIds.length }) : '',
      })}
      // ⚠️ **A `<button>`'s JOB ON A `<div>`'s ELEMENT WOULD BE §5.32 RULE 1 BROKEN
      // AGAIN** — which `ScmSidebar` had to fix for its own rows. So the row is a
      // real button: Enter, Space, focus and the announcement come from the
      // platform, and `aria-expanded` says what the gesture does.
      onClick={props.onToggle}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          props.onToggle();
        }
      }}
      tabIndex={0}
      aria-expanded={props.open}
      style={{
        display: 'flex',
        gap: 6,
        alignItems: 'center',
        padding: '4px 8px',
        fontSize: 11,
        color: 'var(--text)',
        cursor: 'pointer',
        // ⚠️ `--border-faint` DOES NOT EXIST, so this used to be
        // `var(--border-faint, transparent)` and every row shipped with no
        // separator at all, in every theme (review). Nothing could have flagged
        // it: the drift test reads the token files, not inline styles.
        borderBlockEnd: '1px solid var(--border)',
        minInlineSize: 0,
      }}
    >
      {/* The lane gutter. ⚠️ The width is reserved EVEN WITHOUT a row to draw —
          `lane` can only be absent if the layout and the list disagree, which
          nothing should cause, and a row that then lost its gutter would knock
          every dot below it out of line. An empty box of the right size is the
          fail-open shape. */}
      {props.lane ? (
        <LaneGutter row={props.lane} width={props.lanes} />
      ) : (
        <span style={{ inlineSize: props.gutter, flexShrink: 0 }} aria-hidden="true" />
      )}
      <span
        className="history-subject"
        style={{
          flex: 1,
          minInlineSize: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {c.subject || t('history.noSubject')}
      </span>
      {/* The chips as ONE shrinkable, clipping group — see the header. A commit
          with eight refs now loses chips off its right edge instead of pushing the
          sha and the date out of the card. */}
      {c.references.length > 0 && (
        <span
          className="history-refs"
          style={{ display: 'flex', gap: 4, minInlineSize: 0, overflow: 'hidden', flexShrink: 1 }}
        >
          {c.references.map((r) => (
            <RefChip key={r.full} ref_={r} />
          ))}
        </span>
      )}
      {merge && (
        <span
          className="history-merge"
          // `aria-hidden`: the merge fact is in the row's `aria-label` as words, so
          // a reader hearing "⑃" as well would hear it twice, once as a glyph it
          // cannot name.
          aria-hidden="true"
          title={t('history.mergeTitle', { count: c.parentIds.length })}
          style={{ flexShrink: 0, color: 'var(--muted)', fontFamily: 'var(--font-mono)', fontSize: 10 }}
        >
          {t('history.mergeMark')}
        </span>
      )}
      <span
        style={{
          flexShrink: 0,
          color: 'var(--muted)',
          maxInlineSize: 110,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {c.author}
      </span>
      {/* ⚠️ `null` STATS DRAW NOTHING, NOT ZERO. An empty commit really has no
          numbers, and so does a query that did not ask for them — "git said
          nothing" and "git said zero" are different, and inventing the second is
          the class of wrong answer this whole surface is a correction for. */}
      {c.stats && (
        <span
          className="history-stats"
          style={{ flexShrink: 0, fontFamily: 'var(--font-mono)', fontSize: 10 }}
          title={t('history.statsTitle', { files: c.stats.files })}
        >
          {/* Two spans because the two numbers are DIFFERENT COLOURS, and the
              signs come from the catalog because `react/jsx-no-literals` is on —
              a `+` typed into JSX is a user-facing string like any other, and
              some locales do not write a leading sign at all. */}
          {/* ⚠️ `--diff-added` / `--diff-removed`, NOT `--diff-added-ink`. The
              `-ink` names do not exist (review), so these silently fell through to
              the status inks and never shared the Changes tab's diff palette —
              which is the whole reason to use a token rather than a colour. */}
          <span style={{ color: 'var(--diff-added)' }}>
            {t('history.added', { n: c.stats.insertions })}
          </span>{' '}
          <span style={{ color: 'var(--diff-removed)' }}>
            {t('history.removed', { n: c.stats.deletions })}
          </span>
        </span>
      )}
      <span
        className="history-hash"
        style={{ flexShrink: 0, color: 'var(--muted)', fontFamily: 'var(--font-mono)', fontSize: 10 }}
      >
        {c.displayId}
      </span>
      <span
        className="history-when"
        style={{ flexShrink: 0, color: 'var(--muted)', fontFamily: 'var(--font-mono)', fontSize: 10, minInlineSize: 32, textAlign: 'right' }}
        // The exact date, because a relative one is deliberately imprecise and
        // sometimes the precise answer is the question. ⚠️ Guarded on `timestamp`,
        // because `new Date(null * 1000)` is 1 January 1970 and this used to put
        // that in the tooltip of a commit git could not date — which is the bug
        // `relativeTime` was already written to avoid, two inches away.
        title={c.timestamp === null ? undefined : new Date(c.timestamp * 1000).toLocaleString()}
      >
        {when}
      </span>
      {/* ⚠️ **⑂ — "NEW BRANCH FROM HERE" (item 15), AND THIS IS WHERE THE DESIGN
          RECORD ASKED FOR IT: *"create branch from the graph"*.** The graph is in
          this tab, so the gesture is on the row that has the commit — rather than
          a dialog somewhere else that would make the user paste a sha.

          ABSENT when this build cannot branch at all, which is the owner's rule.
          A SIBLING of the row's button rather than inside it, because the row is
          a `<button>` and a button inside a button is invalid HTML — the lesson
          the sidebar's group heading paid for. */}
      {props.onBranch && (
        <button
          type="button"
          className="history-branch-here"
          data-testid="history-branch-here"
          title={t('scm.newBranch')}
          aria-label={t('scm.newBranch')}
          onClick={(e) => {
            // The row is a toggle that expands the commit's files; branching from
            // it must not also do that.
            e.stopPropagation();
            props.onBranch?.(c.id, c.displayId);
          }}
          style={{
            flexShrink: 0,
            background: 'transparent',
            border: 'none',
            color: 'var(--muted)',
            cursor: 'pointer',
            fontSize: 10,
            lineHeight: 1,
            padding: '0 2px',
          }}
        >
          {t('scm.newBranchIcon')}
        </button>
      )}
    </div>
  );
}

/**
 * A ref chip.
 *
 * ⚠️ **A BRANCH AND A TAG CAN SHARE A NAME, AND THAT IS WHY `--decorate=full` IS
 * IN THE COMMAND.** Short decoration gives `release` and `release` with nothing
 * between them. Drawing them identically would be wrong only in the repository
 * that has the collision — i.e. silently, and for one user.
 */
function RefChip(props: { ref_: GitRefDto }): React.JSX.Element {
  const { t } = useTranslation();
  const r = props.ref_;
  const ink =
    r.kind === 'tag'
      ? 'var(--status-done-ink)'
      : r.kind === 'remote'
        ? 'var(--muted)'
        : r.isHead
          ? 'var(--status-working-ink)'
          : 'var(--text)';
  return (
    <span
      className={`history-ref history-ref-${r.kind}`}
      title={r.full}
      style={{
        flexShrink: 0,
        border: `1px solid ${ink}`,
        borderRadius: 3,
        color: ink,
        fontFamily: 'var(--font-mono)',
        fontSize: 9.5,
        lineHeight: 1.5,
        padding: '0 4px',
        whiteSpace: 'nowrap',
        fontWeight: r.isHead ? 600 : 400,
      }}
    >
      {/* ⚠️ **EVERY KIND CARRIES A GLYPH, INCLUDING THE BRANCH ONES.** This said
          "the kind is in the text, not only in the colour" while a branch chip
          rendered the bare name and HEAD-ness was hue plus `font-weight: 600` — so
          the claim was true of tags and remotes and false of exactly the two that
          matter most (review). The checked-out branch now wears `⑂` and a plain
          branch wears nothing but is distinguishable from a tag and a remote by
          theirs, which is what makes the row readable in high-contrast and to a
          colour-blind reader. The full refname is in the `title` either way. */}
      {r.kind === 'tag'
        ? t('history.chipTag', { name: r.name })
        : r.kind === 'remote'
          ? t('history.chipRemote', { name: r.name })
          : r.isHead
            ? t('history.chipHead', { name: r.name })
            : r.name}
    </span>
  );
}
