// The viewer's source body: Monaco, read-only, syntax-highlighted
// (P2-E16-02, §5.30).
//
// READ-ONLY, PERMANENTLY. PHILOSOPHY §5 rejected a built-in editor by name
// ("Monaco stays read-only + diff-only") and §5.30 applies that precedent
// rather than deferring it: this is a document surface, and the escape hatch is
// the header's "Open externally". `readOnly` is set here, on the only editor
// this component ever builds, and there is no prop that turns it off.
//
// SEPARATE FILE, loaded lazily by the viewer, for a reason that is not bundle
// size (Monaco is already in the bundle for DiffPane): it keeps the ~4 MB of
// editor out of the viewer's unit tests, which run in jsdom and only care about
// the header, the dispatch and the rendered body.
//
// The entry point is `edcore.main` for the reason DiffPane's header explains at
// length — the bare `monaco-editor` entry registers rich language services that
// demand their own workers and throw against the single plain worker below.
import React, { useEffect, useRef } from 'react';
import * as monaco from 'monaco-editor/esm/vs/editor/edcore.main';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import '../lib/monaco-languages';
import { defineDiffThemes, DIFF_THEME } from '../lib/monaco-theme';

declare global {
  interface Window {
    MonacoEnvironment?: monaco.Environment;
  }
}
// Same single worker as DiffPane — with the rich language services gone,
// `editor.worker` is the only worker anything in this app can ask for. Assigned
// on import so it is in place whichever surface mounts first.
window.MonacoEnvironment = { getWorker: () => new EditorWorker() };

export interface DocumentSourceProps {
  text: string;
  /** a Monaco language id, from `classifyDocument` */
  language: string;
  colorScheme: 'light' | 'dark';
  /** where this document was last left, so the mode toggle round-trips */
  initialScrollTop?: number;
  /** reported on every scroll, so the parent can hand it back on remount */
  onScrollTop?: (top: number) => void;
}

export default function DocumentSource(props: DocumentSourceProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  // Read inside effects that must not re-run when only the callback identity
  // changes — a parent that passes an inline arrow would otherwise rebuild the
  // editor on every render, which is the bug DiffPane's header warns about.
  const onScroll = useRef(props.onScrollTop);
  onScroll.current = props.onScrollTop;
  const initialTop = useRef(props.initialScrollTop ?? 0);

  useEffect(() => {
    if (!hostRef.current) return;
    defineDiffThemes(monaco.editor);
    const editor = monaco.editor.create(hostRef.current, {
      value: '',
      readOnly: true,
      // A read-only editor still shows a caret and lets you select, which is
      // what makes copy work. What it must not show is the "cannot edit in a
      // read-only editor" tooltip on every keystroke.
      readOnlyMessage: { value: '' },
      automaticLayout: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      wordWrap: 'off',
      theme: DIFF_THEME[props.colorScheme],
    });
    editorRef.current = editor;
    const sub = editor.onDidScrollChange((e) => onScroll.current?.(e.scrollTop));
    return () => {
      sub.dispose();
      editor.getModel()?.dispose();
      editor.dispose();
      editorRef.current = null;
    };
    // Built ONCE. Theme and content are applied by the effects below; rebuilding
    // on either would throw away the user's scroll and selection.
  }, []);

  useEffect(() => {
    monaco.editor.setTheme(DIFF_THEME[props.colorScheme]);
  }, [props.colorScheme]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const old = editor.getModel();
    // WHERE THE READER IS, not where they were when this component mounted.
    // The first model install has nowhere to read from, so it takes the offset
    // the parent remembered across the mode toggle; every install after that
    // keeps the position the editor is actually at, which is what P2-E16-04's
    // "re-render on change, preserving scroll position" needs — re-applying the
    // mount-time offset would fight it on every rewrite.
    const keep = old ? editor.getScrollTop() : initialTop.current;
    const model = monaco.editor.createModel(props.text, props.language);
    editor.setModel(model);
    old?.dispose();
    editor.setScrollTop(keep);
  }, [props.text, props.language]);

  return <div ref={hostRef} className="doc-source" style={{ inlineSize: '100%', blockSize: '100%' }} />;
}
