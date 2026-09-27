// The Monaco half of the approval card's diff (P2-E22-01, #972, §5.16).
//
// ── WHY THIS IS ITS OWN FILE, AND WHY IT IS THE DEFAULT EXPORT ──────────────
//
// So it can be `React.lazy`-ed, and `ApprovalPreview` owns that wiring: the panes
// are the `Suspense` fallback, so a permission is readable and answerable in the
// frame it arrives whatever this module is doing.
//
// ⚠️ BE HONEST ABOUT WHAT THE LAZY BOUNDARY BUYS, because the obvious reading is
// wrong. It does NOT defer Monaco. `DiffPane` is a STATIC import in
// `extensibility/panels.tsx`, so monaco-editor is in the entry chunk and evaluated
// at startup already — measured, #972: this module's own chunk comes out at ~6 kB
// against a ~9.7 MB entry. What the boundary actually buys is the FAIL-OPEN half:
// a module that throws or fails to arrive lands in `ContributionBoundary`, which
// puts the panes back, instead of taking the card down with it. The arrival
// criterion is met, and it was already met before this item, for a reason that has
// nothing to do with this file.
//
// Making Monaco itself lazy is a real and separate win (it would move most of that
// entry chunk behind the first Changes tab). It is not this item, and doing it here
// by accident — by assuming this import was enough — would have shipped a comment
// that was false.
//
// A default export because `React.lazy` takes a module whose `default` is the
// component, and nothing else in this file is worth reaching from outside.
//
// ── THE EDITOR IS CREATED THE WAY `DiffPane` CREATES ITS OWN ────────────────
//
// Same entry point (`edcore.main` — #191: the bare `monaco-editor` entry drags in
// the rich TS/JSON/CSS/HTML language services, which demand their own workers and
// throw against the single plain one), same `defineDiffThemes` / `DIFF_THEME`,
// same `useInlineViewWhenSpaceIsLimited: false` so #532's measured narrow rule is
// OURS rather than Monaco's invisible 900px one. There is one way this app draws
// a diff, and a second one tuned by feel would drift.
//
// ── WHAT IS DIFFERENT FROM `DiffPane`, AND WHY ──────────────────────────────
//
// `DiffPane` reads two versions of a real file off git. This reads a `tool_use`
// payload that has not happened yet, so:
//
//   * there is no file on disk to compare against and no line numbering that
//     would mean anything — `old_string` is a fragment, so line 1 of this editor
//     is not line 1 of anything. Line numbers are OFF, and that is a correctness
//     decision rather than a cosmetic one: a number that looks like a file offset
//     and is not one is worse than no number.
//   * a `MultiEdit` is N changes and they arrive already joined by
//     `lib/approval-diff`, with a separator line present identically on both
//     sides. Monaco reads that as unchanged context and breaks its hunks exactly
//     on the change boundaries. The whole argument is in that module's
//     `separatorFor`; do not "simplify" the join without reading it.
//   * it is SMALL. A card's bar, not a tab. So no minimap, no overview ruler
//     lane, no folding, and a height that is a band rather than a pane.
import React from 'react';
import { useTranslation } from 'react-i18next';
import * as monaco from 'monaco-editor/esm/vs/editor/edcore.main';
import '../lib/monaco-languages';
// ⚠️ LOAD-BEARING, and the one import most likely to be read as decoration: a
// diff editor with no worker renders both sides and computes NO DIFF. This card
// can be the first Monaco surface a session ever asks for, so it cannot rely on
// `DiffPane` or `DocumentSource` having been mounted first.
import '../lib/monaco-worker';
import { languageForPath } from '../lib/diff-language';
import {
  effectiveDiffLayout,
  getDiffLayout,
  isTooNarrowForColumns,
  setDiffLayout,
  subscribeDiffLayout,
} from '../lib/diff-layout';
import { defineDiffThemes, DIFF_THEME } from '../lib/monaco-theme';
import {
  APPROVAL_DIFF_BLOCK_SIZE,
  joinHunks,
  lineCount,
  type ApprovalDiff,
} from '../lib/approval-diff';

