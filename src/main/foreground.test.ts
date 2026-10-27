import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  ActivationState,
  ForegroundTracker,
  WM_ACTIVATE,
  WM_ACTIVATEAPP,
  WM_NCACTIVATE,
  flashUntilArrival,
  type TrackableWindow,
} from './foreground';
import { FrontAtEvent, planAttentionRaise, type RaiseFacts } from './attention-raise';
import { visibilityAcross } from './events/rules';

// The message sequences below are the ones `spike/probes/1379/` RECORDED on
// Windows 11 (`spike/findings/1379-isfocused-after-refused-raise.md`). A step
// is one burst: the messages Windows delivers from one call, before the event
// loop turns. `settle()` is the turn.
type Step = ['nc' | 'act', boolean] | 'turn';
function play(s: ActivationState, steps: Step[]): ActivationState {
  for (const st of steps) {
    if (st === 'turn') s.settle();
    else if (st[0] === 'nc') s.caption(st[1]);
    else s.activate(st[1]);
  }
  return s;
}
const fresh = () => new ActivationState({ active: false, front: false });

describe('ActivationState — the rule, against recorded sequences', () => {
  it('an honest activation (caption drawn active, then activate) is in front', () => {
    expect(play(fresh(), [['nc', true], ['act', true], 'turn']).front).toBe(true);
  });

  it('a REFUSED activation (caption drawn inactive, then activate) is not — where Electron says focused', () => {
    const s = play(fresh(), [['nc', false], ['act', true], 'turn']);
    expect(s.active).toBe(true); // Windows' own idea: its thread's active window
    expect(s.front).toBe(false);
  });

  it('the person then really arriving (two active captions, no activate) is in front', () => {
    const s = play(fresh(), [['nc', false], ['act', true], 'turn']);
    play(s, [['nc', true], 'turn']);
    expect(s.front).toBe(false); // one alone could be a blink
    play(s, [['nc', true], 'turn']);
    expect(s.front).toBe(true);
  });

  it("a refused raise's taskbar flash (alternating captions) never reads as arriving", () => {
    const s = play(fresh(), [['nc', false], ['act', true], 'turn']);
    for (let i = 0; i < 6; i++) play(s, [['nc', i % 2 === 1], 'turn']);
    expect(s.front).toBe(false);
  });

  it("#756's swoop on a refused window (a bare activate, no caption) changes nothing", () => {
    const s = play(fresh(), [['nc', false], ['act', true], 'turn']);
    play(s, [['act', true], 'turn']);
    expect(s.front).toBe(false);
  });

  it('...even right after a blink drew the caption active (the real-app sighting)', () => {
    const s = play(fresh(), [['nc', false], ['act', true], 'turn', ['nc', false], 'turn', ['nc', true], 'turn']);
    play(s, [['act', true], 'turn']);
    expect(s.front).toBe(false);
  });

  it('leaving is not in front, whatever came before', () => {
    const s = play(fresh(), [['nc', true], ['act', true], 'turn']);
    play(s, [['nc', false], ['act', false], 'turn']);
    expect(s).toMatchObject({ active: false, front: false });
  });

  it('a blink on a window that is honestly behind never makes it front', () => {
    const s = fresh();
    for (let i = 0; i < 6; i++) play(s, [['nc', i % 2 === 1], 'turn']);
    expect(s.front).toBe(false);
  });

  it('a seed of "front" only counts for a window Windows calls active', () => {
    expect(new ActivationState({ active: false, front: true }).front).toBe(false);
    expect(new ActivationState({ active: true, front: true }).front).toBe(true);
  });
});

