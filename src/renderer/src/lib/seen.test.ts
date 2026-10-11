// @vitest-environment jsdom
// "I looked at it" (#1219): the three ways a finished session stops being
// counted, and the one thing that must never clear by being looked at.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { sessionStore } from '../store/session-store';
import type { EventDto } from '../model/types';
import {
  installSeenWatch,
  markAllSeen,
  markSeen,
  SEEN_INPUT_WINDOW_MS,
  seenWhileWatching,
} from './seen';

const ev = (id: number, sessionId: string, kind: EventDto['kind']): EventDto =>
  ({ id, sessionId, kind, at: '2026-10-10T00:00:00.000Z' });

let ack: ReturnType<typeof vi.fn<(id: string) => Promise<void>>>;
let off: (() => void) | null = null;
let focused = true;

/** a click somewhere in the window that is NOT the card: the list, a menu */
const press = (): void => {
  window.dispatchEvent(new Event('pointerdown'));
};

/** the body of the card in front, as dockview draws it */
function cardBody(): HTMLElement {
  document.body.innerHTML =
    '<div class="dv-groupview dv-active-group"><div class="dv-tabs-container"><button id="tab"></button></div>' +
    '<div class="dv-content-container"><textarea id="composer"></textarea></div></div>' +
    '<div class="dv-groupview"><div class="dv-content-container"><textarea id="other"></textarea></div></div>';
  return document.getElementById('composer')!;
}
const touch = (el: Element, kind = 'keydown'): void => {
  el.dispatchEvent(new Event(kind, { bubbles: true }));
};

beforeEach(() => {
  ack = vi.fn<(id: string) => Promise<void>>(() => Promise.resolve());
  (window as unknown as { switchboard: unknown }).switchboard = { events: { ack } };
  focused = true;
  vi.spyOn(document, 'hasFocus').mockImplementation(() => focused);
  sessionStore.setEvents([]);
  sessionStore.setActiveCard(null);
  for (const [live, card] of [
    ['live-a', 'a'],
    ['live-b', 'b'],
    ['live-c', 'c'],
  ]) {
    sessionStore.mapLiveToCard(live, card);
  }
});