export interface ApprovalDiffViewProps {
  diff: ApprovalDiff;
  /** Monaco has exactly two skins, so this takes the RESOLVED answer */
  colorScheme: 'light' | 'dark';
  /** the grouped band above the workspace — sizing only, never content */
  dense?: boolean;
}

export default function ApprovalDiffView(props: ApprovalDiffViewProps): React.JSX.Element {
  const { t } = useTranslation();
  const hostRef = React.useRef<HTMLDivElement | null>(null);
  const editorRef = React.useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  // Workspace-wide, not card-local (#532's reasoning): "how I read a diff" is a
  // habit, not a property of one permission. The Changes tab, the palette command
  // and this control are three ways to set one thing.
  const pref = React.useSyncExternalStore(subscribeDiffLayout, getDiffLayout);
  const [tooNarrow, setTooNarrow] = React.useState(false);
  const layout = effectiveDiffLayout(pref, tooNarrow);

  const { original, modified } = React.useMemo(() => joinHunks(props.diff), [props.diff]);
  const language = React.useMemo(() => languageForPath(props.diff.path), [props.diff.path]);

  // Create ONCE. Same reason as `DiffPane`: rebuilding a diff editor drops both
  // models and blanks the pane, and every property that changes below can be
  // changed in place.
  React.useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    // Here rather than at module load, and idempotent: `defineTheme` builds
    // monaco's theme service, which reaches for `CSS.escape`, and jsdom has no
    // `CSS` — a module-load call takes down every unit test that merely imports
    // this file. A theme also has to exist before `createDiffEditor` names it.
    defineDiffThemes(monaco.editor);
    const editor = monaco.editor.createDiffEditor(host, {
      readOnly: true,
      renderSideBySide: layout === 'side-by-side',
      useInlineViewWhenSpaceIsLimited: false, // #532 — ours, not Monaco's
      automaticLayout: true,
      minimap: { enabled: false },
      // See the header: a fragment has no file line numbers, so a number here
      // would be a lie that looks like an offset.
      lineNumbers: 'off',
      glyphMargin: false,
      folding: false,
      overviewRulerLanes: 0,
      scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
      // A permission body is prose-width at worst; horizontal scrolling beats
      // reflowing a diff, because a wrapped line changes which lines line up.
      wordWrap: 'off',
      theme: DIFF_THEME[props.colorScheme],
      // The reader cannot act on this editor, so nothing in it should look like
      // it invites a click.
      contextmenu: false,
      scrollBeyondLastLine: false,
    });
    editorRef.current = editor;
    return () => {
      const model = editor.getModel();
      editor.dispose();
      model?.original.dispose();
      model?.modified.dispose();
      editorRef.current = null;
    };
    // deliberately empty — `layout` and `colorScheme` are read for the first
    // paint and owned by the effects below from then on. (No lint suppression
    // needed: this repo does not run `react-hooks/exhaustive-deps`, and
    // `DiffPane`'s identical effect carries the same note and no directive.)
  }, []);

  // The models. Replaced rather than mutated: `setValue` on a model keeps its
  // language and its undo stack, and a different held request can be a different
  // file. The OLD pair is disposed after the swap, never before — a diff editor
  // reads its current model during `setModel`.
  React.useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const previous = editor.getModel();
    editor.setModel({
      // Same language on both sides: they are two versions of one thing, and a
      // mismatch would colour the before pane differently from the after.
      original: monaco.editor.createModel(original, language),
      modified: monaco.editor.createModel(modified, language),
    });
    previous?.original.dispose();
    previous?.modified.dispose();
  }, [original, modified, language]);

  // In place. Rebuilding for a toggle would blank the diff (see above).
  React.useEffect(() => {
    editorRef.current?.updateOptions({ renderSideBySide: layout === 'side-by-side' });
  }, [layout]);

  // `setTheme` and NOT `updateOptions`: monaco's standalone theme is per-PAGE, and
  // `IDiffEditorOptions` carries no `theme` at all — the option is only accepted at
  // construction. Global by design, and harmless: every editor in a window is
  // showing the same app theme anyway. Same call `DiffPane` makes, for the same
  // reason it rebuilds nothing on a theme switch.
  React.useEffect(() => {
    monaco.editor.setTheme(DIFF_THEME[props.colorScheme]);
  }, [props.colorScheme]);

  // #532's floor, measured on the EDITOR and not on the card: the same body
  // renders in a full-width card, a half-width one and the grouped band.
  React.useEffect(() => {
    const host = hostRef.current;
    // No ResizeObserver (jsdom, older embedders) leaves the verdict `false` and
    // the preference simply honoured — a degrade, not a break.
    if (!host || typeof ResizeObserver === 'undefined') return;
    const measure = (width: number): void => {
      // A width of 0 is NOT MEASURED — the first frame, and every frame this lives in
      // a hidden dockview panel. Treating it as narrow would flash one column on
      // mount and two on the way back.
      if (width > 0) setTooNarrow(isTooNarrowForColumns(width));
    };
    const ro = new ResizeObserver((entries) => measure(entries[0]?.contentRect.width ?? 0));
    ro.observe(host);
    // …and once now, the way `DiffPane` does. ResizeObserver does fire on observe, so
    // this is belt on braces — but the two copies of this pattern differing at all is
    // the drift this file's header argues against, and the cost is one read.
    measure(host.clientWidth);
    return () => ro.disconnect();
  }, []);

  // The same constant the Suspense fallback reserves — see its docblock for why
  // they must not disagree.
  const height =
    props.dense === true ? APPROVAL_DIFF_BLOCK_SIZE.dense : APPROVAL_DIFF_BLOCK_SIZE.roomy;

  return (
    <div data-approval-diff={props.diff.kind} style={{ marginBlockEnd: 5 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 6,
          fontSize: 10,
          color: 'var(--muted)',
          marginBlockEnd: 3,
        }}
      >
        <span data-approval-diff-caption>{caption(t, props.diff)}</span>
        <span style={{ flex: 1 }} />
        {/* ⚠️ THE SAME CONTROL THE CHANGES TAB HAS, DOWN TO THE CLASS NAMES, and the
            first version of this was a single toggle labelled with the EFFECTIVE
            layout — which is a dead button whenever the narrow floor is in force:
            it read "Inline", clicking it set the preference to inline, and nothing
            on screen changed. Found in review.

            `DiffPane` already solved exactly this and its solution is not cosmetic:
            two buttons whose `aria-pressed` is the PREFERENCE, so the control always
            reflects what you chose, plus a VISIBLE note when the floor has overridden
            it — visible because Chromium never shows `title` on keyboard focus, so a
            sighted keyboard user would have no way to learn why the pressed button is
            not what is on screen. #532's whole lesson is that a rule the user cannot
            see is the actual defect, and a second control tuned by feel here would
            have reproduced it on a new surface. Same classes, same strings, one
            behaviour. */}
        {tooNarrow && <span className="diff-narrow-note">{t('diff.tooNarrowNote')}</span>}
        <span
          className="diff-toolbar"
          role="group"
          aria-label={t('diff.layoutLabel')}
          data-approval-diff-layout={layout}
          data-approval-diff-pref={pref}
        >
          {(['side-by-side', 'inline'] as const).map((mode) => {
            // the ONE case where the pressed button is not what is on screen: say
            // why, rather than let it read as a control that does nothing
            const reason = mode === 'side-by-side' && tooNarrow ? t('diff.tooNarrow') : undefined;
            return (
              <button
                key={mode}
                type="button"
                className="diff-btn"
                data-approval-diff-button={mode}
                aria-pressed={pref === mode}
                aria-label={reason}
                title={reason}
                onClick={() => setDiffLayout(mode)}
              >
                {mode === 'side-by-side' ? t('diff.sideBySide') : t('diff.inline')}
              </button>
            );
          })}
        </span>
      </div>
      <div
        ref={hostRef}
        data-approval-diff-host
        style={{
          blockSize: height,
          border: '1px solid var(--border)',
          borderRadius: 4,
          overflow: 'hidden',
        }}
      />
      {/* ⚠️ #953's RULE, ON SCREEN. Never silently truncate what a user is being
          asked to sign for — so when the bound bit, the card says exactly what is
          not in the editor above it, in lines, characters and whole changes. The
          old behaviour appended `…` to a 1500-char slice and said nothing. */}
      {props.diff.withheld && (
        <div data-approval-diff-withheld style={{ fontSize: 10, color: 'var(--status-crashed-ink)' }}>
          {withheldText(t, props.diff.withheld)}
        </div>
      )}
      {props.diff.unreadable > 0 && (
        <div data-approval-diff-unreadable style={{ fontSize: 10, color: 'var(--muted)' }}>
          {t('approvalPreview.unreadableEdits', { count: props.diff.unreadable })}
        </div>
      )}
    </div>
  );
}

