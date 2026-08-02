import { describe, it, expect } from 'vitest';
import {
  buildLamps,
  isLit,
  litCount,
  markLit,
  nextLitExpiry,
  pruneLit,
  URGENCY_LINGER_MS,
} from './urgency';

const T = 1_000_000; // an arbitrary "now"

const session = (id: string, status?: string): { id: string; title: string; status?: string } => ({
  id,
  title: id.toUpperCase(),
  status,
});

describe('buildLamps — one lamp per session, live status (E9-04)', () => {
  it("keeps the caller's order, so the Nth lamp is the Nth Ctrl+1..9 target", () => {
    const lamps = buildLamps([session('c'), session('a'), session('b')], new Map(), T);
    expect(lamps.map((l) => l.cardId)).toEqual(['c', 'a', 'b']);
  });

  it('maps every status the rail knows onto the same six-way ramp', () => {
    const lamps = buildLamps(
      [
        session('working', 'working'),
        session('starting', 'starting'),
        session('input', 'needs-input'),
        session('perm', 'needs-permission'),
        session('idle', 'idle'),
        session('done', 'done'),
        session('crash', 'crashed'),
      ],
      new Map(),
      T
    );
    expect(lamps.map((l) => l.token)).toEqual([
      'working',
      'working',
      'needs-input',
      'needs-permission',
      'idle',
      'done',
      'crashed',
    ]);
    // 'needs you' is the rail's rule, unchanged: done is in the set (§5.8's
    // completed-unreviewed state), working and idle are not
    expect(lamps.filter((l) => l.needsYou).map((l) => l.cardId)).toEqual([
      'input',
      'perm',
      'done',
      'crash',
    ]);
  });

  it('shows a SUSPENDED session — it folds to the idle hue but says which it is', () => {
    const [lamp] = buildLamps([session('s', 'suspended')], new Map(), T);
    expect(lamp.token).toBe('idle');
    expect(lamp.suspended).toBe(true);
    expect(lamp.needsYou).toBe(false);
    expect(lamp.labelKey).toBe('railStatus.suspended');
    // and a genuinely idle one is NOT flagged suspended
    expect(buildLamps([session('i', 'idle')], new Map(), T)[0].suspended).toBe(false);
  });

  it('fails open: an unknown status reads as idle, never as an alarm', () => {
    const [lamp] = buildLamps([session('x', 'no-such-status')], new Map(), T);
    expect(lamp.token).toBe('idle');
    expect(lamp.needsYou).toBe(false);
    // a missing status too
    expect(buildLamps([session('y')], new Map(), T)[0].token).toBe('idle');
  });

  it('lights the lamp the last jump landed on, and only that one', () => {
    const lit = new Map([['b', T + 500]]);
    const lamps = buildLamps([session('a'), session('b'), session('c')], lit, T);
    expect(lamps.map((l) => l.lit)).toEqual([false, true, false]);
  });

  it('the lit beat is INDEPENDENT of status — an answered session stays lit', () => {
    // the whole point of the delayed reset: you jumped to it, you answered it,
    // it went back to work, and you can still see which one called you
    const [lamp] = buildLamps([session('a', 'working')], new Map([['a', T + 500]]), T);
    expect(lamp.needsYou).toBe(false);
    expect(lamp.lit).toBe(true);
  });

  it("counts the sessions needing a human — the strip's own summary", () => {
    const lamps = buildLamps(
      [session('a', 'needs-permission'), session('b', 'working'), session('c', 'done')],
      new Map(),
      T
    );
    expect(litCount(lamps)).toBe(2);
    expect(litCount([])).toBe(0);
  });
});

describe('the delayed urgency reset (§5.8 force_display_urgency_hint)', () => {
  it('marks a lamp for the linger window', () => {
    const next = markLit(new Map(), 'a', T);
    expect(next.get('a')).toBe(T + URGENCY_LINGER_MS);
    expect(isLit(next, 'a', T)).toBe(true);
    expect(isLit(next, 'a', T + URGENCY_LINGER_MS - 1)).toBe(true);
  });

  it('goes out exactly ON the deadline, not after it', () => {
    // the boundary has to match nextLitExpiry's, or the timer fires against a
    // map that still reads as lit and the effect never settles
    const next = markLit(new Map(), 'a', T);
    expect(isLit(next, 'a', T + URGENCY_LINGER_MS)).toBe(false);
    expect(nextLitExpiry(next, T)).toBe(URGENCY_LINGER_MS);
  });

  it('an unknown card is never lit', () => {
    expect(isLit(new Map([['a', T + 500]]), 'b', T)).toBe(false);
  });

  it('a second jump to the same session restarts its beat', () => {
    const first = markLit(new Map(), 'a', T);
    const second = markLit(first, 'a', T + 400);
    expect(second.get('a')).toBe(T + 400 + URGENCY_LINGER_MS);
    expect(second.size).toBe(1);
  });

  it('two lamps can be lit at once — repeated jumps overlap', () => {
    const both = markLit(markLit(new Map(), 'a', T), 'b', T + 100);
    expect([...both.keys()]).toEqual(['a', 'b']);
    expect(nextLitExpiry(both, T)).toBe(URGENCY_LINGER_MS); // the soonest, a's
  });

  it('marking sweeps entries that already ran out, so the map cannot grow forever', () => {
    // a jump is the only thing that writes this map; without the sweep here a
    // backgrounded window (no renders, no expiry timer) would accumulate one
    // entry per session it ever visited
    const stale = markLit(new Map(), 'old', T);
    const next = markLit(stale, 'new', T + URGENCY_LINGER_MS + 1);
    expect([...next.keys()]).toEqual(['new']);
  });

  it('does not mutate the map it was given', () => {
    const before = new Map([['a', T + 500]]);
    markLit(before, 'b', T);
    expect([...before.keys()]).toEqual(['a']);
  });

  it('pruning returns null when nothing has expired — no state write, no re-render', () => {
    expect(pruneLit(new Map(), T)).toBeNull();
    expect(pruneLit(new Map([['a', T + 1]]), T)).toBeNull();
  });

  it('pruning drops only the expired lamps', () => {
    const map = new Map([
      ['gone', T],
      ['stays', T + 500],
    ]);
    const next = pruneLit(map, T);
    expect(next && [...next.keys()]).toEqual(['stays']);
    expect([...map.keys()]).toEqual(['gone', 'stays']); // input untouched
  });

  it('nextLitExpiry is null with nothing lit and never negative when overdue', () => {
    expect(nextLitExpiry(new Map(), T)).toBeNull();
    expect(nextLitExpiry(new Map([['a', T - 900]]), T)).toBe(0);
  });
});
