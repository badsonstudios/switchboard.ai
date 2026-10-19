import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  FrontAtEvent,
  RAISE_EVENT_KINDS,
  logRaise,
  performAttentionRaise,
  planAttentionRaise,
  RAISE_SETTLE_MS,
  type RaiseFacts,
  type RaiseTarget,
} from './attention-raise';

const GO: RaiseFacts = {
  notificationsOn: true,
  inQuietHours: false,
  hasWindow: true,
  hadEvent: true,
  unreachable: null,
  noActivate: false,
  wasFront: false,
};

describe('RAISE_EVENT_KINDS', () => {
  it("is exactly the renderer's REVEAL_KINDS — a kind added there must reach main's snapshot too", () => {
    // read from SOURCE: main's tsconfig does not compile renderer modules
    const src = fs.readFileSync(path.resolve(__dirname, '../renderer/src/lib/ladder.ts'), 'utf8');
    const block = /export const REVEAL_KINDS[^=]*=\s*\[([^\]]*)\]/.exec(src);
    expect(block, 'REVEAL_KINDS not found in lib/ladder.ts').not.toBeNull();
    const reveal = [...block![1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect([...RAISE_EVENT_KINDS].sort()).toEqual(reveal.sort());
  });
});

describe('planAttentionRaise — the gate (#756)', () => {
  it('raises when nothing stands in the way', () => {
    expect(planAttentionRaise(GO)).toEqual({ go: true });
  });

  it('each gate alone stops it, with its own outcome', () => {
    expect(planAttentionRaise({ ...GO, notificationsOn: false })).toEqual({ go: false, outcome: 'notifications-off' });
    expect(planAttentionRaise({ ...GO, inQuietHours: true })).toEqual({ go: false, outcome: 'quiet-hours' });
    expect(planAttentionRaise({ ...GO, hasWindow: false })).toEqual({ go: false, outcome: 'no-window' });
    // main raises only for a session IT saw call — never on the renderer's word
    expect(planAttentionRaise({ ...GO, hadEvent: false })).toEqual({ go: false, outcome: 'no-event' });
    expect(planAttentionRaise({ ...GO, unreachable: 'off every attached display' })).toEqual({
      go: false,
      outcome: 'unreachable',
      detail: 'off every attached display',
    });
    expect(planAttentionRaise({ ...GO, noActivate: true })).toEqual({ go: false, outcome: 'no-activate' });
    expect(planAttentionRaise({ ...GO, wasFront: true })).toEqual({ go: false, outcome: 'already-front' });
  });

  it("the person's own 'not now' outranks every fact about windows", () => {
    // the master switch first, then the schedule — the documented precedence
    const all: RaiseFacts = {
      notificationsOn: false,
      inQuietHours: true,
      hasWindow: false,
      hadEvent: false,
      unreachable: 'hidden',
      noActivate: true,
      wasFront: true,
    };
    expect(planAttentionRaise(all)).toMatchObject({ outcome: 'notifications-off' });
    expect(planAttentionRaise({ ...all, notificationsOn: true })).toMatchObject({ outcome: 'quiet-hours' });
  });

  it('the no-activate seam wins over "it was already in front" — a quiet run never decides by focus', () => {
    expect(planAttentionRaise({ ...GO, noActivate: true, wasFront: true })).toMatchObject({ outcome: 'no-activate' });
  });

  it('an unreachable window is never raised, quiet seam or not', () => {
    expect(planAttentionRaise({ ...GO, unreachable: 'minimized, and it would come back off every attached display', noActivate: true })).toMatchObject({
      outcome: 'unreachable',
    });
  });
});

/** a window stand-in whose focus answer is set by the test */
function target(opts: { focusedAfter: boolean; destroyedAfter?: boolean }) {
  const calls: string[] = [];
  let raised = false;
  let onFocus: (() => void) | null = null;
  const w: RaiseTarget & { calls: string[]; arrive: () => void } = {
    calls,
    isDestroyed: () => raised && opts.destroyedAfter === true,
    isMinimized: () => false,
    isFullScreen: () => false,
    isFocused: () => raised && opts.focusedAfter,
    restore: () => calls.push('restore'),
    minimize: () => calls.push('minimize'),
    show: () => calls.push('show'),
    showInactive: () => calls.push('showInactive'),
    focus: () => calls.push('focus'),
    flashFrame: (f: boolean) => calls.push(`flash:${f}`),
    once: (_ev: 'focus', l: () => void) => {
      onFocus = l;
      return w;
    },
    arrive: () => onFocus?.(),
  };
  const raise = () => {
    raised = true;
    calls.push('raise');
    return 'minimize-restore' as const;
  };
  return { w, raise };
}

describe('performAttentionRaise — raise, check, fall back honestly', () => {
  const waits: number[] = [];
  const wait = (ms: number) => {
    waits.push(ms);
    return Promise.resolve();
  };

  it('the OS gave us the foreground: raised, and no flash', async () => {
    const { w, raise } = target({ focusedAfter: true });
    await expect(performAttentionRaise(w, { raise, wait })).resolves.toEqual({
      outcome: 'raised',
      technique: 'minimize-restore',
    });
    expect(w.calls).toEqual(['raise']);
    expect(waits.at(-1)).toBe(RAISE_SETTLE_MS);
  });

  it('the OS refused: the flash on THAT window, cleared when the person arrives', async () => {
    const { w, raise } = target({ focusedAfter: false });
    await expect(performAttentionRaise(w, { raise, wait })).resolves.toMatchObject({ outcome: 'refused' });
    expect(w.calls).toEqual(['raise', 'flash:true']);
    w.arrive();
    expect(w.calls).toEqual(['raise', 'flash:true', 'flash:false']);
  });

  it('a window that closed meanwhile is reported as gone, and nothing is flashed', async () => {
    const { w, raise } = target({ focusedAfter: false, destroyedAfter: true });
    await expect(performAttentionRaise(w, { raise, wait })).resolves.toMatchObject({ outcome: 'no-window' });
    expect(w.calls).toEqual(['raise']);
  });

  it('`none` (full screen on Windows): refused AT ONCE — no wait, straight to the flash', async () => {
    const { w } = target({ focusedAfter: true });
    const before = waits.length;
    await expect(performAttentionRaise(w, { raise: () => 'none', wait })).resolves.toEqual({
      outcome: 'refused',
      technique: 'none',
    });
    expect(waits.length).toBe(before);
    expect(w.calls).toEqual(['flash:true']);
  });

  it('backstops: a quiet or destroyed answer from the raise is never read as a refusal', async () => {
    const { w } = target({ focusedAfter: false });
    await expect(performAttentionRaise(w, { raise: () => 'quiet', wait })).resolves.toMatchObject({
      outcome: 'no-activate',
    });
    await expect(performAttentionRaise(w, { raise: () => 'destroyed', wait })).resolves.toMatchObject({
      outcome: 'no-window',
    });
    expect(w.calls).toEqual([]);
  });
});

describe('FrontAtEvent — where the person was when the session called', () => {
  it('answers from the snapshot taken at the event, per card', () => {
    const f = new FrontAtEvent(10_000);
    f.note('a', 7, 1_000);
    f.note('b', null, 1_200);
    // a later event for ANOTHER card does not overwrite this card's answer
    expect(f.frontFor('a', 1_500)).toEqual({ windowId: 7 });
    expect(f.frontFor('b', 1_500)).toEqual({ windowId: null });
  });

  it('no recent event for the card: undefined (the no-event gate)', () => {
    const f = new FrontAtEvent(10_000);
    expect(f.frontFor('a', 0)).toBeUndefined();
    f.note('a', 1, 0);
    expect(f.frontFor('a', 20_000)).toBeUndefined();
  });

  it('prunes stale records on write, so it cannot grow with every session ever seen', () => {
    const f = new FrontAtEvent(10_000);
    f.note('old', 1, 0);
    f.note('new', 2, 20_000);
    expect(f.frontFor('old', 0)).toBeUndefined();
    expect(f.frontFor('new', 20_000)).toEqual({ windowId: 2 });
  });
});

describe('logRaise', () => {
  it('logs every outcome at info, with the fields a reader needs', () => {
    const lines: Array<[string, unknown]> = [];
    const log = { info: (m: string, f?: unknown) => lines.push([m, f]) };
    logRaise(log, { outcome: 'refused', window: 'popout', technique: 'minimize-restore' }, 'card-1');
    logRaise(log, { outcome: 'quiet-hours', window: 'main' });
    expect(lines[0][0]).toMatch(/attention raise: the OS kept another app in front/);
    expect(lines[0][1]).toEqual({ outcome: 'refused', window: 'popout', technique: 'minimize-restore', cardId: 'card-1' });
    expect(lines[1]).toEqual(['attention raise: not raised: quiet hours', { outcome: 'quiet-hours', window: 'main' }]);
  });
});
