// The sweep machine (#217) — the half of P2-E9-07 that used to be module `let`s
// in SessionGrid.tsx and was only reachable through Playwright.
//
// lib/layout-mode.test.ts owns the RULES (which card goes where). This file owns
// what happens to a plan on its way into a real workspace: the moves go out one
// at a time in the order the plan gave them, a teardown mid-sweep abandons the
// rest, a second request coalesces instead of interleaving, and a throw
// anywhere in there leaves the machine able to sweep again.
import { describe, it, expect, vi } from 'vitest';
import type { LayoutMove } from './layout-mode';
import { createSweeper, runMoves, SweepPort, SweepRequest } from './layout-sweep';

const move = (cardId: string, rung: LayoutMove['rung'] = 'expanded'): LayoutMove => ({
  cardId,
  rung,
});

/** A deferred promise, so a test can hold a move open and act while it is. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
}

describe('runMoves', () => {
  it('applies every move, in the order the plan gave them', async () => {
    const seen: string[] = [];
    await runMoves((m) => void seen.push(m.cardId), [move('a'), move('b'), move('c')]);
    expect(seen).toEqual(['a', 'b', 'c']);
  });

  it('carries the whole move through, not just the id', async () => {
    const seen: LayoutMove[] = [];
    await runMoves((m) => void seen.push(m), [move('a', 'collapsed'), move('b', 'hidden')]);
    expect(seen).toEqual([
      { cardId: 'a', rung: 'collapsed' },
      { cardId: 'b', rung: 'hidden' },
    ]);
  });

  it('waits for each move before starting the next', async () => {
    // The reason the loop awaits at all: a card comes home to the dock slot it
    // remembers, and two moves in flight read that slot while the other is
    // still creating or destroying its group.
    const order: string[] = [];
    const first = gate();
    const applied = runMoves((m) => {
      order.push(`start:${m.cardId}`);
      return m.cardId === 'a' ? first.promise : Promise.resolve();
    }, [move('a'), move('b')]);

    await Promise.resolve();
    expect(order).toEqual(['start:a']); // b has NOT been started

    first.open();
    await applied;
    expect(order).toEqual(['start:a', 'start:b']);
  });

  it('stops when the world goes away mid-plan — but finishes the move in flight', async () => {
    const seen: string[] = [];
    let tearingDown = false;
    await runMoves(
      (m) => {
        seen.push(m.cardId);
        if (m.cardId === 'b') tearingDown = true;
      },
      [move('a'), move('b'), move('c')],
      () => tearingDown
    );
    // 'b' ran to completion; 'c' never started
    expect(seen).toEqual(['a', 'b']);
  });

  it('sweeps nothing for an empty plan', async () => {
    const applyMove = vi.fn();
    await runMoves(applyMove, []);
    expect(applyMove).not.toHaveBeenCalled();
  });

  it('lets a throwing move out, so the caller can fail open around it', async () => {
    const boom = new Error('no such group');
    await expect(
      runMoves(() => {
        throw boom;
      }, [move('a')])
    ).rejects.toBe(boom);
  });
});

// ── the machine ─────────────────────────────────────────────────────────────

interface Harness {
  port: SweepPort<SweepRequest>;
  /** every move applied, across every sweep, in order */
  applied: string[];
  /** one entry per sweep that got as far as asking for a plan */
  plans: SweepRequest[];
  errors: unknown[];
  ready: boolean;
  needed: boolean;
  aborted: boolean;
  /** what the next `plan()` returns */
  moves: LayoutMove[];
  /** when set, `applyMove` blocks on it (the first move only) */
  hold: Promise<void> | null;
}

function harness(): Harness {
  const h: Harness = {
    applied: [],
    plans: [],
    errors: [],
    ready: true,
    needed: true,
    aborted: false,
    moves: [move('a')],
    hold: null,
    port: {
      ready: () => h.ready,
      needed: () => h.needed,
      plan: (req) => {
        h.plans.push(req);
        return h.moves;
      },
      applyMove: (m) => {
        h.applied.push(m.cardId);
        const hold = h.hold;
        h.hold = null;
        return hold ?? undefined;
      },
      aborted: () => h.aborted,
      onError: (err) => void h.errors.push(err),
    },
  };
  return h;
}

const react: SweepRequest = { trigger: 'react' };
const switched: SweepRequest = { trigger: 'switch' };

