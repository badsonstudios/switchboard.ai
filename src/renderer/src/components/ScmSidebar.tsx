// The source-control sidebar (E24 Git v2 items 6 and 7, §5.7) — screen 1.
//
// ⚠️ **THIS REPLACES A FLAT 200px LIST, AND THE OWNER'S WORDS FOR THAT LIST WERE
// "everything's kind of just smashed together".** Design record §1.2 names four
// causes in weight order; this file is the answer to three of them:
//
//  1. **No resource groups** — staged, unstaged, untracked and conflicted were one
//     undifferentiated list, told apart only by a three-letter word chip in 9px
//     mono. Now: four collapsible groups, each with its own count and its own
//     actions, in VS Code's own `scmResourceGroup` vocabulary.
//  2. **The path truncated the wrong end** — the rail cut off the basename, which
//     is the only part that identifies a file. Now: name first, directory dimmed
//     after it, and the directory is what is allowed to be lost.
//  4. **The header said nothing** — `GitStatus` has carried `branch`, `ahead` and
//     `behind` since it was written and NO CONSUMER HAD EVER READ ONE OF THEM.
//     Now the header reads all three, and a totals bar reads the numbers item 7
//     added.
//
// Cause 3 ("nowhere to put a diff but inside the tab") was item 5, and the ⧉ on
// each row is what reaches it.
//
// The grouping, the letters and the totals are all `lib/scm-groups.ts` — pure, and
// tested as rules. What is here is paint, keys, and which verbs exist.
import React from 'react';
import { useTranslation } from 'react-i18next';
import { gitPaneState, type GitStatusDto } from '../lib/git-status';
import {
  buildGroups,
  letterKey,
  scmTotals,
  type ScmGroupKind,
  type ScmRow,
} from '../lib/scm-groups';
import { canOpenDiffs, openDiff } from '../lib/diff-open';
import { WORKING_TREE_LEFT, WORKING_TREE_RIGHT } from '../lib/diff-panels';
import { openDocument } from '../lib/document-open';
import { canShowFileHistory, requestFileHistory } from '../lib/file-history';

/**
 * The ink a status letter wears.
 *
 * Tokens that exist — checked, because item 2's review found two invented custom
 * properties that had shipped and failed in total silence. The standing check is
 * in `ScmSidebar.test.tsx`; the drift test reads the token FILES and cannot see an
 * inline style, so this is the only place the two sides are compared.
 */
export const LETTER_INKS: Record<string, string> = {
  A: '--diff-added',
  D: '--diff-removed',
  M: '--accent-amber',
  R: '--accent-violet',
  C: '--accent-violet',
  // untracked — the most harmless row there is, so the calmest ink
  U: '--accent-teal',
  // a conflict, which is the one row that blocks everything
  '!': '--status-crashed-ink',
  // a TYPE change: a file replaced by a symlink or a directory. Named because it
  // fell through to `--muted` — indistinguishable from "no colour at all".
  T: '--accent-orange',
};

function letterInk(letter: string): string {
  return `var(${LETTER_INKS[letter] ?? '--muted'})`;
}

/**
 * `folder` + git's forward-slash relative path, in the folder's own spelling.
 *
 * git reports `src/main/index.ts` on every platform; main resolves whatever it is
 * handed, so the only thing that matters is that the two halves are joined with a
 * separator the OS will accept — and both accept `/` on Windows.
 */
function joinPath(folder: string, relative: string): string {
  const sep = folder.includes('\\') && !folder.includes('/') ? '\\' : '/';
  return `${folder.replace(/[\\/]+$/, '')}${sep}${relative}`;
}

