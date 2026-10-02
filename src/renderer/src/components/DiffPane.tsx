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
import { openDocument } from '../lib/document-open';
import { forgetDiffPlace, placeIsStillThere, readDiffPlace } from '../lib/diff-places';
import { gitPaneState, type GitFileDto, type GitStatusDto } from '../lib/git-status';
import { MonacoDiff, type DiffLayoutState } from './MonacoDiff';
import { canOpenDiffs, openDiff } from '../lib/diff-open';
import { WORKING_TREE_LEFT, WORKING_TREE_RIGHT } from '../lib/diff-panels';

/**
 * `folder` + git's forward-slash relative path, in the folder's own spelling.
 *
 * git reports `src/main/index.ts` on every platform; main resolves whatever it
 * is handed, so the only thing that matters is that the two halves are joined
 * with a separator the OS will accept — and both accept `/` on Windows.
 */
function joinPath(folder: string, relative: string): string {
  const sep = folder.includes('\\') && !folder.includes('/') ? '\\' : '/';
  return `${folder.replace(/[\\/]+$/, '')}${sep}${relative}`;
}

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

  useEffect(() => {
    void window.switchboard.git.status(props.folder).then((s) => {
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
  }, [props.folder, props.cardId]);

  /**
   * What the body is drawing, as the body reported it.
   *
   * ⚠️ **REPORTED UP RATHER THAN DERIVED HERE, and the narrow verdict is why.**
   * The effective layout depends on the editor's own measured width — which is
   * not the card's width, because this list takes its 200px off the front first —
   * so only the body can know it. The toolbar below needs the answer to label a
   * toggle whose pressed state is sometimes not what is on screen (#532), and a
   * second measurement up here would be a second answer that could disagree.
   */
  const [body, setBody] = useState<DiffLayoutState>({ layout: 'side-by-side', narrowed: false });
  const narrowed = body.narrowed;

  const paneState = gitPaneState(status);

  const badge = (f: GitFileDto): string =>
    f.untracked ? t('diff.badge.new') : f.staged && f.unstaged ? t('diff.badge.both') : f.staged ? t('diff.badge.staged') : t('diff.badge.modified');

  return (
    <div style={{ blockSize: '100%', display: 'flex', background: 'var(--card-bg)' }}>
      <div
        style={{
          inlineSize: 200,
          borderInlineEnd: '1px solid var(--border)',
          overflowY: 'auto',
          padding: 6,
          fontSize: 11,
        }}
      >
        {/* ONE decision, in `lib/git-status` — see `gitPaneState` for why
            `unreadable` has to be checked before `clean` and not after. */}
        {paneState?.kind === 'unreadable' && (
          // The attention ink, not `--muted`: this is something being WRONG,
          // where the other two are ordinary facts about a folder. Same token
          // the dirty-count uses on the card header, which #246 contrast-checked
          // for text on this surface.
          <div style={{ color: 'var(--status-needs-input-ink)' }}>
            {t('diff.unreadable', { reason: paneState.reason })}
          </div>
        )}
        {paneState?.kind === 'not-repo' && (
          <div style={{ color: 'var(--muted)' }}>{t('diff.notRepo')}</div>
        )}
        {paneState?.kind === 'clean' && (
          <div style={{ color: 'var(--muted)' }}>{t('diff.clean')}</div>
        )}
        {/* GATED ON THE SAME DECISION, so "the pane renders from `gitPaneState`
            and from nothing else" is true rather than nearly true (review nit).
            Harmless today — `unreadable` always ships `files: []` — but an
            unreadable answer that somehow carried files would otherwise draw
            the reason AND a file list under it. */}
        {paneState?.kind === 'files' &&
          status?.files.map((f) => (
          <div
            key={f.path}
            onClick={() => setSelected(f.path)}
            style={{
              display: 'flex',
              gap: 6,
              alignItems: 'center',
              padding: '4px 6px',
              borderRadius: 4,
              cursor: 'pointer',
              background: selected === f.path ? 'var(--rail-row-selected)' : 'transparent',
              color: 'var(--text)',
            }}
          >
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'var(--font-mono)', fontSize: 10 }}>
              {f.path}
            </span>
            {/* §5.30's "opened from wherever a path already appears", as its
                OWN control rather than as the path's click target.

                The plan line reads "a path click in the Changes tab's file
                list", and the literal reading was written and then withdrawn:
                the whole row already means "show me this file's diff", and
                turning the file NAME — nearly all of the row — into "open the
                whole file somewhere else" leaves the tab's primary gesture with
                a status badge to aim at, and sends a user who wanted a diff to
                a different panel. That is the calm check failing on a surface
                that was fine. The viewer is a SECOND question about the same
                row ("never mind the change, what does this file say now?"), so
                it gets a second, labelled control. */}
            <button
              type="button"
              className="diff-open-viewer"
              title={t('diff.openInViewer', { file: f.path })}
              aria-label={t('diff.openInViewer', { file: f.path })}
              onClick={(e) => {
                // the row's own handler would select it into the diff as well —
                // harmless, but two things happening from one click reads as a
                // bug even when both are wanted
                e.stopPropagation();
                openDocument(joinPath(props.folder, f.path), props.sessionId);
              }}
              style={{
                background: 'transparent',
                border: 'none',
                color: 'var(--muted)',
                cursor: 'pointer',
                fontSize: 10,
                lineHeight: 1,
                padding: '0 2px',
              }}
            >
              {t('diff.openInViewerIcon')}
            </button>
            <span
              style={{
                fontSize: 9,
                fontFamily: 'var(--font-mono)',
                color: f.untracked ? 'var(--diff-added)' : 'var(--muted)',
                background: 'var(--chip)',
                borderRadius: 4,
                paddingInline: 4,
              }}
            >
              {badge(f)}
            </span>
          </div>
        ))}
      </div>
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