/** A window with the Win32 hook, driven by the test the way Windows drives it. */
function fakeWindow(id: number, o: { focused?: boolean; noHook?: boolean } = {}) {
  const hooks = new Map<number, (w: Buffer, l: Buffer) => void>();
  let focused = o.focused ?? false;
  let destroyed = false;
  let onClosed: (() => void) | null = null;
  const buf = (n: number) => {
    const b = Buffer.alloc(8);
    b.writeUInt32LE(n, 0);
    return b;
  };
  const win: TrackableWindow = {
    id,
    isDestroyed: () => destroyed,
    isFocused: () => focused,
    once: (_e: 'closed', l: () => void) => {
      onClosed = l;
      return win;
    },
    ...(o.noHook
      ? {}
      : {
          hookWindowMessage: (m: number, cb: (w: Buffer, l: Buffer) => void) => {
            hooks.set(m, cb);
          },
        }),
  };
  const send = (m: number, v: number) => hooks.get(m)?.(buf(v), buf(0));
  return {
    win,
    hooked: () => [...hooks.keys()].sort((a, b) => a - b),
    /** Electron's own (lying) answer */
    setFocused: (f: boolean) => (focused = f),
    caption: (on: boolean) => send(WM_NCACTIVATE, on ? 1 : 0),
    // WA_CLICKACTIVE (2) in the low word counts as on too
    activate: (on: boolean, code = 1) => send(WM_ACTIVATE, on ? code : 0),
    appActivate: (on: boolean) => send(WM_ACTIVATEAPP, on ? 1 : 0),
    close: () => {
      destroyed = true;
      onClosed?.();
    },
  };
}

/** A tracker whose bursts end when the test says so. */
function tracker(platform: NodeJS.Platform = 'win32', anyFocused = () => false) {
  const pending: Array<() => void> = [];
  const t = new ForegroundTracker({ platform, anyFocused, defer: (fn) => pending.push(fn) });
  const turn = () => pending.splice(0).forEach((fn) => fn());
  return { t, turn };
}

