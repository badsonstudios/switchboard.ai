// @vitest-environment jsdom
// The root-level surfaces, again, in each popped-out window (#1022).
//
// The popout here is an IFRAME's window, on purpose: it is a real second
// document with its own `Element`, which is the thing a popped-out window is
// and the thing a hand-built `{ document }` stand-in is not. The last-prompt
// box failed in popouts on exactly that (`instanceof Element` across windows),
// and a stand-in sharing this window's classes would have passed it.
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { initI18nForTests } from '../i18n/test-i18n';
import {
  announce,
  holdAnnouncements,
  resetAnnouncementsForTest,
  voiceWindow,
} from '../lib/live-region';
import { addPopoutWindow, removePopoutWindow, resetPopoutWindows } from '../lib/popout-windows';
import { sessionStore } from '../store/session-store';
import { LAST_PROMPT_ATTR, LAST_PROMPT_DELAY_MS, LastPromptHover } from './LastPromptHover';
import { LiveRegion } from './LiveRegion';
import { PopoutSurfaces } from './PopoutSurfaces';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let root: Root | null = null;
let frame: HTMLIFrameElement;
let popout: Window;
/** which window "has the keyboard"; jsdom has no real focus between windows */
let focused: Window | null;

const said = (doc: Document): string =>
  Array.from(doc.querySelectorAll('[data-live-region]'))
    .map((n) => n.textContent ?? '')
    .join('');
const settle = async (): Promise<void> => {
  for (let i = 0; i < 4; i++) await act(async () => Promise.resolve());
};
const box = (doc: Document): HTMLElement | null =>
  doc.querySelector<HTMLElement>('[data-testid="last-prompt-hover"]');

function surface(doc: Document, cardId: string): HTMLElement {
  const el = doc.createElement('div');
  el.setAttribute(LAST_PROMPT_ATTR, cardId);
  el.textContent = cardId;
  doc.body.appendChild(el);
  return el;
}

/** a pointer event made by the window it is fired in, as a real one would be */
function over(target: HTMLElement): void {
  const view = target.ownerDocument.defaultView as Window & typeof globalThis;
  const e = new view.MouseEvent('pointerover', { bubbles: true });
  act(() => void target.dispatchEvent(e));
}

beforeAll(async () => {
  await initI18nForTests();
});

beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '';
  resetPopoutWindows();
  resetAnnouncementsForTest();
  vi.useFakeTimers();

  frame = document.createElement('iframe');
  document.body.appendChild(frame);
  popout = frame.contentWindow!;
  focused = null;
  vi.spyOn(document, 'hasFocus').mockImplementation(() => focused === window);
  vi.spyOn(popout.document, 'hasFocus').mockImplementation(() => focused === popout);

  (window as unknown as { switchboard: unknown }).switchboard = {
    transcripts: { lastPrompt: () => Promise.resolve({ text: 'now add the tests', cut: false }) },
  };
  sessionStore.setSessions([
    { id: 'c1', title: 'api', folder: '/p/api', liveId: 'live-1' },
  ] as Parameters<typeof sessionStore.setSessions>[0]);

  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  // as `App` mounts them: the main window's own two, and the popout set
  await act(async () =>
    root!.render(
      <>
        <LiveRegion />
        <LastPromptHover />
        <PopoutSurfaces />
      </>
    )
  );
});

afterEach(async () => {
  if (root) {
    const r = root;
    root = null;
    await act(async () => r.unmount());
  }
  vi.restoreAllMocks();
  vi.useRealTimers();
  resetPopoutWindows();
  sessionStore.setSessions([]);
});

