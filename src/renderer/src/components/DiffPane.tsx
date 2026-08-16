// Diff viewer pane (P1-E5-02): read-only Monaco diff + file list with VCS
// badges, one pane per session. Workers are bundled by Vite (?worker) — no
// CDN, CSP stays 'self'.
//
// #191 — the monaco entry point is `edcore.main`, the core editor with NO
// languages, and the tokenizers are put back one by one by `monaco-languages`.
// The bare `monaco-editor` entry would also register the rich TS/JSON/CSS/HTML
// language services, which demand their own web workers and throw uncaught
// against the single plain worker below. The full reasoning, and the numbers,
// are in `lib/monaco-languages.ts` — read that before changing this import.
import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import * as monaco from 'monaco-editor/esm/vs/editor/edcore.main';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import '../lib/monaco-languages';
import { languageForPath } from '../lib/diff-language';
import {
  effectiveDiffLayout,
  getDiffLayout,
  isTooNarrowForColumns,
  setDiffLayout,
  subscribeDiffLayout,
  type DiffLayout,
} from '../lib/diff-layout';
import { defineDiffThemes, DIFF_THEME } from '../lib/monaco-theme';
import { findSurfaceKey, publishFindSurface, type MonacoFindSurface } from '../lib/find-surfaces';
import { openDocument } from '../lib/document-open';

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

declare global {
  interface Window {
    MonacoEnvironment?: monaco.Environment;
  }
}
// One worker, and no `label` switch: with the rich language services gone,
// `editor.worker` is the only worker anything in this app can ask for.
window.MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
};

interface GitFileDto {
  path: string;
  xy: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
}

interface GitStatusDto {
  isRepo: boolean;
  branch?: string;
  files: GitFileDto[];
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
  const [selected, setSelected] = useState<string | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  // Workspace-wide, not per-card (#532): "how I read a diff" is a habit, not a
  // property of one session, and the palette command has no card in hand.
  const layoutPref = useSyncExternalStore(subscribeDiffLayout, getDiffLayout);
  // The VERDICT, not the pixel count: a splitter drag then re-renders this
  // component (file list, badges, every row's button) only when the answer
  // flips, rather than on every frame. See `isTooNarrowForColumns`.
  const [tooNarrow, setTooNarrow] = useState(false);
  const layout = effectiveDiffLayout(layoutPref, tooNarrow);
  /** the preference is side-by-side but the pane cannot carry it — the toggle
   *  has to SAY so, or it reads as a button that does nothing (#532) */
  const narrowed = layoutPref === 'side-by-side' && layout === 'inline';

  useEffect(() => {
    void window.switchboard.git.status(props.folder).then((s) => setStatus(s as GitStatusDto));
  }, [props.folder]);

  // Built ONCE per pane. `colorScheme` used to be in these deps, which meant a
  // theme switch disposed the editor AND both models and built an empty one —
  // and nothing put the models back, because the effect below only re-runs
  // when the SELECTION changes. Switching theme with a file open therefore
  // blanked the diff until you clicked another file. Monaco's standalone theme
  // is global and swappable in place (`setTheme`, next effect), so there was
  // never a reason to rebuild the editor for it.
  useEffect(() => {
    if (!hostRef.current) return;
    // `vs` / `vs-dark` with the handful of below-AA token colours corrected —
    // see lib/monaco-theme.ts for the measurements. Here and not at module
    // load: `defineTheme` builds monaco's theme service, which reaches for
    // `CSS.escape`, and jsdom has no `CSS` — so a module-load call takes down
    // every unit test that merely IMPORTS the panel registry. Idempotent, and
    // a theme has to exist before `createDiffEditor` names it, so immediately
    // before is also the only place it has to be.
    defineDiffThemes(monaco.editor);
    const editor = monaco.editor.createDiffEditor(hostRef.current, {
      readOnly: true,
      renderSideBySide: layout === 'side-by-side',
      // WE own the narrow-pane rule, not Monaco (#532). Left on — its default —
      // this quietly forces the inline view under 900px, which is where an
      // ordinary Changes tab in a 1280px window lives, so the pane had asked
      // for side-by-side since P1-E5-02 and never once got it. The full
      // reckoning is in lib/diff-layout's header; the short version is that a
      // rule the user cannot see is worse than one drawn a little narrow.
      useInlineViewWhenSpaceIsLimited: false,
      automaticLayout: true,
      minimap: { enabled: false },
      theme: DIFF_THEME[props.colorScheme],
    });
    editorRef.current = editor;
    return () => {
      editor.getModel()?.original.dispose();
      editor.getModel()?.modified.dispose();
      editor.dispose();
      editorRef.current = null;
    };
    // deliberately empty: `colorScheme` and `layout` are READ here for the
    // initial paint but are not dependencies — the effects below own every
    // change to them, and rebuilding this editor would drop both models
  }, []);

