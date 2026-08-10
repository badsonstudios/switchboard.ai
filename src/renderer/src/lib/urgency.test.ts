import { describe, it, expect } from 'vitest';
import {
  buildLamps,
  isLit,
  litCount,
  markLit,
  nextLitExpiry,
  pruneLit,
  startBeat,
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

  it('lights a lamp that has not been painted yet — that is what it is for', () => {
    // #320: a mark with no deadline is unconditionally lit, so the paint the
    // beat is measured from is guaranteed to happen
    const lamps = buildLamps([session('a'), session('b')], new Map([['b', null]]), T + 60_000);
    expect(lamps.map((l) => l.lit)).toEqual([false, true]);
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
  /** the two phases a jump goes through, as the app runs them: mark, then paint */
  const marked = (cardId: string, keypress: number, paint: number): Map<string, number | null> =>
    startBeat(markLit(new Map(), cardId, keypress), [cardId], paint)!;

  it('marks a lamp WITHOUT a deadline — the paint gives it one', () => {
    // #320: the beat runs from the first paint of the lit lamp, so the keypress
    // records only that the lamp is lit
    const next = markLit(new Map(), 'a', T);
    expect(next.get('a')).toBeNull();
    expect(isLit(next, 'a', T)).toBe(true);
    // ...and it stays lit however long the paint takes: there is no deadline to
    // have missed, which is the whole of the fix
    expect(isLit(next, 'a', T + 60_000)).toBe(true);
    expect(nextLitExpiry(next, T), 'nothing is counting down yet').toBeNull();
  });

  it('the beat is a full linger window measured from the PAINT', () => {
    const next = marked('a', T, T + 60_000); // a minute of stall on a busy box
    expect(next.get('a')).toBe(T + 60_000 + URGENCY_LINGER_MS);
    expect(isLit(next, 'a', T + 60_000)).toBe(true);
    expect(isLit(next, 'a', T + 60_000 + URGENCY_LINGER_MS - 1)).toBe(true);
  });

  it('goes out exactly ON the deadline, not after it', () => {
    // the boundary has to match nextLitExpiry's, or the timer fires against a
    // map that still reads as lit and the effect never settles
    const next = marked('a', T, T);
    expect(isLit(next, 'a', T + URGENCY_LINGER_MS)).toBe(false);
    expect(nextLitExpiry(next, T)).toBe(URGENCY_LINGER_MS);
  });

  it('an unknown card is never lit', () => {
    expect(isLit(new Map([['a', T + 500]]), 'b', T)).toBe(false);
    expect(isLit(new Map([['a', null]]), 'b', T)).toBe(false);
  });

  it('a second jump to the same session restarts its beat', () => {
    const first = marked('a', T, T);
    const second = markLit(first, 'a', T + 400);
    expect(second.get('a'), 'back to waiting on a paint').toBeNull();
    expect(second.size).toBe(1);
    expect(startBeat(second, ['a'], T + 400)!.get('a')).toBe(T + 400 + URGENCY_LINGER_MS);
  });

  it('two lamps can be lit at once — repeated jumps overlap', () => {
    const both = markLit(markLit(new Map(), 'a', T), 'b', T + 100);
    expect([...both.keys()]).toEqual(['a', 'b']);
    // one paint starts both, each with its own full beat from that instant
    const painted = startBeat(both, ['a', 'b'], T + 100)!;
    expect(nextLitExpiry(painted, T + 100)).toBe(URGENCY_LINGER_MS);
  });

  it('marking sweeps entries that already ran out, so the map cannot grow forever', () => {
    // a jump is the only thing that writes this map; without the sweep here a
    // backgrounded window (no renders, no expiry timer) would accumulate one
    // entry per session it ever visited
    const stale = marked('old', T, T);
    const next = markLit(stale, 'new', T + URGENCY_LINGER_MS + 1);
    expect([...next.keys()]).toEqual(['new']);
  });

  it('the sweep spares a lamp still waiting for its first paint', () => {
    // it has no deadline to have passed, and dropping it would put back the
    // silent no-lamp case: marked, never drawn, gone
    const waiting = markLit(new Map(), 'old', T);
    const next = markLit(waiting, 'new', T + 60_000);
    expect([...next.keys()]).toEqual(['old', 'new']);
  });

  it('does not mutate the map it was given', () => {
    const before = new Map([['a', T + 500]]);
    markLit(before, 'b', T);
    expect([...before.keys()]).toEqual(['a']);
  });

  it('pruning returns null when nothing has expired — no state write, no re-render', () => {
    expect(pruneLit(new Map(), T)).toBeNull();
    expect(pruneLit(new Map([['a', T + 1]]), T)).toBeNull();
    // and an unpainted one is never "expired": it is waiting on a frame, not a
    // clock, so no amount of elapsed time makes it prunable
    expect(pruneLit(new Map([['a', null]]), T + 60_000)).toBeNull();
  });

  it('pruning drops only the expired lamps', () => {
    const map = new Map<string, number | null>([
      ['gone', T],
      ['stays', T + 500],
      ['waiting', null],
    ]);
    const next = pruneLit(map, T);
    expect(next && [...next.keys()]).toEqual(['stays', 'waiting']);
    expect([...map.keys()]).toEqual(['gone', 'stays', 'waiting']); // input untouched
  });

  it('nextLitExpiry is null with nothing lit and never negative when overdue', () => {
    expect(nextLitExpiry(new Map(), T)).toBeNull();
    expect(nextLitExpiry(new Map([['a', T - 900]]), T)).toBe(0);
  });

  it('nextLitExpiry skips the unpainted, so the strip arms no timer for them', () => {
    // arming one would put back the bug: a timer counting down a lamp nobody
    // has seen yet
    expect(nextLitExpiry(new Map([['a', null]]), T)).toBeNull();
    expect(
      nextLitExpiry(
        new Map([
          ['a', null],
          ['b', T + 300],
        ]),
        T
      )
    ).toBe(300);
  });
});

describe('startBeat — the paint is what starts the clock (#320)', () => {
  it('gives every waiting lamp a full beat from the paint', () => {
    const both = markLit(markLit(new Map(), 'a', T), 'b', T);
    const next = startBeat(both, ['a', 'b'], T + 5000)!;
    expect(next.get('a')).toBe(T + 5000 + URGENCY_LINGER_MS);
    expect(next.get('b')).toBe(T + 5000 + URGENCY_LINGER_MS);
  });

  it('returns null when nothing was waiting — no state write for an ordinary frame', () => {
    expect(startBeat(new Map(), ['a'], T)).toBeNull();
    expect(startBeat(new Map([['a', T + 500]]), ['a'], T)).toBeNull();
    expect(startBeat(new Map([['a', null]]), [], T)).toBeNull();
  });

  it('never re-stamps a beat already running — a repaint is not a new jump', () => {
    // otherwise the lamp stays lit for as long as anything makes the strip
    // re-render, which is a beat with no end
    const running = new Map([['a', T + 100]]);
    expect(startBeat(running, ['a'], T + 50)).toBeNull();
  });

  it('ignores a card with no mark at all', () => {
    expect(startBeat(new Map([['a', null]]), ['a', 'ghost'], T)!.has('ghost')).toBe(false);
  });

  it('does not mutate the map it was given', () => {
    const before = new Map<string, number | null>([['a', null]]);
    startBeat(before, ['a'], T);
    expect(before.get('a')).toBeNull();
  });
});
