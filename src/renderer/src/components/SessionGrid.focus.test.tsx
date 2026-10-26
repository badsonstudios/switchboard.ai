// @vitest-environment jsdom
// Picking a session from a list lands on it (#1456): `focusCardIn`, the body of
// the grid's `focusSession`, against a stand-in grid. Every list in the app (the
// rail, the tab pills, the Events drawer, the palette, a toast) reaches it
// through App's `focusSession`; the e2e covers the docked click end to end,
// and the cross-window raise is a hand test (a popout is a second document that
// Playwright cannot measure focus across).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { focusCardIn, landsFor } from './SessionGrid';
import { LANDED_ATTR } from '../lib/landing-flash';

interface FakePanel {
  focus: ReturnType<typeof vi.fn>;
  group: { id: string; element: HTMLElement; api: { location: Record<string, unknown> } };
}

function docked(groupId = '1'): FakePanel {
  return {
    focus: vi.fn(),
    group: { id: groupId, element: document.createElement('div'), api: { location: { type: 'grid' } } },
  };
}

/** A panel in a popout window that dockview named for `windowGroup`. */
function poppedOut(groupId: string, windowGroup: string): FakePanel & { win: { focus: ReturnType<typeof vi.fn>; name: string } } {
  const win = { focus: vi.fn(), name: `1-${windowGroup}` };
  return {
    win,
    focus: vi.fn(),
    group: {
      id: groupId,
      element: document.createElement('div'),
      api: { location: { type: 'popout', getWindow: () => win } },
    },
  };
}

const gridOf = (panels: Record<string, FakePanel>) =>
  ({ getPanel: (id: string) => panels[id.replace(/^session-/, '')] }) as never;

let raisePopout: ReturnType<typeof vi.fn>;
let raiseMain: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  raisePopout = vi.fn(() => Promise.resolve(true));
  raiseMain = vi.fn(() => Promise.resolve(true));
  (window as unknown as { switchboard: unknown }).switchboard = { raisePopout, raiseMain };
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (q: string) => ({ matches: false, media: q }),
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete (window as unknown as { switchboard?: unknown }).switchboard;
});

const noReveal = (): Promise<void> => Promise.resolve();

describe('landsFor — only a pick from a list lands (#1456)', () => {
  it('lands when a list is named', () => {
    for (const via of ['rail', 'tabs', 'events', 'palette', 'command', 'toast', 'attention-jump']) {
      expect(landsFor({ via })).toBe(true);
    }
  });

  it('does NOT land for the attention auto-focus, or a caller that names no list', () => {
    expect(landsFor({ raiseWindow: false })).toBe(false);
    expect(landsFor(undefined)).toBe(false);
    expect(landsFor({})).toBe(false);
    // and a named list that asked not to raise is still not a landing
    expect(landsFor({ via: 'rail', raiseWindow: false })).toBe(false);
  });
});

describe('focusCardIn — landing on a session you picked (#1456)', () => {
  it('a DOCKED card: focuses its panel and flashes it, raises nothing else', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const a = docked();
    const raised = focusCardIn(gridOf({ a }), 'a', { land: true, via: 'rail' }, noReveal);
    expect(raised).toBe(false);
    expect(a.focus).toHaveBeenCalledTimes(1);
    expect(a.group.element.getAttribute(LANDED_ATTR)).toBe('motion');
    expect(raisePopout).not.toHaveBeenCalled();
    // this window has focus, so it is not asked to come forward
    expect(raiseMain).not.toHaveBeenCalled();
  });

  it('a docked card picked while this window is BEHIND brings the main window forward', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    const a = docked();
    focusCardIn(gridOf({ a }), 'a', { land: true, via: 'palette' }, noReveal);
    expect(raiseMain).toHaveBeenCalledWith({ cardId: 'a', via: 'palette' });
  });

  it("a POPPED-OUT card: raises its window by the WINDOW's key and flashes the pane", () => {
    const b = poppedOut('2', '2');
    const raised = focusCardIn(gridOf({ b }), 'b', { land: true, via: 'rail' }, noReveal);
    expect(raised).toBe(true);
    expect(b.focus).toHaveBeenCalledTimes(1);
    expect(b.win.focus).toHaveBeenCalledTimes(1);
    expect(raisePopout).toHaveBeenCalledWith('2', { cardId: 'b', via: 'rail', panelGroupId: '2' });
    expect(b.group.element.getAttribute(LANDED_ATTR)).toBe('motion');
  });

  it('THE BUG: a card split into a popout window\'s second group asks for the window, not its group', () => {
    // the window was opened for group 2; this card is in group 5 beside it
    const c = poppedOut('5', '2');
    focusCardIn(gridOf({ c }), 'c', { land: true }, noReveal);
    expect(raisePopout).toHaveBeenCalledWith('2', expect.objectContaining({ panelGroupId: '5' }));
  });

  it('the attention auto-focus (`raiseWindow: false`, no land) neither raises nor flashes', () => {
    const b = poppedOut('2', '2');
    const a = docked();
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    expect(focusCardIn(gridOf({ a, b }), 'b', { raiseWindow: false }, noReveal)).toBe(true);
    focusCardIn(gridOf({ a, b }), 'a', { raiseWindow: false }, noReveal);
    expect(raisePopout).not.toHaveBeenCalled();
    expect(raiseMain).not.toHaveBeenCalled();
    expect(a.group.element.getAttribute(LANDED_ATTR)).toBeNull();
    expect(b.group.element.getAttribute(LANDED_ATTR)).toBeNull();
    // ...but the panels are still focused: that is what the jump is
    expect(a.focus).toHaveBeenCalled();
    expect(b.focus).toHaveBeenCalled();
  });

  it('a hidden card is revealed, and flashed once it is back', async () => {
    const panels: Record<string, FakePanel> = {};
    const back = docked();
    const reveal = vi.fn(async () => {
      panels.h = back;
    });
    expect(focusCardIn(gridOf(panels), 'h', { land: true }, reveal)).toBe(false);
    expect(reveal).toHaveBeenCalledWith('h');
    await vi.waitFor(() => expect(back.group.element.getAttribute(LANDED_ATTR)).toBe('motion'));
  });

  it('a hidden card revealed WITHOUT land is not flashed', async () => {
    const panels: Record<string, FakePanel> = {};
    const back = docked();
    focusCardIn(gridOf(panels), 'h', undefined, async () => {
      panels.h = back;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(back.group.element.getAttribute(LANDED_ATTR)).toBeNull();
  });
});