describe('ForegroundTracker (#1379)', () => {
  it('hooks the three activation messages on Windows', () => {
    const { t } = tracker();
    const m = fakeWindow(1);
    t.track(m.win);
    expect(m.hooked()).toEqual([WM_ACTIVATE, WM_ACTIVATEAPP, WM_NCACTIVATE].sort((a, b) => a - b));
  });

  it("THE ISSUE: a refused raise leaves Electron saying focused; the tracker says not in front", () => {
    const { t, turn } = tracker();
    const p = fakeWindow(2);
    t.track(p.win);
    // refused: Windows makes it the thread's active window, caption inactive
    p.caption(false);
    p.activate(true);
    p.setFocused(true); // ...and Electron believes it
    turn();
    expect(p.win.isFocused()).toBe(true);
    expect(t.isFront(p.win)).toBe(false);
    expect(t.frontWindowId(() => 2)).toBeNull();
    expect(t.appHasForeground()).toBe(false);
  });

  it('WA_CLICKACTIVE counts as activation', () => {
    const { t, turn } = tracker();
    const m = fakeWindow(1);
    t.track(m.win);
    m.caption(true);
    m.activate(true, 2);
    turn();
    expect(t.isFront(m.win)).toBe(true);
  });

  it('follows the foreground between our own windows, and away from the app', () => {
    const { t, turn } = tracker();
    const m = fakeWindow(1);
    const p = fakeWindow(2);
    t.track(m.win);
    t.track(p.win);
    m.appActivate(true);
    m.caption(true);
    m.activate(true);
    turn();
    expect(t.frontWindowId(() => null)).toBe(1);
    // to the popout: main deactivated, popout activated, in one burst
    m.caption(false);
    m.activate(false);
    p.caption(true);
    p.activate(true);
    turn();
    expect(t.frontWindowId(() => null)).toBe(2);
    expect(t.appHasForeground()).toBe(true);
    // to another app
    p.caption(false);
    p.activate(false);
    p.appActivate(false);
    m.appActivate(false);
    turn();
    expect(t.frontWindowId(() => null)).toBeNull();
    expect(t.appHasForeground()).toBe(false);
  });

  it('a dialog of ours in front keeps the app in front (no WM_ACTIVATEAPP false)', () => {
    const { t, turn } = tracker();
    const m = fakeWindow(1);
    t.track(m.win);
    m.caption(true);
    m.activate(true);
    turn();
    m.caption(false);
    m.activate(false); // the file dialog took it — still our process
    turn();
    expect(t.frontWindowId(() => null)).toBeNull();
    expect(t.appHasForeground()).toBe(true);
  });

  it('a refused WM_ACTIVATEAPP(true) does not put the app in front', () => {
    const { t, turn } = tracker();
    const p = fakeWindow(2);
    t.track(p.win);
    p.appActivate(true);
    p.caption(false);
    p.activate(true);
    turn();
    expect(t.appHasForeground()).toBe(false);
  });

  it('a popout handed over already focused is seeded from whether the app was in front', () => {
    // the app in front: the main window gave it to its new popout (honest)
    const a = tracker();
    const m = fakeWindow(1);
    a.t.track(m.win);
    m.caption(true);
    m.activate(true);
    a.turn();
    m.caption(false);
    m.activate(false);
    a.turn();
    const p = fakeWindow(2, { focused: true });
    a.t.track(p.win);
    expect(a.t.isFront(p.win)).toBe(true);

    // another app in front (the real-app probe's step 0): a lie from birth
    const b = tracker();
    const m2 = fakeWindow(1);
    b.t.track(m2.win);
    m2.caption(false);
    m2.activate(true);
    b.turn();
    const p2 = fakeWindow(2, { focused: true });
    b.t.track(p2.win);
    expect(b.t.isFront(p2.win)).toBe(false);
  });

  it('a closed window is forgotten, and never answers "in front"', () => {
    const { t, turn } = tracker();
    const p = fakeWindow(2);
    t.track(p.win);
    p.caption(true);
    p.activate(true);
    turn();
    p.close();
    expect(t.isFront(p.win)).toBe(false);
    expect(t.frontWindowId(() => null)).toBeNull();
  });

  it('an untracked window, or another platform, answers the old way', () => {
    const win = tracker();
    const loose = fakeWindow(3, { focused: true });
    expect(win.t.isFront(loose.win)).toBe(true);

    const mac = tracker('darwin', () => true);
    const m = fakeWindow(1, { focused: true });
    mac.t.track(m.win);
    expect(m.hooked()).toEqual([]);
    expect(mac.t.truthful).toBe(false);
    expect(mac.t.isFront(m.win)).toBe(true);
    expect(mac.t.frontWindowId(() => 1)).toBe(1);
    expect(mac.t.appHasForeground()).toBe(true);
  });

  it('a window without the hook is left to the old answer, not half-tracked', () => {
    const { t } = tracker();
    const m = fakeWindow(1, { focused: true, noHook: true });
    t.track(m.win);
    expect(t.isFront(m.win)).toBe(true);
  });

  it('logs changes of the answer, and what Electron said, but not every blink', () => {
    const { t, turn } = tracker();
    const seen: Array<{ message: string; front: boolean; electronSaysFocused: boolean }> = [];
    t.onChange((c) => seen.push({ message: c.message, front: c.front, electronSaysFocused: c.electronSaysFocused }));
    const p = fakeWindow(2);
    t.track(p.win);
    p.caption(false);
    p.setFocused(true);
    p.activate(true);
    turn();
    for (let i = 0; i < 6; i++) {
      p.caption(i % 2 === 1);
      turn();
    }
    expect(seen).toEqual([
      { message: 'tracked', front: false, electronSaysFocused: false },
      { message: 'activate', front: false, electronSaysFocused: true },
    ]);
  });
});

describe('the e2e override (#1468)', () => {
  it('pins every answer to the stated window, over the truth, until cleared', () => {
    const { t, turn } = tracker();
    const m = fakeWindow(1);
    const p = fakeWindow(2);
    t.track(m.win);
    t.track(p.win);
    m.caption(true);
    m.activate(true);
    turn();
    t.setOverride(2);
    expect(t.isFront(p.win)).toBe(true);
    expect(t.isFront(m.win)).toBe(false);
    expect(t.frontWindowId(() => null)).toBe(2);
    expect(t.appHasForeground()).toBe(true);
    t.setOverride(null); // "the user is in another app"
    expect(t.isFront(m.win)).toBe(false);
    expect(t.frontWindowId(() => 1)).toBeNull();
    expect(t.appHasForeground()).toBe(false);
    t.setOverride(undefined); // back to the truth
    expect(t.isFront(m.win)).toBe(true);
    expect(t.frontWindowId(() => null)).toBe(1);
  });

  it('holds off Windows too, where the tracker otherwise answers isFocused()', () => {
    const mac = tracker('darwin', () => true);
    const m = fakeWindow(1, { focused: true });
    mac.t.setOverride(null);
    expect(mac.t.isFront(m.win)).toBe(false);
    expect(mac.t.appHasForeground()).toBe(false);
  });

  it('never calls a destroyed window in front', () => {
    const { t } = tracker();
    const p = fakeWindow(2);
    t.track(p.win);
    t.setOverride(2);
    p.close();
    expect(t.isFront(p.win)).toBe(false);
  });
});

