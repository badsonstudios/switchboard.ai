// The one web worker Monaco is allowed to ask for (P1-E5-02, extracted by #972).
//
// ── WHY THIS IS A MODULE AND NOT THREE COPIES ───────────────────────────────
//
// It was two: `DiffPane` and `DocumentSource` each declared the global and each
// assigned `window.MonacoEnvironment`, identically. #972 needed it a third time —
// the approval card's diff can be the first Monaco-shaped thing a session ever
// asks for, and a diff editor with no worker computes no diff — and a third copy
// of a two-line global assignment is how the two copies stop agreeing.
//
// Imported for its SIDE EFFECT, like `./monaco-languages`:
//
//     import '../lib/monaco-worker';
//
// Assigning on import rather than exporting an `install()` is deliberate. The
// environment has to be in place before the first editor is constructed, and a
// function someone can forget to call is exactly the failure mode that is hard to
// see: the editor still renders, it just never diffs, on whichever surface got
// there first.
//
// ── WHY ONE WORKER AND NO `label` SWITCH ────────────────────────────────────
//
// The app's monaco entry point is `edcore.main` — the core editor with NO
// languages — and `lib/monaco-languages` puts the tokenizers back one at a time
// (#191, read that file's header before changing the import). The rich
// TS/JSON/CSS/HTML language services are therefore never registered, and they are
// the only things that ask for a worker by any other label. So `editor.worker` is
// the only worker anything in this app can request, and a switch on `label` would
// be a branch with one live arm.
//
// Vite bundles it via `?worker`, so nothing is fetched from a CDN and the CSP
// stays `'self'`.
import type * as monaco from 'monaco-editor/esm/vs/editor/edcore.main';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';

declare global {
  interface Window {
    MonacoEnvironment?: monaco.Environment;
  }
}

window.MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
};