describe('createSweeper — the fence', () => {
  it('refuses everything while the port is not ready', async () => {
    const h = harness();
    h.ready = false;
    await createSweeper(h.port).request(switched);
    expect(h.plans).toEqual([]);
    expect(h.applied).toEqual([]);
  });

  it('skips a request the port says has no work', async () => {
    // The hot path: a status push under the default mode, several a second.
    const h = harness();
    h.needed = false;
    await createSweeper(h.port).request(react);
    expect(h.plans).toEqual([]);
  });

  it('asks `needed` only after `ready` — a torn-down grid is never consulted', async () => {
    const h = harness();
    h.ready = false;
    const needed = vi.fn(() => true);
    await createSweeper({ ...h.port, needed }).request(switched);
    expect(needed).not.toHaveBeenCalled();
  });

  it('runs the plan when the port lets it', async () => {
    const h = harness();
    h.moves = [move('a'), move('b')];
    await createSweeper(h.port).request(switched);
    expect(h.applied).toEqual(['a', 'b']);
    expect(h.plans).toEqual([switched]);
  });

  it('hands the request through to the moves, so a sweep runs against its own grid', async () => {
    const h = harness();
    const seen: SweepRequest[] = [];
    const req = { trigger: 'switch', restore: { a: 'collapsed' } } as const;
    await createSweeper({ ...h.port, applyMove: (_m, r) => void seen.push(r) }).request(req);
    expect(seen).toEqual([req]);
  });

  it('abandons the rest of a plan once `aborted` goes true', async () => {
    const h = harness();
    h.moves = [move('a'), move('b'), move('c')];
    const sweeper = createSweeper({
      ...h.port,
      applyMove: (m) => {
        h.applied.push(m.cardId);
        if (m.cardId === 'b') h.aborted = true;
      },
    });
    await sweeper.request(switched);
    expect(h.applied).toEqual(['a', 'b']);
  });
});

describe('createSweeper — one at a time', () => {
  it('does not interleave two sweeps: the second waits and then re-plans', async () => {
    const h = harness();
    const first = gate();
    h.hold = first.promise;
    h.moves = [move('a'), move('b')];
    const sweeper = createSweeper(h.port);

    const settled = sweeper.request(switched);
    await Promise.resolve();
    expect(h.applied).toEqual(['a']); // parked inside the first move

    // a second request lands mid-sweep and must NOT start moving cards
    h.moves = [move('z')];
    void sweeper.request(react);
    await Promise.resolve();
    expect(h.applied).toEqual(['a']);

    first.open();
    await settled;
    // the first sweep finished its own plan, THEN the queued one ran — against
    // a plan asked for after the fact, not the one that existed when it queued
    expect(h.applied).toEqual(['a', 'b', 'z']);
    expect(h.plans).toEqual([switched, react]);
  });

  it('coalesces a burst down to ONE re-run', async () => {
    // Three sessions finishing inside a second is three store writes. The plan
    // is recomputed at run time, so the last run always sees the truth and the
    // middle requests would only recompute the same answer.
    const h = harness();
    const first = gate();
    h.hold = first.promise;
    const sweeper = createSweeper(h.port);

    const settled = sweeper.request(switched);
    await Promise.resolve();
    void sweeper.request(react);
    void sweeper.request(react);
    void sweeper.request(react);

    first.open();
    await settled;
    expect(h.plans).toEqual([switched, react]); // two sweeps total, not four
  });

  it('lets a `switch` displace a queued `react` — the user asked for that one', async () => {
    const h = harness();
    const first = gate();
    h.hold = first.promise;
    const sweeper = createSweeper(h.port);

    const settled = sweeper.request(react);
    await Promise.resolve();
    void sweeper.request(react);
    void sweeper.request(switched);

    first.open();
    await settled;
    expect(h.plans).toEqual([react, switched]);
  });

  it('keeps the LATEST queued `switch`, not the first', async () => {
    // Two mode changes while a sweep runs: the second wins, because the plan is
    // recomputed and the store already holds whichever mode was picked last.
    const h = harness();
    const first = gate();
    h.hold = first.promise;
    const sweeper = createSweeper(h.port);

    const settled = sweeper.request(switched);
    await Promise.resolve();
    void sweeper.request({ trigger: 'switch', restore: { a: 'expanded' } });
    void sweeper.request({ trigger: 'switch', restore: { b: 'hidden' } });

    first.open();
    await settled;
    expect(h.plans).toHaveLength(2);
    expect(h.plans[1].restore).toEqual({ b: 'hidden' });
  });

  it('does not let a later `react` displace a queued `switch`', async () => {
    // The half of the rank rule with teeth, and the one a "last request wins"
    // rewrite would silently pass every other test in this block with: the
    // user's mode change must not be swallowed by the status push behind it.
    const h = harness();
    const first = gate();
    h.hold = first.promise;
    const sweeper = createSweeper(h.port);

    const settled = sweeper.request(react);
    await Promise.resolve();
    void sweeper.request(switched);
    void sweeper.request(react); // swallowed — the queued `switch` outranks it

    first.open();
    await settled;
    expect(h.plans.map((p) => p.trigger)).toEqual(['react', 'switch']);
  });

  it('queues a request the port would refuse right now — `needed` is re-asked at drain', async () => {
    // The fence ORDER: in-flight is checked BEFORE `needed`, because the store
    // a queued sweep was refused against is not the store it will drain into.
    const h = harness();
    const first = gate();
    h.hold = first.promise;
    const sweeper = createSweeper(h.port);

    const settled = sweeper.request(switched);
    await Promise.resolve();
    h.needed = false;
    void sweeper.request(react); // queued anyway
    h.needed = true; // ...and by drain time there IS work

    first.open();
    await settled;
    expect(h.plans).toEqual([switched, react]);
  });

  it('keeps a queued un-maximize payload WITH its trigger', async () => {
    // Splitting them would re-apply the current mode instead of putting the
    // user's own prior arrangement back.
    const h = harness();
    const first = gate();
    h.hold = first.promise;
    const sweeper = createSweeper(h.port);

    const settled = sweeper.request(react);
    await Promise.resolve();
    void sweeper.request({ trigger: 'switch', restore: { a: 'collapsed', b: 'hidden' } });

    first.open();
    await settled;
    expect(h.plans[1]).toEqual({ trigger: 'switch', restore: { a: 'collapsed', b: 'hidden' } });
  });

  it('puts the drained sweep back through the fence', async () => {
    // The world a sweep was queued in is not the world it runs in: a teardown
    // that started mid-sweep must eat the queued one too.
    const h = harness();
    const first = gate();
    h.hold = first.promise;
    const sweeper = createSweeper(h.port);

    const settled = sweeper.request(switched);
    await Promise.resolve();
    void sweeper.request(switched);
    h.ready = false;

    first.open();
    await settled;
    expect(h.plans).toEqual([switched]); // the queued one never ran
  });

  it('settles only once the drained sweep is done too', async () => {
    const h = harness();
    const first = gate();
    const second = gate();
    h.hold = first.promise;
    const sweeper = createSweeper(h.port);

    let done = false;
    const settled = sweeper.request(switched).then(() => (done = true));
    await Promise.resolve();
    void sweeper.request(react);

    h.hold = second.promise;
    first.open();
    await Promise.resolve();
    await Promise.resolve();
    expect(done).toBe(false); // the drained sweep is still moving cards

    second.open();
    await settled;
    expect(done).toBe(true);
  });
});