/** a window as the rules see it: visible, not minimized, plus the tracker's facts */
function shown(f: ReturnType<typeof fakeWindow>) {
  return Object.assign(f.win, { isMinimized: () => false, isVisible: () => true });
}

describe("the rules' visibility reads the truth, not the lie (#1468)", () => {
  it('THE ISSUE: after a refused raise Electron says focused; the rules see "visible"', () => {
    const { t, turn } = tracker();
    const m = fakeWindow(1);
    const p = fakeWindow(2);
    t.track(m.win);
    t.track(p.win);
    // a popout opened (or raised) while another app was in front: refused
    p.caption(false);
    p.activate(true);
    p.setFocused(true);
    turn();
    const wins = [shown(m), shown(p)];
    expect(visibilityAcross(wins, (w) => t.isFront(w))).toBe('visible');
    // what the old read said: "focused" — the away-rules held back, the
    // focused-only cue rang for someone in another app
    expect(visibilityAcross(wins)).toBe('focused');
  });

  it('a window really in front is "focused"', () => {
    const { t, turn } = tracker();
    const m = fakeWindow(1);
    t.track(m.win);
    m.caption(true);
    m.activate(true);
    turn();
    expect(visibilityAcross([shown(m)], (w) => t.isFront(w))).toBe('focused');
  });

  it('the person arriving at the lying window makes it "focused" (two active captions)', () => {
    const { t, turn } = tracker();
    const p = fakeWindow(2);
    t.track(p.win);
    p.caption(false);
    p.activate(true);
    p.setFocused(true);
    turn();
    p.caption(true);
    p.caption(true);
    turn();
    expect(visibilityAcross([shown(p)], (w) => t.isFront(w))).toBe('focused');
  });

  it('leaving for another app is "visible" again', () => {
    const { t, turn } = tracker();
    const m = fakeWindow(1);
    t.track(m.win);
    m.caption(true);
    m.activate(true);
    turn();
    m.caption(false);
    m.activate(false);
    m.appActivate(false);
    turn();
    expect(visibilityAcross([shown(m)], (w) => t.isFront(w))).toBe('visible');
  });
});

describe('the attention gate reads the truth, not the lie (#1379)', () => {
  const GO: RaiseFacts = {
    notificationsOn: true,
    inQuietHours: false,
    hasWindow: true,
    hadEvent: true,
    unreachable: null,
    noActivate: false,
    wasFront: false,
  };

  it('a declined raise does not make the NEXT event read "already in front"', () => {
    const { t, turn } = tracker();
    const p = fakeWindow(2);
    t.track(p.win);
    const events = new FrontAtEvent();

    // event 1: the raise is declined (🔔 off) — but dockview's DOM focus() on
    // the popout still runs, and Windows refuses it
    events.note('card', t.frontWindowId(() => null), 1_000);
    expect(planAttentionRaise({ ...GO, notificationsOn: false })).toEqual({
      go: false,
      outcome: 'notifications-off',
    });
    p.caption(false);
    p.activate(true);
    p.setFocused(true);
    turn();

    // event 2, 🔔 back on: what the snapshot reads decides the raise
    events.note('card', t.frontWindowId(() => (p.win.isFocused() ? 2 : null)), 2_000);
    const front = events.frontFor('card', 2_000);
    expect(front).toEqual({ windowId: null });
    expect(planAttentionRaise({ ...GO, wasFront: front?.windowId === p.win.id })).toEqual({ go: true });

    // what the old read (`getFocusedWindow()`) would have said: skipped
    const old = new FrontAtEvent();
    old.note('card', p.win.isFocused() ? p.win.id : null, 2_000);
    expect(planAttentionRaise({ ...GO, wasFront: old.frontFor('card', 2_000)?.windowId === p.win.id })).toEqual({
      go: false,
      outcome: 'already-front',
    });
  });

  it('a window really in front still skips the raise', () => {
    const { t, turn } = tracker();
    const p = fakeWindow(2);
    t.track(p.win);
    p.caption(true);
    p.activate(true);
    turn();
    const events = new FrontAtEvent();
    events.note('card', t.frontWindowId(() => null), 1_000);
    expect(planAttentionRaise({ ...GO, wasFront: events.frontFor('card', 1_000)?.windowId === 2 })).toEqual({
      go: false,
      outcome: 'already-front',
    });
  });
});