describe('a popped-out window gets the root surfaces of its own (issue 1022)', () => {
  it('has no live region until it is a popout, and two once it is', async () => {
    expect(popout.document.querySelectorAll('[data-live-region]')).toHaveLength(0);
    await act(async () => addPopoutWindow(popout));
    const regions = popout.document.querySelectorAll('[data-live-region]');
    expect(regions).toHaveLength(2);
    // the same two polite regions the main window has, in THAT document
    for (const r of regions) expect(r.getAttribute('aria-live')).toBe('polite');
    expect(document.querySelectorAll('[data-live-region]')).toHaveLength(2);
  });

  it('says an announcement in the window that has the keyboard, and only there', async () => {
    await act(async () => addPopoutWindow(popout));

    focused = popout;
    await act(async () => announce('Collapsed. Press again to hide.'));
    await settle();
    expect(said(popout.document)).toBe('Collapsed. Press again to hide.');
    expect(said(document)).toBe(''); // ONE voice: not said twice

    focused = window;
    await act(async () => announce('Back in the grid.'));
    await settle();
    expect(said(document)).toBe('Back in the grid.');
    // the popout still holds what it last said, and was not told this one
    expect(said(popout.document)).toBe('Collapsed. Press again to hide.');
  });

  it('falls to the main window when no window has the keyboard', async () => {
    await act(async () => addPopoutWindow(popout));
    focused = null; // the app is in the background
    await act(async () => announce('A session needs you.'));
    await settle();
    expect(said(document)).toBe('A session needs you.');
    expect(said(popout.document)).toBe('');
  });

  it('with two popouts, only the focused one speaks', async () => {
    const frame2 = document.createElement('iframe');
    document.body.appendChild(frame2);
    const second = frame2.contentWindow!;
    vi.spyOn(second.document, 'hasFocus').mockImplementation(() => focused === second);
    await act(async () => {
      addPopoutWindow(popout);
      addPopoutWindow(second);
    });
    focused = second;
    await act(async () => announce('Hidden.'));
    await settle();
    expect(said(second.document)).toBe('Hidden.');
    expect(said(popout.document)).toBe('');
    expect(said(document)).toBe('');
  });

  it('takes its region away when the popout closes, and the main window speaks again', async () => {
    await act(async () => addPopoutWindow(popout));
    focused = popout;
    await act(async () => removePopoutWindow(popout));
    expect(popout.document.querySelectorAll('[data-live-region]')).toHaveLength(0);
    // a window that is no longer a popout is not asked, whatever it says of focus
    await act(async () => announce('Docked back.'));
    await settle();
    expect(said(document)).toBe('Docked back.');
  });

  // WHERE A CALLER SAYS IT GOES beats where the keyboard is. The popout key
  // bridge needs this: a chord that RUNS brings the main window forward, so
  // its sentence is made while the popout still has focus and belongs in the
  // window the user is about to be in.
  describe('held until the caller knows which window the user ends up in', () => {
    it('a chord that ran from a popout is said in the MAIN window, though the popout has focus', async () => {
      await act(async () => addPopoutWindow(popout));
      focused = popout; // where the key was pressed
      const say = holdAnnouncements();
      await act(async () => announce('api pinned'));
      await settle();
      // not yet, anywhere: nobody knows where the user will be
      expect(said(document)).toBe('');
      expect(said(popout.document)).toBe('');

      await act(async () => say(window)); // the main window was raised
      await settle();
      expect(said(document)).toBe('api pinned');
      expect(said(popout.document)).toBe('');
    });

    it('a chord REFUSED in a popout is said in that popout, even if focus says otherwise', async () => {
      await act(async () => addPopoutWindow(popout));
      focused = window; // what a harness, or a slow window manager, might claim
      const say = holdAnnouncements();
      await act(async () => announce('No session is focused'));
      await act(async () => say(popout));
      await settle();
      expect(said(popout.document)).toBe('No session is focused');
      expect(said(document)).toBe('');
    });

    it('with no window named, it goes wherever the keyboard is by then', async () => {
      await act(async () => addPopoutWindow(popout));
      focused = window;
      const say = holdAnnouncements();
      await act(async () => announce('Jumped to web'));
      focused = popout; // the command raised a popout meanwhile
      await act(async () => say());
      await settle();
      expect(said(popout.document)).toBe('Jumped to web');
      expect(said(document)).toBe('');
    });

    it('keeps the order, and says nothing twice', async () => {
      const say = holdAnnouncements();
      await act(async () => {
        announce('one');
        announce('two');
      });
      await act(async () => say(window));
      await settle();
      await settle();
      // the region shows one sentence at a time; the last one in is the last out
      expect(said(document)).toBe('two');
      await act(async () => say(window)); // a second release is a no-op
      await settle();
      expect(said(document)).toBe('two');
    });

    it('nested: the OUTERMOST release decides', async () => {
      await act(async () => addPopoutWindow(popout));
      const outer = holdAnnouncements();
      const inner = holdAnnouncements();
      await act(async () => announce('Collapsed.'));
      await act(async () => inner(popout)); // an inner caller cannot know more
      await settle();
      expect(said(popout.document)).toBe('');
      expect(said(document)).toBe('');
      await act(async () => outer(window));
      await settle();
      expect(said(document)).toBe('Collapsed.');
      expect(said(popout.document)).toBe('');
    });

    it('a window named but with no region in it falls back, rather than dropping the sentence', async () => {
      // the popout is NOT registered, so nothing is mounted in it
      focused = null;
      const say = holdAnnouncements();
      await act(async () => announce('Still said.'));
      await act(async () => say(popout));
      await settle();
      expect(said(document)).toBe('Still said.');
    });

    it('a release that never comes holds only until it does: later sentences wait too', async () => {
      const say = holdAnnouncements();
      await act(async () => announce('first'));
      await settle();
      expect(said(document)).toBe('');
      await act(async () => say());
      await settle();
      expect(said(document)).toBe('first');
      // and after the release, announcements are immediate again
      await act(async () => announce('second'));
      await settle();
      expect(said(document)).toBe('second');
    });
  });

  it('a window that closed under us is skipped, not thrown on', () => {
    const dead = {
      get document(): Document {
        throw new Error('closed');
      },
    } as unknown as Window;
    expect(voiceWindow([dead])).toBe(window);
    expect(voiceWindow([dead, popout])).toBe(window);
    focused = popout;
    expect(voiceWindow([dead, popout])).toBe(popout);
  });
});

