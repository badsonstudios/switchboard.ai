// Diff viewer pane (P1-E5-02): a file list with VCS badges, and the diff body
// beside it. One pane per session.
//
// ⚠️ **THE MONACO WIRING LEFT THIS FILE (E24 Git v2 item 5) AND NOTHING ABOUT IT
// CHANGED.** Design record §3 turns a diff into a dock panel, which means the
// same editor has two hosts: this tab's in-place preview and a `gitdiff-` panel. So
// the editor, the find publication (§5.31), the `diff-places` scroll memory, the
// theme handling and the narrow-pane verdict all moved to `MonacoDiff` —
// verbatim, comments and all, because each of those comments records a bug that
// was paid for once already. What is LEFT here is the thing a dock panel does not
// have: the file list, and the decision of which file to show.
import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { answered } from '../../../shared/ipc/refusal';
import { useTranslation } from 'react-i18next';
import {
  getDiffLayout,
  setDiffLayout,
  subscribeDiffLayout,
  type DiffLayout,
} from '../lib/diff-layout';
import { forgetDiffPlace, placeIsStillThere, readDiffPlace } from '../lib/diff-places';
import { type GitStatusDto } from '../lib/git-status';
import { MonacoDiff, type DiffLayoutState } from './MonacoDiff';
import { ScmSidebar } from './ScmSidebar';
import { putGitStatus } from '../lib/git-status-store';
import { canOpenDiffs, openDiff } from '../lib/diff-open';
import { WORKING_TREE_LEFT, WORKING_TREE_RIGHT } from '../lib/diff-panels';