  // Live, in place — `updateOptions` is how a diff editor changes shape without
  // being rebuilt, and rebuilding would blank the pane (see the note above).
  useEffect(() => {
    editorRef.current?.updateOptions({ renderSideBySide: layout === 'side-by-side' });
  }, [layout]);

  // How wide the DIFF is, which is not how wide the card is — the file list
  // takes its 200px off the front first. Measured rather than derived, because
  // the same pane renders in a full-width card, a half-width one and a popout.
  useEffect(() => {
    const host = hostRef.current;
    // jsdom and older embedders have no ResizeObserver; without it the verdict
    // stays `false` and the preference is simply honoured — a degrade, not a
    // break (fail-open)
    if (!host || typeof ResizeObserver === 'undefined') return;
    const measure = (widthPx: number): void => {
      // A HIDDEN dockview tab observes 0×0 (`content.js` sets `display: none`
      // on the inactive panel). Treating that as a measurement would clear the
      // narrow verdict while the tab is away and paint one frame of two
      // columns on the way back — so a non-measurement leaves the last real
      // answer standing.
      if (widthPx > 0) setTooNarrow(isTooNarrowForColumns(Math.round(widthPx)));
    };
    const ro = new ResizeObserver((entries) => {
      measure(entries[0]?.contentRect.width ?? host.clientWidth);
    });
    ro.observe(host);
    measure(host.clientWidth);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    // global by design: monaco's standalone theme is per-page, and every diff
    // pane in a window is showing the same app theme anyway
    monaco.editor.setTheme(DIFF_THEME[props.colorScheme]);
  }, [props.colorScheme]);

  // Session find, delegated (P2-E17-02, §5.31). Monaco HAS a find — a good one,
  // with regex, whole-word, replace and match marks down the scrollbar — and
  // §5.31 names it as a thing not to reimplement. So the Changes tab's Ctrl+F
  // opens Monaco's widget and our bar stays out of the way entirely.
  useEffect(() => {
    if (!props.cardId) return;
    // The editor is built on mount but no file is selected until the user
    // picks one, and a find over a model-less editor opens a widget that can
    // never match anything. `ready()` is what lets the provider grey the bar
    // with a reason instead of handing off into nothing.
    const modified = (): monaco.editor.ICodeEditor | null =>
      editorRef.current?.getModifiedEditor() ?? null;
    const surface: MonacoFindSurface = {
      kind: 'monaco',
      ready: (): boolean => !!modified()?.getModel(),
      openFind: (term: string): boolean => {
        const ed = modified();
        if (!ed?.getModel()) return false;
        // focus first, or the widget opens without a caret and Enter does
        // nothing — the "it did open, it just doesn't work" failure
        ed.focus();
        ed.getAction('actions.find')?.run();
        // Seed the sticky term. `setSearchString` is the find controller's own
        // public method; reached through `getContribution`, whose return type
        // is opaque, so this is a narrow structural cast rather than a lie
        // about the whole contribution. Optional at every step: if a Monaco
        // upgrade renames it the widget still opens, merely empty — a degrade,
        // not a break (fail-open).
        if (term) {
          const find = ed.getContribution('editor.contrib.findController') as unknown as {
            setSearchString?: (s: string) => void;
          } | null;
          find?.setSearchString?.(term);
        }
        return true;
      },
    };
    return publishFindSurface(findSurfaceKey(props.cardId, 'diff'), surface);
  }, [props.cardId]);

  useEffect(() => {
    if (!selected || !editorRef.current) return;
    let cancelled = false; // stale selections / editor disposed mid-load
    void window.switchboard.git.fileVersions(props.folder, selected).then((v) => {
      const ed = editorRef.current;
      if (cancelled || !ed) return;
      const old = ed.getModel();
      // Same language on both sides — they are two versions of one file, and a
      // mismatch would colour the "before" pane differently from the "after".
      // Unknown extensions come back `plaintext`, which is what the pane did
      // for EVERY file before #191.
      const language = languageForPath(selected);
      ed.setModel({
        original: monaco.editor.createModel(v.original, language),
        modified: monaco.editor.createModel(v.modified, language),
      });
      old?.original.dispose();
      old?.modified.dispose();
    });
    return () => {
      cancelled = true;
    };
  }, [selected, props.folder]);

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
        {status && !status.isRepo && (
          <div style={{ color: 'var(--muted)' }}>{t('diff.notRepo')}</div>
        )}
        {status?.isRepo && status.files.length === 0 && (
          <div style={{ color: 'var(--muted)' }}>{t('diff.clean')}</div>
        )}
        {status?.files.map((f) => (
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
        </div>
        <div ref={hostRef} style={{ flex: 1, minBlockSize: 0 }} />
      </div>
    </div>
  );
}