export function ScmSidebar(props: {
  folder: string;
  status: GitStatusDto | null;
  /** the path currently shown in the diff body, or null */
  selected: string | null;
  onSelect: (path: string) => void;
  /** the card this sidebar belongs to, for §5.24 attribution on an open */
  sessionId?: string;
  /** ask main again — the ⟲ in the header */
  onRefresh: () => void;
  /** the card, so ⏱ can send this file's history to the History tab (item 10) */
  cardId?: string;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [filter, setFilter] = React.useState('');
  /**
   * Which groups are folded shut.
   *
   * A SET OF THE CLOSED ones, so a group that appears later — a conflict arriving
   * mid-merge — is open by default. Keyed by kind and not by index, because the
   * groups that exist change as the working tree does.
   */
  const [closed, setClosed] = React.useState<Set<ScmGroupKind>>(() => new Set());
  const paneState = gitPaneState(props.status);
  const groups = React.useMemo(() => buildGroups(props.status, filter), [props.status, filter]);
  /**
   * The status narrowed to what the filter leaves, so the totals describe the list.
   *
   * Built from the groups' own rows rather than by filtering again: two filters
   * over one query is two chances to disagree.
   */
  const filtered = React.useMemo((): GitStatusDto | null => {
    if (!props.status) return null;
    if (filter.trim() === '') return props.status;
    const shown = new Set(groups.flatMap((g) => g.rows.map((r) => r.path)));
    return { ...props.status, files: props.status.files.filter((f) => shown.has(f.path)) };
  }, [props.status, filter, groups]);
  /**
   * The totals, over the FILTERED list.
   *
   * ⚠️ **IT USED TO BE THE UNFILTERED STATUS (found in review), so typing a query
   * that matched nothing left the bar reading `+400 −200 · 18 files` directly above
   * "No changed file matches". The third instance in this epic of a thing rendering
   * beside a state it contradicts — and the same fix each time: compute it from
   * what is on screen.
   */
  const totals = React.useMemo(
    () => scmTotals(filtered),
    [filtered]
  );
  const filtering = filter.trim() !== '';

  return (
    <div
      className="scm-sidebar"
      style={{
        inlineSize: 240,
        flexShrink: 0,
        borderInlineEnd: '1px solid var(--border)',
        display: 'flex',
        flexDirection: 'column',
        fontSize: 11,
        minInlineSize: 0,
      }}
    >
      {/* ⚠️ THE HEADER READS `branch`, `ahead` AND `behind` — three fields
          `GitStatus` has carried since it was written and which, per design
          §1.2 cause 4, NO CONSUMER HAD EVER READ. They come from porcelain v2's
          `# branch.ab` line, which means the `rev-list --left-right --count`
          the design record asks for is not needed at all: status already
          answers it, and a second source could only disagree with this one. */}
      <div
        className="scm-head"
        style={{
          display: 'flex',
          gap: 6,
          alignItems: 'center',
          padding: '5px 6px',
          borderBlockEnd: '1px solid var(--border)',
        }}
      >
        {props.status?.branch && (
          <span
            className="scm-branch"
            style={{
              fontFamily: 'var(--font-mono)',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              minInlineSize: 0,
            }}
            title={props.status.branch}
          >
            {t('scm.branch', { branch: props.status.branch })}
          </span>
        )}
        {/* ⚠️ ABSENT when there is no upstream, and ZERO is also absent — two
            different facts that both draw nothing, kept apart in the data (see
            `syncCounts`) so a later "set an upstream" surface can tell. */}
        {(props.status?.ahead ?? 0) > 0 && (
          <span
            className="scm-ahead"
            style={{ flexShrink: 0, fontFamily: 'var(--font-mono)', color: 'var(--status-needs-input-ink)' }}
            title={t('scm.aheadTitle', { count: props.status?.ahead ?? 0 })}
          >
            {t('scm.ahead', { count: props.status?.ahead ?? 0 })}
          </span>
        )}
        {(props.status?.behind ?? 0) > 0 && (
          <span
            className="scm-behind"
            style={{ flexShrink: 0, fontFamily: 'var(--font-mono)', color: 'var(--muted)' }}
            title={t('scm.behindTitle', { count: props.status?.behind ?? 0 })}
          >
            {t('scm.behind', { count: props.status?.behind ?? 0 })}
          </span>
        )}
        <span style={{ flex: 1 }} />
        <button
          type="button"
          className="diff-btn"
          data-testid="scm-refresh"
          title={t('scm.refresh')}
          aria-label={t('scm.refresh')}
          onClick={props.onRefresh}
        >
          {t('scm.refreshIcon')}
        </button>
      </div>

      {/* The totals bar. ⚠️ `partial` is why the wording can say "at least": a
          binary file or an untracked one has no line count, and a bar implying a
          total it cannot know is the small untruth that costs trust in the big
          numbers. */}
      {paneState?.kind === 'files' && (
        <div
          className="scm-totals"
          style={{
            display: 'flex',
            gap: 6,
            alignItems: 'center',
            padding: '3px 6px',
            borderBlockEnd: '1px solid var(--border)',
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            color: 'var(--muted)',
          }}
        >
          {/* ⚠️ **NO NUMBERS WHEN THERE ARE NONE (found in review).** With every
              file uncounted — an all-untracked tree, a tree of conflicts, a failed
              stats read — both totals are 0, and a bar reading `+0 −0` is the same
              "absent is not zero" lie the ROWS below it get right. */}
          {totals.counted && (
            <>
              <span style={{ color: 'var(--diff-added)' }}>{t('scm.plus', { n: totals.insertions })}</span>
              <span style={{ color: 'var(--diff-removed)' }}>{t('scm.minus', { n: totals.deletions })}</span>
            </>
          )}
          <span style={{ flex: 1 }} />
          <span className="scm-filecount">
            {totals.partial
              ? t('scm.filesAtLeast', { count: totals.files })
              : t('scm.files', { count: totals.files })}
          </span>
        </div>
      )}

      {paneState?.kind === 'files' && (
        <div style={{ padding: '4px 6px', borderBlockEnd: '1px solid var(--border)' }}>
          <input
            type="search"
            className="scm-filter"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={t('scm.filterPlaceholder')}
            aria-label={t('scm.filterLabel')}
            style={{
              inlineSize: '100%',
              background: 'var(--input-bg, var(--card-bg))',
              color: 'var(--text)',
              border: '1px solid var(--border)',
              borderRadius: 4,
              padding: '2px 6px',
              fontSize: 11,
            }}
          />
        </div>
      )}

      <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', minBlockSize: 0, padding: 4 }}>
        {/* ONE decision, in `lib/git-status` — see `gitPaneState` for why
            `unreadable` has to be checked before `clean` and not after. */}
        {paneState?.kind === 'unreadable' && (
          // The attention ink, not `--muted`: this is something being WRONG, where
          // the other two are ordinary facts about a folder.
          <div style={{ color: 'var(--status-needs-input-ink)', padding: 4 }}>
            {t('diff.unreadable', { reason: paneState.reason })}
          </div>
        )}
        {paneState?.kind === 'not-repo' && (
          <div style={{ color: 'var(--muted)', padding: 4 }}>{t('diff.notRepo')}</div>
        )}
        {paneState?.kind === 'clean' && (
          <div style={{ color: 'var(--muted)', padding: 4 }}>{t('diff.clean')}</div>
        )}
        {paneState?.kind === 'files' && filtering && groups.length === 0 && (
          <div className="scm-no-match" style={{ color: 'var(--muted)', padding: 4 }}>
            {t('scm.noMatches', { query: filter })}
          </div>
        )}
        {paneState?.kind === 'files' &&
          groups.map((group) => {
            const isClosed = closed.has(group.kind);
            return (
              <div key={group.kind} className={`scm-group scm-group-${group.kind}`}>
                <button
                  type="button"
                  className="scm-group-head"
                  aria-expanded={!isClosed}
                  onClick={() =>
                    setClosed((prev) => {
                      const next = new Set(prev);
                      if (next.has(group.kind)) next.delete(group.kind);
                      else next.add(group.kind);
                      return next;
                    })
                  }
                  style={{
                    display: 'flex',
                    gap: 5,
                    alignItems: 'center',
                    inlineSize: '100%',
                    background: 'transparent',
                    border: 'none',
                    color: group.kind === 'merge' ? 'var(--status-crashed-ink)' : 'var(--text)',
                    cursor: 'pointer',
                    padding: '3px 4px',
                    fontSize: 10.5,
                    fontWeight: 600,
                    textAlign: 'left',
                  }}
                >
                  <span aria-hidden="true" style={{ color: 'var(--muted)' }}>
                    {isClosed ? t('scm.caretClosed') : t('scm.caretOpen')}
                  </span>
                  <span style={{ flex: 1, minInlineSize: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {t(`scm.group.${group.kind}`)}
                  </span>
                  <span
                    className="scm-group-count"
                    style={{ flexShrink: 0, color: 'var(--muted)', fontFamily: 'var(--font-mono)' }}
                  >
                    {group.rows.length}
                  </span>
                </button>
                {!isClosed &&
                  group.rows.map((row) => (
                    <Row
                      key={`${group.kind}:${row.path}`}
                      row={row}
                      folder={props.folder}
                      sessionId={props.sessionId}
                      selected={props.selected === row.path}
                      onSelect={props.onSelect}
                      cardId={props.cardId}
                    />
                  ))}
              </div>
            );
          })}
      </div>
    </div>
  );
}

/**
 * One file.
 *
 * ⚠️ **A `<button>`, NOT A CLICKABLE `<div>` — §5.32 rule 1.** The old row was a
 * div with an `onClick`, which meant Enter, Space, focus and the announcement all
 * had to be reimplemented and none of them were: the file list was unreachable by
 * keyboard. A real button gets all four from the platform.
 *
 * ⚠️ **AND THE NAME COMES FIRST.** Design §1.2 cause 2: the directory is the part
 * allowed to truncate, because the basename is the only part that identifies the
 * file.
 */
function Row(props: {
  row: ScmRow;
  folder: string;
  sessionId?: string;
  selected: boolean;
  onSelect: (path: string) => void;
  cardId?: string;
}): React.JSX.Element {
  const { t } = useTranslation();
  const row = props.row;
  const statusWord = t(`scm.letter.${letterKey(row.letter)}`);
  return (
    <div
      className="scm-row"
      data-path={row.path}
      style={{
        display: 'flex',
        gap: 4,
        alignItems: 'center',
        borderRadius: 4,
        background: props.selected ? 'var(--rail-row-selected)' : 'transparent',
        minInlineSize: 0,
      }}
    >
      <button
        type="button"
        className="scm-row-open"
        // The whole path, because the row shows the directory truncated and the
        // tail of a long directory is sometimes the question.
        title={row.path}
        // ⚠️ TWO KEYS, because a root-level file has no directory and the one-key
        // version interpolated the empty string: "README.md in , modified"
        // (review). The visible span was already omitted; the label was not.
        aria-label={
          row.dir === ''
            ? t('scm.rowLabelRoot', { name: row.name, status: statusWord })
            : t('scm.rowLabel', { name: row.name, dir: row.dir, status: statusWord })
        }
        // `aria-current`, not `aria-pressed`: this row is not a toggle, it is the
        // one being shown — which is what `current` means (review).
        aria-current={props.selected ? 'true' : undefined}
        onClick={() => props.onSelect(row.path)}
        style={{
          flex: 1,
          minInlineSize: 0,
          display: 'flex',
          gap: 5,
          alignItems: 'baseline',
          background: 'transparent',
          border: 'none',
          color: 'var(--text)',
          cursor: 'pointer',
          padding: '3px 4px',
          fontSize: 11,
          textAlign: 'left',
        }}
      >
        <span
          // ⚠️ KEYED ON THE WORD, NOT THE GLYPH. `!` is not a valid CSS class
          // character, so `scm-letter-!` was an invalid selector — found the
          // moment a test tried to use it. The word is also what a reader of the
          // test wants to see.
          className={`scm-letter scm-letter-${letterKey(row.letter)}`}
          aria-hidden="true"
          style={{
            flexShrink: 0,
            inlineSize: 10,
            textAlign: 'center',
            color: letterInk(row.letter),
            fontFamily: 'var(--font-mono)',
            fontWeight: 600,
            fontSize: 10,
          }}
        >
          {row.letter}
        </span>
        <span
          className="scm-name"
          style={{ flexShrink: 0, maxInlineSize: '60%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        >
          {row.name}
        </span>
        {/* The directory, and it is the part allowed to disappear. `direction:
            rtl` truncates the FRONT of it, so what survives is the folder the
            file is actually in rather than `src/renderer/src/…`.

            ⚠️ **NOT RENDERED AT ALL for a file at the repository root.** The
            bidi isolates the path goes through are real characters, so an empty
            directory produced a span containing two invisible code points — which
            is an empty box in the layout and, worse, something a text selector
            matches. Found by an e2e asserting on a sibling span. */}
        {row.dir !== '' && (
        <span
          className="scm-dir"
          style={{
            flex: 1,
            minInlineSize: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            direction: 'rtl',
            textAlign: 'left',
            color: 'var(--muted)',
            fontSize: 10,
          }}
        >
          {t('diff.pathIsolated', { path: row.dir })}
        </span>
        )}
      </button>
      {/* ⚠️ **THE NUMBERS AND THE ACTIONS SHARE ONE SLOT**, which is VS Code's
          `inline@1` / `inline@2` arrangement and design §2.1's note: the row stays
          readable at rest, and the verbs appear when you reach for them. Done with
          CSS hover/focus-within rather than React state so it costs no render —
          and `focus-within` is what makes it reachable by keyboard, which a
          hover-only rule would not be. */}
      <span className="scm-row-rest" style={{ flexShrink: 0, display: 'flex', alignItems: 'center' }}>
        <span className="scm-row-stat" style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5, paddingInlineEnd: 4 }}>
          {row.stat === null ? (
            ''
          ) : row.stat.binary ? (
            <span style={{ color: 'var(--muted)' }} title={t('scm.binaryTitle')}>
              {t('scm.binary')}
            </span>
          ) : (
            <>
              <span style={{ color: 'var(--diff-added)' }}>{t('scm.plus', { n: row.stat.insertions })}</span>{' '}
              <span style={{ color: 'var(--diff-removed)' }}>{t('scm.minus', { n: row.stat.deletions })}</span>
            </>
          )}
        </span>
        {/* ⚠️ **NO INLINE `display` HERE, AND THE FIRST VERSION HAD ONE (found in
            review).** An inline style outranks any author stylesheet rule without
            `!important`, so `.scm-row-acts { display: none }` NEVER APPLIED: the
            verbs were painted on every row at rest, and hovering removed the
            numbers and added nothing — the slot was doubled at rest and halved on
            hover, which is the exact opposite of the arrangement the comment above
            describes. The layout lives in the class now. */}
        <span className="scm-row-acts">
          {/* ⧉ — item 5's panel, from the row rather than from the toolbar, which
              is where screen 1 draws it. ABSENT when there is nowhere to open one;
              the owner's rule about a control that does nothing. */}
          {canOpenDiffs() && (
            <button
              type="button"
              className="scm-act"
              data-testid="scm-row-popout"
              title={t('diff.openInPanel', { file: row.path })}
              aria-label={t('diff.openInPanel', { file: row.path })}
              onClick={() =>
                openDiff({
                  folder: props.folder,
                  path: row.path,
                  left: WORKING_TREE_LEFT,
                  right: WORKING_TREE_RIGHT,
                  sessionId: props.sessionId,
                })
              }
            >
              {t('diff.openInPanelIcon')}
            </button>
          )}
          {/* ⏱ — this file's history (item 10). It pins the History tab to this
              path and switches to it; the chip there is how you get back. ABSENT
              when there is no card to switch or nowhere to switch it, which is the
              owner's rule about a control with nothing to do.

              TWO THINGS ABOUT THIS, BOTH NOTED IN REVIEW AND BOTH DELIBERATE:

              `canShowFileHistory()` is read during render with no subscription,
              so a Changes tab that renders before `App`'s mount effect installs
              the opener draws no ⏱ and heals on the next render (the status
              fetch). `canOpenDiffs()` two buttons up has had exactly this shape
              since item 5; a subscription for a value that flips once per
              renderer lifetime would be machinery for nothing.

              And the boolean `requestFileHistory` returns is DISCARDED on
              purpose. It is false only when the grid itself threw, and in that
              case the pin still stands (the module's own test pins that), so the
              user who switches tabs by hand still gets the answer. Saying
              something would mean a toast about an internal failure the user
              cannot act on. The silence is the decision, not an oversight. */}
          {props.cardId && canShowFileHistory() && (
            <button
              type="button"
              className="scm-act"
              data-testid="scm-row-history"
              title={t('scm.fileHistory', { file: row.path })}
              aria-label={t('scm.fileHistory', { file: row.path })}
              onClick={() => requestFileHistory(props.cardId, props.folder, row.path)}
            >
              {t('scm.fileHistoryIcon')}
            </button>
          )}
          <button
            type="button"
            className="scm-act"
            title={t('diff.openInViewer', { file: row.path })}
            aria-label={t('diff.openInViewer', { file: row.path })}
            onClick={() => openDocument(joinPath(props.folder, row.path), props.sessionId)}
          >
            {t('diff.openInViewerIcon')}
          </button>
          {/* ⚠️ **NO `＋` AND NO `↶` YET, AND THAT IS THE OWNER'S OWN RULE.**
              Screen 1 draws stage and discard on every row; both need the
              `git.write` capability, which is item 12. *"A row with a `＋` that
              does nothing is worse than a row with no `＋`"* — so the slot is
              built, the two verbs that work are in it, and the two that do not are
              absent rather than drawn dead. */}
        </span>
      </span>
    </div>
  );
}
