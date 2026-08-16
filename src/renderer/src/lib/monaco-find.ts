// Handing find over to Monaco's own widget (§5.31, P2-E17-02 / #533).
//
// TWO surfaces in this app are Monaco editors — the Changes diff and the
// document viewer's SOURCE body — and §5.31 names Monaco's find specifically as
// a thing not to reimplement: it already has regex, whole word, replace and
// match marks down the scrollbar, and our chrome over its search would give one
// editor two Escape targets and two match counts. So both surfaces delegate,
// and this is the delegation, written once.
//
// STRUCTURALLY TYPED, not `monaco.editor.ICodeEditor`, and that is the reason
// this file is worth having beyond de-duplication: `DocumentViewer` must not
// import monaco. Its source body is a lazy child precisely so the ~4 MB of
// editor stays out of the viewer's jsdom unit tests, and a type-only import
// would be erased but an accidental value one would not. A four-member
// structural type is a contract both editors satisfy and neither test has to
// stub more of.

/** The little of an editor this needs. Monaco's editors satisfy it as-is. */
export interface FindableEditor {
  getModel(): unknown;
  focus(): void;
  getAction(id: string): { run(): unknown } | null;
  getContribution(id: string): unknown;
}

/**
 * Focus `editor` and open ITS find widget, seeded with `term`.
 *
 * False means nothing was opened — the editor is gone, or has no model. An
 * editor is created when a pane mounts but carries no document until one is
 * chosen, and a find over a model-less editor opens a widget that can never
 * match anything, which is the "it did open, it just doesn't work" failure. The
 * caller turns that false into a greyed bar with a reason.
 */
export function openMonacoFind(editor: FindableEditor | null | undefined, term: string): boolean {
  if (!editor?.getModel()) return false;
  // focus first, or the widget opens without a caret and Enter does nothing
  editor.focus();
  editor.getAction('actions.find')?.run();
  // Seed the sticky term. `setSearchString` is the find controller's own public
  // method; reached through `getContribution`, whose return type is opaque, so
  // this is a narrow structural cast rather than a lie about the whole
  // contribution. Optional at every step: if a Monaco upgrade renames it the
  // widget still opens, merely empty — a degrade, not a break (fail-open).
  if (term) {
    const find = editor.getContribution('editor.contrib.findController') as {
      setSearchString?: (s: string) => void;
    } | null;
    find?.setSearchString?.(term);
  }
  return true;
}