describe('wiring in main/index.ts (#1379)', () => {
  // read from SOURCE: index.ts runs the whole app at import
  const src = fs.readFileSync(path.resolve(__dirname, 'index.ts'), 'utf8');

  it('tracks the main window and every popout', () => {
    expect(src).toContain('foreground.track(win);');
    expect(src).toContain('foreground.track(child);');
  });

  it('the event-time snapshot, both raises and the flash guard read the tracker', () => {
    expect(src).toContain('const frontId = foreground.frontWindowId(');
    expect(src).toContain('frontAtEvent.note(card, frontId, Date.now());');
    expect(src).not.toMatch(/frontAtEvent\.note\(card, BrowserWindow\.getFocusedWindow/);
    expect(src.match(/isFront: \(\) => foreground\.isFront\(win!?\)/g)).toHaveLength(3);
    expect(src).toContain('isFront: (w) => foreground.isFront(w)');
    expect(src).toContain('const ourWindowHasFocus = (): boolean => foreground.appHasForeground();');
  });

  it("the rules' visibility reads the tracker, and the e2e seam is non-packaged only (#1468)", () => {
    expect(src).toContain(
      'visibilityAcross([currentWindow, ...popoutWindows.map((p) => p.win)], (w) => foreground.isFront(w));'
    );
    expect(src).toContain('getVisibility: appVisibility,');
    // the one call: no second, unconverted reading of "is the app focused"
    expect(src.split('visibilityAcross(').length - 1).toBe(1);
    // the seam sits inside the non-packaged guard: between the guard's `{` and
    // the seam, more braces open than close (the block has not ended)
    const seam = src.indexOf('__switchboardForeground = {');
    const guard = src.lastIndexOf('if (!app.isPackaged) {', seam);
    expect(seam).toBeGreaterThan(0);
    expect(guard).toBeGreaterThan(0);
    const between = src.slice(guard, seam);
    expect(between.split('{').length).toBeGreaterThan(between.split('}').length);
    expect(src.match(/__switchboardForeground = \{/g)).toHaveLength(1);
  });

  it('the swoop: our other windows step aside unless the app is in front now; a blinking one stays (#1468)', () => {
    expect(src).toContain('others: foreground.appHasForeground()');
    expect(src).toContain('blinking: (o) => isFlashing(o),');
    expect(src).toContain('if (isSteppedAside(w)) return null;');
  });
});

describe('flashUntilArrival — the one taskbar blink (#1379)', () => {
  function win() {
    const calls: string[] = [];
    const listeners = new Map<string, () => void>();
    const w = {
      isDestroyed: () => false,
      flashFrame: (f: boolean) => calls.push(`flash:${f}`),
      once: (e: 'focus' | 'blur', l: () => void) => {
        listeners.set(e, l);
        return w;
      },
      removeListener: (e: 'focus' | 'blur') => {
        listeners.delete(e);
        return w;
      },
    };
    return { w, calls, listeners, fire: (e: string) => listeners.get(e)?.() };
  }

  it('blinks once, however many signals ask, until the person arrives', () => {
    const x = win();
    expect(flashUntilArrival(x.w)).toBe(true);
    expect(flashUntilArrival(x.w)).toBe(false);
    expect(x.calls).toEqual(['flash:true']);
    x.fire('focus');
    expect(x.calls).toEqual(['flash:true', 'flash:false']);
    expect(x.listeners.size).toBe(0);
    expect(flashUntilArrival(x.w)).toBe(true);
  });

  it('a blur ends the wait but does not stop a blink nobody may have seen', () => {
    const x = win();
    flashUntilArrival(x.w);
    x.fire('blur');
    expect(x.calls).toEqual(['flash:true']);
    expect(x.listeners.size).toBe(0);
    expect(flashUntilArrival(x.w)).toBe(true);
  });
});
