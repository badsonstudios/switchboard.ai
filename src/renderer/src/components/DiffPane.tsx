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
import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import * as monaco from 'monaco-editor/esm/vs/editor/edcore.main';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import '../lib/monaco-languages';
import { languageForPath } from '../lib/diff-language';
import { defineDiffThemes, DIFF_THEME } from '../lib/monaco-theme';
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
}): React.JSX.Element {
  const { t } = useTranslation();
  const [status, setStatus] = useState<GitStatusDto | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);

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
      renderSideBySide: true,
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
    // deliberately empty: `colorScheme` is READ here for the initial paint but
    // is not a dependency — the effect below owns every change to it
  }, []);

  useEffect(() => {
    // global by design: monaco's standalone theme is per-page, and every diff
    // pane in a window is showing the same app theme anyway
    monaco.editor.setTheme(DIFF_THEME[props.colorScheme]);
  }, [props.colorScheme]);

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
                openDocument(joinPath(props.folder, f.path));
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
      <div ref={hostRef} style={{ flex: 1, minInlineSize: 0 }} />
    </div>
  );
}