describe('createSweeper — fail open', () => {
  it('reports a throwing move instead of leaving the rejection unhandled', async () => {
    const h = harness();
    const boom = new Error('no such group');
    await createSweeper({
      ...h.port,
      applyMove: () => {
        throw boom;
      },
    }).request(switched);
    expect(h.errors).toEqual([boom]);
  });

  it('reports a throwing plan, and never starts moving cards', async () => {
    const h = harness();
    const boom = new Error('bad card list');
    await createSweeper({
      ...h.port,
      plan: () => {
        throw boom;
      },
    }).request(switched);
    expect(h.errors).toEqual([boom]);
    expect(h.applied).toEqual([]);
  });

  it('can sweep again after a failure — the guard is released, not stuck', async () => {
    // The failure mode this is written against: `sweeping` left true forever
    // would make every later layout change a silent no-op.
    const h = harness();
    let explode = true;
    const sweeper = createSweeper({
      ...h.port,
      applyMove: (m) => {
        if (explode) throw new Error('boom');
        h.applied.push(m.cardId);
      },
    });

    await sweeper.request(switched);
    expect(h.errors).toHaveLength(1);

    explode = false;
    await sweeper.request(switched);
    expect(h.applied).toEqual(['a']);
  });

  it('still drains a queued sweep after the running one throws', async () => {
    const h = harness();
    const first = gate();
    let explode = true;
    const sweeper = createSweeper({
      ...h.port,
      applyMove: async (m) => {
        h.applied.push(m.cardId);
        if (!explode) return;
        await first.promise;
        explode = false;
        throw new Error('boom');
      },
    });

    const settled = sweeper.request(switched);
    await Promise.resolve();
    void sweeper.request(react);

    first.open();
    await settled;
    expect(h.errors).toHaveLength(1);
    expect(h.plans).toEqual([switched, react]);
  });
});