export function DiffPane(props: {
  folder: string;
  /** Monaco has exactly two skins, so this takes the RESOLVED answer rather
   *  than a theme id it would have to guess a light/dark verdict from. */
  colorScheme: 'light' | 'dark';
  /** the card this pane belongs to — how Ctrl+F reaches THIS editor and no
   *  other (P2-E17-02). Absent on a card with no durable id: no registration,
   *  and the bar greys with a reason. */
  cardId?: string;
  /**
   * The card whose changes these are (P2-E16-03, §5.24).
   *
   * A Changes tab is a session's surface, so a file opened from one is opened
   * FROM that session and the viewer says so — an accent tint and a `↳ session`
   * chip. Optional because this pane is also rendered by tests and could one
   * day be pointed at a folder with no session behind it.
   */
  sessionId?: string;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [status, setStatus] = useState<GitStatusDto | null>(null);
  // Seeded from the place this card was last left (#562) — see lib/diff-places.
  const [selected, setSelected] = useState<string | null>(
    () => readDiffPlace(props.cardId)?.selected ?? null
  );
  // Workspace-wide, not per-card (#532): "how I read a diff" is a habit, not a
  // property of one session, and the palette command has no card in hand. Read
  // here as well as in the body, because the TOGGLE's pressed state is the
  // PREFERENCE while the body draws the EFFECTIVE layout — and the whole of #532
  // is that those two can legitimately differ.
  const layoutPref = useSyncExternalStore(subscribeDiffLayout, getDiffLayout);
  /**
   * Bumped by the sidebar's ⟲ to re-ask main.
   *
   * ⚠️ **A COUNTER, NOT A BOOLEAN OR A CALLBACK.** The status read is an effect
   * keyed on the folder; a refresh is "run that effect again", and a counter in
   * its deps is the only spelling of that which cannot miss two presses in a row.
   * There is no watcher on a repository — the same trade the Files tab makes — so
   * this is the whole of the manual refresh story.
   */
  const [refreshes, setRefreshes] = useState(0);

  useEffect(() => {
    // ⚠️ **CANCELLED ON FOLDER CHANGE AND ON REFRESH (found in review).** Without
    // it, two quick ⟲ presses start two reads — a status plus two diffs each —
    // whose durations differ, and WHICHEVER FINISHES LAST WINS, which can be the
    // older snapshot. A folder change mid-flight applied the previous folder's
    // status, and its `setSelected` reconciliation, to the new one. The sibling
    // reader of this same channel in `SessionGrid` has carried this flag all
    // along; the refresh button is what made the race reachable by a user in one
    // second.
    let cancelled = false;
    // `true` — ASK FOR THE NUMBERS (item 7). This tab is the one that draws them,
    // and the two extra `git diff` invocations are why the card header's poll
    // leaves the flag off. See `GitStatus.stats`.
    void window.switchboard.git.status(props.folder, true).then((s) => {
      if (cancelled) return;
      // `answered` BEFORE the cast (#650). `git:status` is declared
      // `Promise<unknown>`, so this cast is the only thing between the wire and
      // a typed record — and the brand cast into `GitStatusDto` becomes the
      // pane's `status`. The file list then reads `status.files.map` on the
      // next render; the `setSelected` block below reaches `next.files.map`
      // too, though only when a file was already selected. Either way it is a
      // throw inside a `.then` driven with `void`.
      //
      // Fail-open is to learn nothing: the pane keeps the status it had, which
      // on first mount is `null` — an EMPTY pane (the "no changes" copy is
      // gated behind `isRepo`, so it does not appear), not a crash and not a
      // lie about the working tree.
      const next = answered(s) as GitStatusDto | undefined;
      if (!next) return;
      setStatus(next);
      // ⚠️ **AND SHARE IT, so the Files tab draws THIS answer (E24 Git v2 item
      // 11).** Design §4 item 11 asks for "the same status source", and this is
      // the half that makes it a shared MOMENT rather than merely a shared shape:
      // this tab's read includes the per-file numbers, so handing it to the store
      // means the tree's badges and the sidebar's rows cannot disagree about
      // whether a file is modified — and no second `git status` is spent.
      putGitStatus(props.folder, next);
      // A REMEMBERED FILE IS ONLY AS GOOD AS THE CHANGE UNDER IT (#562 review).
      // Between leaving the tab and coming back, the change can have been
      // committed, discarded or the file deleted — and `git.fileVersions` does
      // not fail for any of those, it returns EMPTY STRINGS. Restoring it would
      // paint a blank two-pane diff with no row highlighted and nothing on
      // screen saying why, which reads as breakage. Drop it and start clean.
      setSelected((cur) => {
        if (!cur) return cur;
        const paths = next.files.map((f) => f.path);
        if (placeIsStillThere({ selected: cur, line: 1 }, paths)) return cur;
        // ⚠️ `pendingLine.current = null` stood here and MOVED WITH THE EDITOR
        // (E24 Git v2 item 5). `forgetDiffPlace` is what the body reads its
        // remembered line from, so clearing the record is what clears the
        // pending restore — the ref was belt to that braces and is now inside
        // `MonacoDiff`, which is also where it is consumed.
        forgetDiffPlace(props.cardId);
        return null;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [props.folder, props.cardId, refreshes]);

  /**
   * What the body is drawing, as the body reported it.
   *
   * ⚠️ **REPORTED UP RATHER THAN DERIVED HERE, and the narrow verdict is why.**
   * The effective layout depends on the editor's own measured width — which is
   * not the card's width, because the sidebar takes its 240px off the front first —
   * so only the body can know it. The toolbar below needs the answer to label a
   * toggle whose pressed state is sometimes not what is on screen (#532), and a
   * second measurement up here would be a second answer that could disagree.
   */
  const [body, setBody] = useState<DiffLayoutState>({ layout: 'side-by-side', narrowed: false });
  const narrowed = body.narrowed;

  // ⚠️ `gitPaneState` AND THE BADGE WORDS MOVED TO `ScmSidebar` (items 6 and 7).
  // The three-state decision belongs with the list that draws it, and the badge
  // was `mod` / `staged` / `both` / `new` in 9px mono — design §1.2 cause 1, the
  // ONLY thing distinguishing four kinds of change. It is a coloured letter in a
  // named group now, which is git's own vocabulary and a shape every git GUI uses.

  return (
    <div style={{ blockSize: '100%', display: 'flex', background: 'var(--card-bg)' }}>
      {/* The sidebar (E24 Git v2 items 6 and 7). Was a flat 200px list of full
          relative paths with a word chip — the owner's "everything's kind of just
          smashed together". `ScmSidebar` owns the groups, the rows, the header and
          the totals; this pane owns which file the body is showing. */}
      <ScmSidebar
        folder={props.folder}
        status={status}
        selected={selected}
        onSelect={setSelected}
        sessionId={props.sessionId}
        cardId={props.cardId}
        onRefresh={() => setRefreshes((n) => n + 1)}
      />
      <div style={{ flex: 1, minInlineSize: 0, display: 'flex', flexDirection: 'column' }}>
        {/* §5.32 rule 1: real `<button>`s, so Enter, Space, focus and the
            announcement all come from the platform. NOT a `radiogroup` — the
            pair is styled and behaves exactly like the document viewer's
            Rendered/Source toggle, and a composite role would oblige a roving
            tabindex and arrow keys the surface does not implement (rule 3:
            composite roles only where they are true). A plain `group` with a
            name is what both of them earn: it names the pair without taking
            over the buttons inside it. */}
        <div className="diff-toolbar" role="group" aria-label={t('diff.layoutLabel')}>
          {/* VISIBLE, not just a tooltip: Chromium never shows `title` on
              keyboard focus, so a sighted keyboard user would have had no way
              at all to learn why the pressed button is not what is on screen. */}
          {narrowed && <span className="diff-narrow-note">{t('diff.tooNarrowNote')}</span>}
          {(['side-by-side', 'inline'] as const).map((mode: DiffLayout) => {
            // the ONE case where the pressed button is not what is on screen:
            // say why, rather than let it read as a control that does nothing
            const reason = mode === 'side-by-side' && narrowed ? t('diff.tooNarrow') : undefined;
            return (
              <button
                key={mode}
                type="button"
                className="diff-btn"
                data-testid={`diff-layout-${mode}`}
                aria-pressed={layoutPref === mode}
                aria-label={reason}
                title={reason}
                onClick={() => setDiffLayout(mode)}
              >
                {t(mode === 'side-by-side' ? 'diff.sideBySide' : 'diff.inline')}
              </button>
            );
          })}
          {/* ⧉ — THE ESCALATION, AND DESIGN §3 IS EXPLICIT THAT IT IS NOT THE
              ONLY ROUTE: *"The Changes tab KEEPS an in-place preview (◫) — ⧉ is
              the escalation."* So this sits beside the layout toggle rather than
              replacing the click that selects a file, and the tab keeps working
              exactly as it did for anyone who never presses it.

              It is the owner's actual request: read a diff while watching the
              conversation that produced it. Card tabs are mutually exclusive, so
              inside this tab that is impossible however the pane is drawn.

              ⚠️ **ABSENT, NOT DISABLED, WHEN THERE IS NOWHERE TO OPEN ONE.**
              `canOpenDiffs()` is false before the grid installs its opener and in
              a test with no grid at all. The owner's rule — *a row with a `＋`
              that does nothing is worse than a row with no `＋`* — says a button
              with no destination should not be drawn, and here it costs nothing
              to leave out because the in-place preview is already the answer. */}
          {/* ⚠️ `canOpenDiffs()` IS READ DURING RENDER AND IS NOT REACTIVE, which
              is safe only because of the `selected &&` in front of it: the opener
              is installed by `App`'s mount effect, and nothing can have picked a
              file before that. Said out loud because the next person to drop the
              `selected` guard would make the button disappear for the life of the
              pane and have no idea why (review). */}
          {selected && canOpenDiffs() && (
            <button
              type="button"
              className="diff-btn"
              data-testid="diff-popout"
              title={t('diff.openInPanel', { file: selected })}
              aria-label={t('diff.openInPanel', { file: selected })}
              onClick={() =>
                openDiff({
                  folder: props.folder,
                  path: selected,
                  left: WORKING_TREE_LEFT,
                  right: WORKING_TREE_RIGHT,
                  sessionId: props.sessionId,
                })
              }
            >
              {t('diff.openInPanelIcon')}
            </button>
          )}
        </div>
        {/* The diff body — the same `MonacoDiff` a `gitdiff-` dock panel hosts.
            `findSlot` is the default (`'diff'`), which is the key Ctrl+F has
            looked for on this tab since P2-E17-02; the panel uses its own. */}
        <div style={{ flex: 1, minBlockSize: 0, display: 'flex' }}>
          <MonacoDiff
            source={{ kind: 'working-tree', folder: props.folder, path: selected }}
            colorScheme={props.colorScheme}
            cardId={props.cardId}
            placeKey={props.cardId}
            onLayout={setBody}
          />
        </div>
      </div>
    </div>
  );
}