describe('the last-prompt box in a popped-out window', () => {
  it('opens for a session hovered IN the popout, and is drawn in the popout', async () => {
    await act(async () => addPopoutWindow(popout));
    const el = surface(popout.document, 'c1');
    // the trap this was caught in: this element is not an `Element` of ours
    expect(el instanceof Element).toBe(false);

    over(el);
    await act(async () => void vi.advanceTimersByTime(LAST_PROMPT_DELAY_MS + 10));
    await settle();
    expect(box(popout.document)?.textContent).toContain('now add the tests');
    // not in the window the pointer is not in
    expect(box(document)).toBeNull();
  });

  it('the main window is untouched: a hover there still opens there', async () => {
    await act(async () => addPopoutWindow(popout));
    const el = surface(document, 'c1');
    over(el);
    await act(async () => void vi.advanceTimersByTime(LAST_PROMPT_DELAY_MS + 10));
    await settle();
    expect(box(document)?.textContent).toContain('now add the tests');
    expect(box(popout.document)).toBeNull();
  });

  it('goes with the popout', async () => {
    await act(async () => addPopoutWindow(popout));
    const el = surface(popout.document, 'c1');
    over(el);
    await act(async () => void vi.advanceTimersByTime(LAST_PROMPT_DELAY_MS + 10));
    await settle();
    expect(box(popout.document)).not.toBeNull();
    const unhook = vi.spyOn(popout.document, 'removeEventListener');
    await act(async () => removePopoutWindow(popout));
    expect(box(popout.document)).toBeNull();
    // the listeners were really taken off that document, not merely orphaned
    expect(unhook.mock.calls.map((c) => c[0])).toContain('pointerover');
    // and a later hover opens nothing
    over(el);
    await act(async () => void vi.advanceTimersByTime(LAST_PROMPT_DELAY_MS + 10));
    await settle();
    expect(box(popout.document)).toBeNull();
    expect(box(document)).toBeNull();
  });
});
