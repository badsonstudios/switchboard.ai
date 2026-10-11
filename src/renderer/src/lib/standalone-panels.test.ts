// `activeStandalonePanelId` — which document or diff panel a keystroke is over.
//
// The popout branch is the one that matters and the one an e2e cannot hold on
// every platform: the popped-out specs skip on the Linux runner, so without
// this the rule "a keystroke in another window is resolved by THAT window" was
// pinned on Windows only.
import { describe, it, expect } from 'vitest';
import { activeStandalonePanelId, type DockShape, type GroupShape } from './standalone-panels';
import { isDiffPanelId } from './diff-panels';
import { isDocumentPanelId } from './document-panels';

const win = (name: string): Window => ({ name }) as unknown as Window;
const grid = (active?: string): GroupShape => ({
  activePanel: active ? { id: active } : undefined,
  api: { location: { type: 'grid' } },
});
const popout = (w: Window, active?: string): GroupShape => ({
  activePanel: active ? { id: active } : undefined,
  api: { location: { type: 'popout', getWindow: () => w } },
});
const dock = (active: string | undefined, groups: GroupShape[]): DockShape => ({
  activePanel: active ? { id: active } : undefined,
  groups,
});

describe('activeStandalonePanelId', () => {
  it('answers the grid’s active panel when it is of the kind asked for', () => {
    const api = dock('gitdiff-1', [grid('gitdiff-1')]);
    expect(activeStandalonePanelId(api, undefined, isDiffPanelId)).toBe('gitdiff-1');
    // …and null to the OTHER kind: a diff is not a document
    expect(activeStandalonePanelId(api, undefined, isDocumentPanelId)).toBeNull();
  });

  it('answers null over a session card, for both kinds', () => {
    const api = dock('session-abc', [grid('session-abc')]);
    expect(activeStandalonePanelId(api, undefined, isDiffPanelId)).toBeNull();
    expect(activeStandalonePanelId(api, undefined, isDocumentPanelId)).toBeNull();
  });

  it('a keystroke from a POPOUT is resolved by that window, not by the grid', () => {
    // The grid's active panel is still the session card: dockview does not move
    // `activePanel` when the user clicks into another OS window.
    const other = win('diff-window');
    const api = dock('session-abc', [grid('session-abc'), popout(other, 'gitdiff-2')]);
    expect(activeStandalonePanelId(api, other, isDiffPanelId)).toBe('gitdiff-2');
    // from the MAIN window the same layout answers nothing — the card is active
    expect(activeStandalonePanelId(api, undefined, isDiffPanelId)).toBeNull();
  });

  it('two popouts of two kinds each answer only for their own window', () => {
    const diffWin = win('diff');
    const docWin = win('doc');
    const api = dock('session-abc', [
      grid('session-abc'),
      popout(diffWin, 'gitdiff-2'),
      popout(docWin, 'doc-5'),
    ]);
    expect(activeStandalonePanelId(api, diffWin, isDiffPanelId)).toBe('gitdiff-2');
    expect(activeStandalonePanelId(api, diffWin, isDocumentPanelId)).toBeNull();
    expect(activeStandalonePanelId(api, docWin, isDocumentPanelId)).toBe('doc-5');
    expect(activeStandalonePanelId(api, docWin, isDiffPanelId)).toBeNull();
  });

  it('a source window that is not one of the popouts answers null, NOT the grid’s panel', () => {
    // A popped-out SESSION card's window, say. Falling back to the grid's
    // active panel would send its Ctrl+F to a diff in a different window.
    const stranger = win('somewhere-else');
    const api = dock('gitdiff-1', [grid('gitdiff-1'), popout(win('other'), 'gitdiff-2')]);
    expect(activeStandalonePanelId(api, stranger, isDiffPanelId)).toBeNull();
  });

  it('a popout showing a session card answers null', () => {
    const w = win('card-window');
    const api = dock('gitdiff-1', [grid('gitdiff-1'), popout(w, 'session-abc')]);
    expect(activeStandalonePanelId(api, w, isDiffPanelId)).toBeNull();
  });

  it('survives a popout whose window is being torn down', () => {
    const w = win('gone');
    const dying: GroupShape = {
      activePanel: { id: 'gitdiff-9' },
      api: {
        location: {
          type: 'popout',
          getWindow: () => {
            throw new Error('window closed');
          },
        },
      },
    };
    const api = dock(undefined, [dying, popout(w, 'gitdiff-2')]);
    expect(activeStandalonePanelId(api, w, isDiffPanelId)).toBe('gitdiff-2');
  });

  it('answers null with no dockview at all', () => {
    expect(activeStandalonePanelId(null, undefined, isDiffPanelId)).toBeNull();
  });
});

describe('a popped-out window that holds MORE THAN ONE group (#1214)', () => {
  // A popout can be split, or share its window with a document. Which group a
  // keystroke belongs to used to be "the first", harmless while it only chose
  // where a find bar opened. It now chooses which session a pin or a close
  // acts on.
  const isSession = (id: string): boolean => /^session-/.test(id);
  const inside = (node: object): GroupShape['element'] => ({ contains: (n) => n === (node as unknown as Node) });
  const withFocus = (focused: object | null): Window =>
    ({ document: { activeElement: focused } }) as unknown as Window;

  it('the group with the KEYBOARD in it answers, not the first one', () => {
    const inY = {};
    const w = withFocus(inY);
    const x: GroupShape = { ...popout(w, 'session-x'), element: inside({}) };
    const y: GroupShape = { ...popout(w, 'session-y'), element: inside(inY) };
    expect(activeStandalonePanelId(dock('session-a', [grid('session-a'), x, y]), w, isSession)).toBe('session-y');
  });

  it('with the keyboard in neither, dockview’s active group, if it is in THAT window', () => {
    const w = withFocus(null);
    const x: GroupShape = { ...popout(w, 'session-x'), element: inside({}) };
    const y: GroupShape = { ...popout(w, 'session-y'), element: inside({}) };
    const api: DockShape = { ...dock('session-y', [x, y]), activeGroup: y };
    expect(activeStandalonePanelId(api, w, isSession)).toBe('session-y');
    // an active group in ANOTHER window is no answer for this one: the first
    const elsewhere: DockShape = { ...dock('session-a', [grid('session-a'), x, y]), activeGroup: grid('session-a') };
    expect(activeStandalonePanelId(elsewhere, w, isSession)).toBe('session-x');
  });

  it('a session beside a DOCUMENT: the keyboard in the document means no session', () => {
    const inDoc = {};
    const w = withFocus(inDoc);
    const session: GroupShape = { ...popout(w, 'session-x'), element: inside({}) };
    const doc: GroupShape = { ...popout(w, 'doc-1'), element: inside(inDoc) };
    expect(activeStandalonePanelId(dock(undefined, [session, doc]), w, isSession)).toBeNull();
    expect(activeStandalonePanelId(dock(undefined, [session, doc]), w, isDocumentPanelId)).toBe('doc-1');
  });

  it('a window that cannot be asked where its keyboard is falls back, and does not throw', () => {
    const w = new Proxy({}, { get: () => { throw new Error('dead window'); } }) as unknown as Window;
    const x = popout(w, 'session-x');
    const y = popout(w, 'session-y');
    expect(activeStandalonePanelId(dock(undefined, [x, y]), w, isSession)).toBe('session-x');
  });
});
