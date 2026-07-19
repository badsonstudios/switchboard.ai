// Diff viewer pane (P1-E5-02): read-only Monaco diff + file list with VCS
// badges, one pane per session. Workers are bundled by Vite (?worker) — no
// CDN, CSP stays 'self'.
import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';

declare global {
  interface Window {
    MonacoEnvironment?: monaco.Environment;
  }
}
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

export function DiffPane(props: { folder: string; theme: 'nordic' | 'daylight' }): React.JSX.Element {
  const { t } = useTranslation();
  const [status, setStatus] = useState<GitStatusDto | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);

  useEffect(() => {
    void window.switchboard.git.status(props.folder).then((s) => setStatus(s as GitStatusDto));
  }, [props.folder]);

  useEffect(() => {
    if (!hostRef.current) return;
    const editor = monaco.editor.createDiffEditor(hostRef.current, {
      readOnly: true,
      renderSideBySide: true,
      automaticLayout: true,
      minimap: { enabled: false },
      theme: props.theme === 'daylight' ? 'vs' : 'vs-dark',
    });
    editorRef.current = editor;
    return () => {
      editor.getModel()?.original.dispose();
      editor.getModel()?.modified.dispose();
      editor.dispose();
      editorRef.current = null;
    };
  }, [props.theme]);

  useEffect(() => {
    if (!selected || !editorRef.current) return;
    let cancelled = false; // stale selections / editor disposed mid-load
    void window.switchboard.git.fileVersions(props.folder, selected).then((v) => {
      const ed = editorRef.current;
      if (cancelled || !ed) return;
      const old = ed.getModel();
      ed.setModel({
        original: monaco.editor.createModel(v.original),
        modified: monaco.editor.createModel(v.modified),
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
