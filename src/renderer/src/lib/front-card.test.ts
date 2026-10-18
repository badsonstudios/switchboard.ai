// @vitest-environment jsdom
// "Which session is the user in?", told to main (#1267). The needs-you cue
// does not ring for that one.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { sessionStore } from '../store/session-store';
import { addPopoutWindow, resetPopoutWindows } from './popout-windows';
import { frontCardNow, installFrontCardReport, popoutFrontCard } from './front-card';

let off: (() => void) | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  sessionStore.setActiveCard(null);
  resetPopoutWindows();
});

afterEach(() => {
  off?.();
  off = null;
  sessionStore.setActiveCard(null);
  resetPopoutWindows();
  vi.useRealTimers();
});

/** a pop-out document whose open tab is `cardId` */
function popoutDoc(cardId: string, focused: boolean): Window {
  const doc = document.implementation.createHTMLDocument('popout');
  doc.body.innerHTML =
    '<div class="dv-groupview dv-active-group"><div class="dv-tab dv-active-tab">' +
    `<span data-last-prompt-for="${cardId}"></span></div></div>`;
  vi.spyOn(doc, 'hasFocus').mockReturnValue(focused);
  const win = new EventTarget() as unknown as Window;
  Object.defineProperty(win, 'document', { value: doc });
  Object.defineProperty(win, 'closed', { value: false });
  return win;
}

describe('frontCardNow', () => {
  it('is the main window`s active card', () => {
    sessionStore.setActiveCard('a');
    expect(frontCardNow()).toBe('a');
  });

  it('is nothing when no card is active', () => {
    expect(frontCardNow()).toBeNull();
  });

  it('a focused pop-out wins: that is the window being typed in', () => {
    sessionStore.setActiveCard('a');
    addPopoutWindow(popoutDoc('p', true));
    expect(frontCardNow()).toBe('p');
  });

  it('an unfocused pop-out does not', () => {
    sessionStore.setActiveCard('a');
    addPopoutWindow(popoutDoc('p', false));
    expect(frontCardNow()).toBe('a');
  });

  it('reads the open tab of the active group in a pop-out', () => {
    const doc = document.implementation.createHTMLDocument('popout');
    doc.body.innerHTML =
      '<div class="dv-groupview"><div class="dv-active-tab"><span data-last-prompt-for="x"></span></div></div>' +
      '<div class="dv-groupview dv-active-group"><div class="dv-active-tab"><span data-last-prompt-for="y"></span></div></div>';
    expect(popoutFrontCard(doc)).toBe('y');
  });
});

describe('installFrontCardReport', () => {
  it('reports at start, then only when the answer CHANGES', () => {
    const sent: Array<string | null> = [];
    const bridge = { setFrontCard: (c: string | null) => (sent.push(c), Promise.resolve(true)) };
    sessionStore.setActiveCard('a');
    off = installFrontCardReport(bridge);
    vi.runOnlyPendingTimers();
    expect(sent).toEqual(['a']);

    // a keystroke that moves nothing sends nothing
    window.dispatchEvent(new Event('keydown'));
    vi.runOnlyPendingTimers();
    expect(sent).toEqual(['a']);

    sessionStore.setActiveCard('b');
    vi.runOnlyPendingTimers();
    expect(sent).toEqual(['a', 'b']);
  });

  it('coalesces a burst into one report', () => {
    const sent: Array<string | null> = [];
    const bridge = { setFrontCard: (c: string | null) => (sent.push(c), Promise.resolve(true)) };
    off = installFrontCardReport(bridge);
    vi.runOnlyPendingTimers();
    sessionStore.setActiveCard('a');
    sessionStore.setActiveCard('b');
    sessionStore.setActiveCard('c');
    vi.runOnlyPendingTimers();
    expect(sent).toEqual([null, 'c']);
  });

  it('no bridge: nothing installed, nothing thrown', () => {
    expect(() => (off = installFrontCardReport(undefined))).not.toThrow();
  });

  it('a send that fails is tried again on the next change, not dropped for good', async () => {
    const sent: Array<string | null> = [];
    let fail = true;
    const bridge = {
      setFrontCard: (c: string | null) => {
        sent.push(c);
        return fail ? Promise.reject(new Error('gone')) : Promise.resolve(true);
      },
    };
    sessionStore.setActiveCard('a');
    off = installFrontCardReport(bridge);
    vi.runOnlyPendingTimers();
    await Promise.resolve();
    await Promise.resolve();
    fail = false;
    window.dispatchEvent(new Event('pointerdown'));
    vi.runOnlyPendingTimers();
    expect(sent).toEqual(['a', 'a']);
  });
});