afterEach(() => {
  off?.();
  off = null;
  sessionStore.setEvents([]);
  sessionStore.setActiveCard(null);
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('finished in front of you: visible is not seen', () => {
  const now = 1_000_000;
  it('counts as seen with the window focused and used in the last minute', () => {
    expect(seenWhileWatching({ windowFocused: true, lastInputAt: now - 5_000, now })).toBe(true);
    expect(
      seenWhileWatching({ windowFocused: true, lastInputAt: now - SEEN_INPUT_WINDOW_MS, now })
    ).toBe(true);
  });

  it('does not when you are away: on screen is not looked at', () => {
    expect(
      seenWhileWatching({ windowFocused: true, lastInputAt: now - SEEN_INPUT_WINDOW_MS - 1, now })
    ).toBe(false);
    expect(seenWhileWatching({ windowFocused: true, lastInputAt: null, now })).toBe(false);
  });

  it('does not when another application has the keyboard', () => {
    expect(seenWhileWatching({ windowFocused: false, lastInputAt: now - 5_000, now })).toBe(false);
  });

  it('a click a moment ago is proof enough, whatever focus says in that instant', () => {
    // the click that brings the window forward lands before focus does
    expect(seenWhileWatching({ windowFocused: false, lastInputAt: now - 200, now })).toBe(true);
  });
});

describe('marking as seen', () => {
  it('acknowledges the finished session on that card, by its live id', () => {
    sessionStore.setEvents([ev(1, 'live-a', 'done'), ev(2, 'live-b', 'done')]);
    markSeen('a');
    expect(ack.mock.calls).toEqual([['live-a']]);
  });

  it.each(['needs-permission', 'needs-input', 'crashed'] as const)(
    'NEVER acknowledges a %s: only finished work clears by being looked at',
    (kind) => {
      sessionStore.setEvents([ev(1, 'live-a', kind)]);
      markSeen('a');
      expect(ack).not.toHaveBeenCalled();
    }
  );

  it('is a no-op for a calm card, an unknown one, and no card', () => {
    sessionStore.setEvents([ev(1, 'live-a', 'ready')]);
    markSeen('a');
    markSeen('nobody');
    markSeen(null);
    expect(ack).not.toHaveBeenCalled();
  });

  it('the "N finished" button clears every finished session and nothing else', () => {
    sessionStore.setEvents([
      ev(1, 'live-a', 'done'),
      ev(2, 'live-b', 'needs-permission'),
      ev(3, 'live-c', 'done'),
    ]);
    markAllSeen();
    expect(ack.mock.calls.map((c) => c[0]).sort()).toEqual(['live-a', 'live-c']);
  });
});

describe('the watch: three ways of looking', () => {
  it('1. you GO to it: a click, then the card in front changes', () => {
    off = installSeenWatch();
    sessionStore.setEvents([ev(1, 'live-b', 'done')]);
    sessionStore.setActiveCard('a');
    expect(ack).not.toHaveBeenCalled();
    press(); // the click on b's row or tab
    sessionStore.setActiveCard('b');
    expect(ack.mock.calls).toEqual([['live-b']]);
  });

  it('...but a card that came forward with NOBODY THERE has not been looked at', () => {
    // "always jump to it" brings a finished session to the front; closing a
    // card puts its neighbour there. With no input in the window, nobody saw.
    // (With somebody using the window it does count: it was put in front of
    // a person who is there.)
    off = installSeenWatch();
    sessionStore.setActiveCard('a');
    sessionStore.setEvents([ev(1, 'live-b', 'done')]);
    sessionStore.setActiveCard('b');
    expect(ack).not.toHaveBeenCalled();
  });

  it('2. you TOUCH it: a click or a key in the card already in front', () => {
    off = installSeenWatch();
    sessionStore.setActiveCard('a');
    sessionStore.setEvents([ev(1, 'live-a', 'done')]);
    expect(ack).not.toHaveBeenCalled(); // finished while you were away
    touch(cardBody());
    expect(ack.mock.calls).toEqual([['live-a']]);
  });

  it('...INSIDE it: a click on the list, a tab or another card is not touching it', async () => {
    // the first version cleared on any input in the window, which cleared a
    // session while its own "Mark as seen" menu was still opening
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    off = installSeenWatch();
    sessionStore.setActiveCard('a');
    cardBody();
    // long enough ago that "you were just here" does not apply
    vi.setSystemTime(1_800_000_000_000 + SEEN_INPUT_WINDOW_MS * 2);
    focused = false;
    sessionStore.setEvents([ev(1, 'live-a', 'done')]);
    press();
    touch(document.getElementById('tab')!, 'pointerdown');
    touch(document.getElementById('other')!, 'pointerdown');
    expect(ack).not.toHaveBeenCalled();
    // a scroll in the card is reading it
    touch(document.getElementById('composer')!, 'wheel');
    expect(ack.mock.calls).toEqual([['live-a']]);
  });

  it('a card popped out into its own window is not cleared by input in THIS one', () => {
    off = installSeenWatch();
    sessionStore.setActiveCard('a');
    sessionStore.setPresentation('a', { poppedOut: true });
    try {
      press();
      sessionStore.setEvents([ev(1, 'live-a', 'done')]);
      touch(cardBody());
      expect(ack).not.toHaveBeenCalled();
    } finally {
      sessionStore.setPresentation('a', { poppedOut: false });
    }
  });

  it('3. it finishes IN FRONT OF YOU while you are using the window', () => {
    off = installSeenWatch();
    sessionStore.setActiveCard('a');
    press(); // you are here
    sessionStore.setEvents([ev(1, 'live-a', 'done')]);
    expect(ack.mock.calls).toEqual([['live-a']]);
  });

  it('...not while the window is in the background', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    off = installSeenWatch();
    sessionStore.setActiveCard('a');
    press();
    // ten seconds later you are in another application
    vi.setSystemTime(1_800_000_010_000);
    focused = false;
    sessionStore.setEvents([ev(1, 'live-a', 'done')]);
    expect(ack).not.toHaveBeenCalled();
  });

  it('...and not when you stepped away more than a minute ago', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    off = installSeenWatch();
    sessionStore.setActiveCard('a');
    press();
    vi.setSystemTime(1_800_000_000_000 + SEEN_INPUT_WINDOW_MS + 1000);
    sessionStore.setEvents([ev(1, 'live-a', 'done')]);
    expect(ack).not.toHaveBeenCalled();
  });

  it('finished while you were away: ANOTHER session speaking up does not clear it', () => {
    // you come back, click somewhere that is not the card, and a different
    // session's event lands a moment later. Nothing happened to this card.
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    off = installSeenWatch();
    sessionStore.setActiveCard('a');
    focused = false;
    sessionStore.setEvents([ev(1, 'live-a', 'done')]);
    focused = true;
    vi.setSystemTime(1_800_000_000_000 + SEEN_INPUT_WINDOW_MS * 2);
    press();
    sessionStore.setEvents([ev(1, 'live-a', 'done'), ev(2, 'live-b', 'needs-input')]);
    sessionStore.setEvents([ev(1, 'live-a', 'done'), ev(3, 'live-c', 'done')]);
    expect(ack).not.toHaveBeenCalled();
  });

  it('a session finishing somewhere ELSE is not seen by your being busy here', () => {
    off = installSeenWatch();
    sessionStore.setActiveCard('a');
    press();
    sessionStore.setEvents([ev(1, 'live-b', 'done')]);
    expect(ack).not.toHaveBeenCalled();
  });

  it('looking at a session holding a PERMISSION clears nothing', () => {
    off = installSeenWatch();
    sessionStore.setEvents([ev(1, 'live-b', 'needs-permission')]);
    press();
    sessionStore.setActiveCard('b');
    touch(cardBody());
    expect(ack).not.toHaveBeenCalled();
  });

  it('stops when torn down', () => {
    off = installSeenWatch();
    off();
    off = null;
    sessionStore.setActiveCard('a');
    sessionStore.setEvents([ev(1, 'live-a', 'done')]);
    press();
    expect(ack).not.toHaveBeenCalled();
  });
});
