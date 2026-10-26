// How a popped-out window is NAMED, shared by the two processes that must agree
// on it (#1456).
//
// dockview opens a popout with `window.open(url, '<componentId>-<groupId>')`:
// the frame name carries the id of the group the window was opened FOR. Main
// keys its popout registry by that id (`did-create-window` sees the frame
// name), and every renderer request to raise or parent to a popout has to name
// the window the same way.
//
// THE TRAP this file exists for: the group id in the frame name is fixed when
// the window opens, but a dockview 7 popout window can hold SEVERAL groups — a
// session split beside another inside it, or a tab dropped on its edge, makes a
// new group with a new id in the same OS window, and dockview promotes another
// member to "anchor" when the first one leaves. Asking main for `panel.group.id`
// therefore missed every session that was not in the window's first group, and
// clicking it in the list raised nothing (issue 1456's probe, recorded in
// `spike/findings/1456-popout-raise.md`). The renderer reads the key off the
// popout's own `window.name` instead, which is the frame name main saw.

/** dockview names a popout window `<componentId>-<groupId>` */
export function groupIdFromFrameName(frameName: string | undefined): string | undefined {
  if (!frameName) return undefined;
  const i = frameName.lastIndexOf('-');
  return i > 0 && i < frameName.length - 1 ? frameName.slice(i + 1) : undefined;
}