export type Translate = (key: string, vars?: Record<string, unknown>) => string;

/**
 * What the diff above is OF. Never what it would do to the disk — see below.
 *
 * Exported for its own test. Monaco cannot run in jsdom, so a component test cannot
 * reach these strings through a render — and until they were exported, the one
 * done-when about SAYING what was withheld was asserted by a comment and by nothing
 * else (found in review).
 */
export function caption(t: Translate, diff: ApprovalDiff): string {
  if (diff.kind === 'write') {
    // LINES, not "1 change", and the same rule the `Write` caption has always
    // obeyed: "new contents" rather than "changes", because a `Write` creates a
    // file or replaces one wholesale and the renderer holds a payload rather than
    // the disk. The original side is empty because that is all the payload proves.
    return t('approvalDiff.write', { count: lineCount(diff.hunks[0].modified) });
  }
  if (diff.kind === 'multi-edit') {
    return t('approvalDiff.multiEdit', { count: diff.hunks[0].total });
  }
  return t('approvalDiff.edit');
}

/**
 * One sentence naming everything the bound refused to render (#953).
 *
 * Two kinds of number, because they answer different questions: a reader told "3
 * changes are not shown" knows to ask for the rest rather than to scroll, and a
 * reader told "412 lines are not shown" knows the change in front of them is a
 * fragment of itself.
 *
 * ⚠️ LINES AND CHARACTERS TOGETHER, not one or the other. The first version had
 * `chars` behind an `else if` after `lines`, and review found the arm unreachable —
 * correctly, and for a reason that survived the first attempt to fix it: a non-empty
 * remainder is ALWAYS at least one line under `lineCount`'s human counting rule, so
 * `lines` always won and the string was dead. Even a minified file with no newline
 * in it reports "1 line".
 *
 * Reporting both is the answer rather than deleting one, because the pair is where
 * the information is. "1 line" alone understates a minified file catastrophically;
 * "187,000 characters" beside it does not. And a reader looking at "412 lines,
 * 9,000 characters" can tell at a glance whether the missing part is wide or long.
 */
export function withheldText(
  t: Translate,
  w: { lines: number; chars: number; changes: number }
): string {
  const parts: string[] = [];
  if (w.changes > 0) parts.push(t('approvalDiff.withheldChanges', { count: w.changes }));
  if (w.lines > 0) parts.push(t('approvalDiff.withheldLines', { count: w.lines }));
  if (w.chars > 0) parts.push(t('approvalDiff.withheldChars', { count: w.chars }));
  return t('approvalDiff.withheld', { what: parts.join(', ') });
}
