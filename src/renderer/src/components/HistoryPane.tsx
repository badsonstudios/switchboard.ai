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
// ⚠️ **THE LANES ARE ITEM 3 AND THE GAP IS RESERVED, NOT FORGOTTEN.** Screen 6
// draws an SVG lane gutter down the left of every row. Each row here reserves that
// column at the same width, so item 3 fills a hole rather than re-laying the rows
// out — and until it does, the rows are flush and read as a list, which is what a
// list with no graph should look like.
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

/** How the pane asks for commits. Injected so a test needs no bridge. */
export type ReadLog = (folder: string, query: { limit: number; skip: number }) => Promise<unknown>;
/** How the pane asks for ahead/behind. Same reason. */
export type ReadStatus = (folder: string) => Promise<unknown>;

const bridgeReadLog: ReadLog = (folder, query) => window.switchboard.git.log(folder, query);
const bridgeReadStatus: ReadStatus = (folder) => window.switchboard.git.status(folder);

const REFUSED = 'switchboard could not ask git for more history';

/**
 * The width of the lane gutter item 3 will draw into.
 *
 * Reserved from the start so that landing the graph does not move every row. 0
 * today — see the file header: a list with no graph should look like a list, not
 * like a graph with the graph missing. Item 3 changes this one number and fills
 * the column.
 */
const LANE_GUTTER = 0;

export function HistoryPane(props: {
  folder: string;
  /** is this tab on screen? drives the refresh-on-return, nothing else */
  active?: boolean;
  readLog?: ReadLog;
  readStatus?: ReadStatus;
  /** the clock, injected — see `relativeTime` for why it is not read in here */
  now?: () => number;
}): React.JSX.Element {
  const { t } = useTranslation();
  const readLog = props.readLog ?? bridgeReadLog;
  const readStatus = props.readStatus ?? bridgeReadStatus;
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
      void readLog(props.folder, { limit, skip: 0 })
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
    [props.folder, readLog]
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
  const sync = syncCounts(status);
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
            attention ink, rather than left to be inferred from a missing chip. */}
        {!branch && detached && (
          <span className="history-detached" style={{ color: 'var(--status-needs-input-ink)' }}>
            {t('history.detached')}
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
        {state.kind === 'commits' && (
          <span style={{ color: 'var(--muted)', fontFamily: 'var(--font-mono)', fontSize: 10 }}>
            {query.trim() === ''
              ? t('history.count', { count: commits.length })
              : t('history.countFiltered', { shown: filtered.length, total: commits.length })}
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
          <div className="history-outgoing" style={syncRowStyle('var(--status-needs-input-ink)')}>
            {t('history.outgoing', { count: sync.ahead ?? 0 })}
          </div>
        )}

        {state.kind === 'loading' && (
          <div style={{ padding: 10, color: 'var(--muted)', fontSize: 11 }}>{t('history.loading')}</div>
        )}
        {/* The attention ink, not `--muted`: this is something being WRONG, where
            the two below it are ordinary facts about a folder. Same reasoning, and
            the same token, as the Changes tab's unreadable branch. */}
        {state.kind === 'unreadable' && (
          <div
            className="history-unreadable"
            style={{ padding: 10, color: 'var(--status-needs-input-ink)', fontSize: 11 }}
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
        {state.kind === 'commits' && filtered.length === 0 && (
          <div style={{ padding: 10, color: 'var(--muted)', fontSize: 11 }}>
            {commits.length === 0 ? t('history.nothingToShow') : t('history.noMatches', { query })}
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
              <CommitRow key={c.id} commit={c} nowMs={nowMs} />
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
            style={{ padding: '6px 8px', color: 'var(--status-needs-input-ink)', fontSize: 11 }}
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
function CommitRow(props: { commit: GitCommitDto; nowMs: number }): React.JSX.Element {
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
      style={{
        display: 'flex',
        gap: 6,
        alignItems: 'center',
        padding: '4px 8px',
        fontSize: 11,
        color: 'var(--text)',
        // ⚠️ `--border-faint` DOES NOT EXIST, so this used to be
        // `var(--border-faint, transparent)` and every row shipped with no
        // separator at all, in every theme (review). Nothing could have flagged
        // it: the drift test reads the token files, not inline styles.
        borderBlockEnd: '1px solid var(--border)',
        minInlineSize: 0,
      }}
    >
      {/* Item 3's lane gutter. Zero-width today; see LANE_GUTTER. */}
      {LANE_GUTTER > 0 && <span style={{ inlineSize: LANE_GUTTER, flexShrink: 0 }} aria-hidden="true" />}
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
          ? 'var(--status-needs-input-ink)'
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
