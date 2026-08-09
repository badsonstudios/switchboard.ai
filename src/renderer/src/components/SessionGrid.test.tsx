// @vitest-environment jsdom
// SessionGrid's first unit tests (#217, flagged again by #224 and #239).
//
// Almost everything in SessionGrid.tsx needs a live dockview to reach, which is
// why it had no unit file at all and four Playwright specs carried P2-E9-07 on
// their own. This file is the one the other effects can grow into; it starts
// with the LAYOUT-MODE surface, because #217 just split that in half:
//
//   lib/layout-mode      what a mode wants (34 tests, already there)
//   lib/layout-sweep     how a plan gets applied (23 tests, new)
//   here                 that the two are wired to each other, and to the store
//
// The `layoutSweepPort` half is the interesting one: `needed` and `plan` are
// pure functions of the store, so they can be asserted exactly — with no grid,
// no Electron and no Playwright — even though `applyLayout` itself cannot run
// until a real `onReady` has opened the `gridReady` fence.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  applyLayout,
  applySubmitPolicy,
  cycleLayoutMode,
  endedCopy,
  layoutSweepPort,
  overlaySaid,
  setCardLadder,
  setLayoutMode,
  stepCardLadder,
  toggleMaximizeCard,
} from './SessionGrid';
import en from '../i18n/locales/en.json';
import { sessionStore } from '../store/session-store';
import { DEFAULT_LAYOUT, withMaximized, withMode } from '../lib/layout-mode';
import type { SweepRequest } from '../lib/layout-sweep';
import type { Ladder } from '../lib/presentation';
import type { RailSession } from '../model/types';

/** A dockview api that would throw on any real use — the point being that
 *  nothing in these tests may get far enough to touch it. */
const noGrid = {} as never;

/** A sweep request. Every one carries the grid its moves land in, even the two
 *  halves of the port (`needed`, `plan`) that are pure functions of the store
 *  and never look at it. */
const sweep = (req: SweepRequest): SweepRequest & { api: never } => ({ ...req, api: noGrid });

function seed(sessions: readonly (Partial<RailSession> & { id: string })[]): void {
  sessionStore.setSessions(sessions.map((s) => ({ title: s.id, ...s })));
}

function place(cardId: string, ladder: Ladder, poppedOut = false): void {
  sessionStore.setPresentation(cardId, { ladder, poppedOut });
}

// NOTE for whoever grows this file: this resets the STORE, not the module. The
// sweeper behind `applyLayout` is a SessionGrid singleton, so its in-flight and
// queued state survives between tests. Nothing here reaches it (the `gridReady`
// fence is shut in unit-land), but the first test that opens that fence will
// need `vi.resetModules()` and a dynamic import to get a clean one.
beforeEach(() => {
  sessionStore.setSessions([]);
  sessionStore.setGroups([]);
  sessionStore.setActiveCard(null);
  sessionStore.initPresentation(new Map());
  sessionStore.setLayout(DEFAULT_LAYOUT);
  sessionStore.setTearingDown(false);
  sessionStore.setRestoringLayout(false);
});

// ── the mode commands ───────────────────────────────────────────────────────

describe('setLayoutMode / cycleLayoutMode', () => {
  it('writes the mode the user picked', () => {
    setLayoutMode(noGrid, 'focus');
    expect(sessionStore.getLayout().mode).toBe('focus');
  });

  it('is a no-op when that mode is already on and nothing is maximized', () => {
    setLayoutMode(noGrid, 'focus');
    const before = sessionStore.getLayout();
    setLayoutMode(noGrid, 'focus');
    expect(sessionStore.getLayout()).toBe(before); // same object: no re-render
  });

  it('ends a maximize even when the mode is unchanged', () => {
    // Picking a mode is "arrange the whole workspace", which a held maximize
    // would otherwise sit on top of.
    sessionStore.setLayout(withMaximized(withMode('focus'), 'a', { a: 'expanded' }));
    setLayoutMode(noGrid, 'focus');
    expect(sessionStore.getLayout().maximized).toBeNull();
    expect(sessionStore.getLayout().restore).toEqual({});
  });

  it('cycles grid -> focus -> queue -> grid', () => {
    const seen = [sessionStore.getLayout().mode];
    for (let i = 0; i < 3; i++) {
      cycleLayoutMode(noGrid);
      seen.push(sessionStore.getLayout().mode);
    }
    expect(seen).toEqual(['grid', 'focus', 'queue', 'grid']);
  });
});

describe('toggleMaximizeCard', () => {
  beforeEach(() => {
    seed([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    place('a', 'expanded');
    place('b', 'collapsed');
    place('c', 'hidden');
  });

  it('takes the snapshot from the cards as they are right now', () => {
    toggleMaximizeCard(noGrid, 'b');
    const state = sessionStore.getLayout();
    expect(state.maximized).toBe('b');
    // 'c' was hidden BY HAND before the maximize — "restores the prior layout"
    // means it stays hidden afterwards, so the snapshot has to remember it
    expect(state.restore).toEqual({ a: 'expanded', b: 'collapsed', c: 'hidden' });
  });

  it('lets go on the second toggle, and forgets the snapshot with it', () => {
    toggleMaximizeCard(noGrid, 'b');
    toggleMaximizeCard(noGrid, 'b');
    expect(sessionStore.getLayout().maximized).toBeNull();
    expect(sessionStore.getLayout().restore).toEqual({});
  });

  it('moves the maximize to another card, keeping the ORIGINAL snapshot', () => {
    // The arrangement worth restoring is the one before the first blow-up, not
    // the all-collapsed workspace the first one produced.
    toggleMaximizeCard(noGrid, 'b');
    const first = sessionStore.getLayout().restore;
    place('a', 'collapsed');
    toggleMaximizeCard(noGrid, 'a');
    expect(sessionStore.getLayout().maximized).toBe('a');
    expect(sessionStore.getLayout().restore).toEqual(first);
  });

  it('does nothing without a grid or a card', () => {
    toggleMaximizeCard(null, 'a');
    toggleMaximizeCard(noGrid, '');
    expect(sessionStore.getLayout()).toEqual(DEFAULT_LAYOUT);
  });
});

// ── the seam: SessionGrid's half of lib/layout-sweep ─────────────────────────

describe('layoutSweepPort.ready — the fence', () => {
  it('is shut before a grid has ever come up', () => {
    // `gridReady` only opens in onReady, after the boot restore has finished
    // placing panels, and nothing here can open it — which is exactly why the
    // machine it guards was moved into lib/layout-sweep, where a test CAN.
    //
    // Its other two clauses (tearing down, replaying a saved layout) are
    // deliberately NOT asserted here: with `gridReady` false they could not
    // fail, so a test for them would only look like coverage. e2e/layout-modes
    // owns the open fence; lib/layout-sweep.test.ts owns what a shut one does.
    expect(layoutSweepPort.ready()).toBe(false);
  });
});

describe('layoutSweepPort.needed — the cheap early-out', () => {
  it('lets a `switch` through under every mode: the user asked for it', () => {
    expect(layoutSweepPort.needed(sweep({ trigger: 'switch' }))).toBe(true);
    sessionStore.setLayout(withMode('queue'));
    expect(layoutSweepPort.needed(sweep({ trigger: 'switch' }))).toBe(true);
  });

  it('drops a reactive pass under `grid` — the most important line in E9-07', () => {
    // Grid means "every session gets a card", so a standing grid sweep would
    // re-expand every card the user collapsed by hand on the next status push.
    // These arrive several a second while agents stream.
    expect(layoutSweepPort.needed(sweep({ trigger: 'react' }))).toBe(false);
  });

  it('lets a reactive pass through under an enforcing mode', () => {
    for (const mode of ['focus', 'queue'] as const) {
      sessionStore.setLayout(withMode(mode));
      expect(layoutSweepPort.needed(sweep({ trigger: 'react' }))).toBe(true);
    }
  });

  it('lets a reactive pass through under `grid` while a maximize is held', () => {
    sessionStore.setLayout(withMaximized(DEFAULT_LAYOUT, 'a', { a: 'expanded' }));
    expect(layoutSweepPort.needed(sweep({ trigger: 'react' }))).toBe(true);
  });

  it('never drops an un-maximize: its whole payload is work', () => {
    expect(layoutSweepPort.needed(sweep({ trigger: 'react', restore: { a: 'collapsed' } }))).toBe(true);
  });
});

describe('layoutSweepPort.plan — computed over the store', () => {
  it('reads the cards in RAIL order, so the plan agrees with Ctrl+1..9', () => {
    seed([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    for (const id of ['a', 'b', 'c']) place(id, 'collapsed');
    sessionStore.setLayout(withMode('grid'));
    expect(layoutSweepPort.plan(sweep({ trigger: 'switch' })).map((m) => m.cardId)).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('includes cards with no panel — a mode has to be able to bring one back', () => {
    seed([{ id: 'a' }]);
    place('a', 'hidden');
    sessionStore.setLayout(withMode('grid'));
    expect(layoutSweepPort.plan(sweep({ trigger: 'switch' }))).toEqual([
      { cardId: 'a', rung: 'expanded' },
    ]);
  });

  it('maps a status into `needsAttention` with the rail’s own vocabulary', () => {
    // queue mode keeps exactly the sessions a human has to move on. 'done' is
    // one of them (§5.8's completed-unreviewed state) and 'working' is not.
    seed([
      { id: 'a', status: 'done' },
      { id: 'b', status: 'working' },
    ]);
    place('a', 'expanded');
    place('b', 'expanded');
    sessionStore.setLayout(withMode('queue'));
    expect(layoutSweepPort.plan(sweep({ trigger: 'switch' }))).toEqual([
      { cardId: 'b', rung: 'collapsed' },
    ]);
  });

  it('spares a popped-out card: its rung change would close an OS window', () => {
    seed([{ id: 'a' }, { id: 'b' }]);
    place('a', 'expanded', true);
    place('b', 'expanded');
    sessionStore.setActiveCard('b');
    sessionStore.setLayout(withMode('focus'));
    expect(layoutSweepPort.plan(sweep({ trigger: 'switch' }))).toEqual([]);
  });

  it('feeds the active card through, so focus mode follows where you are', () => {
    seed([{ id: 'a' }, { id: 'b' }]);
    place('a', 'expanded');
    place('b', 'collapsed');
    sessionStore.setActiveCard('b');
    sessionStore.setLayout(withMode('focus'));
    expect(layoutSweepPort.plan(sweep({ trigger: 'switch' }))).toEqual([
      { cardId: 'b', rung: 'expanded' },
      { cardId: 'a', rung: 'collapsed' },
    ]);
  });

  it('passes an un-maximize payload through verbatim', () => {
    seed([{ id: 'a' }, { id: 'b' }]);
    place('a', 'expanded');
    place('b', 'collapsed');
    sessionStore.setLayout(withMode('grid'));
    expect(
      layoutSweepPort.plan(sweep({ trigger: 'react', restore: { a: 'hidden', b: 'expanded' } }))
    ).toEqual([
      { cardId: 'b', rung: 'expanded' },
      { cardId: 'a', rung: 'hidden' },
    ]);
  });
});

describe('layoutSweepPort — the rest of the wiring', () => {
  it('aborts on teardown, and only on teardown', () => {
    expect(layoutSweepPort.aborted()).toBe(false);
    sessionStore.setTearingDown(true);
    expect(layoutSweepPort.aborted()).toBe(true);
  });

  it('fails open by reporting, not throwing', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const boom = new Error('no such group');
    expect(() => layoutSweepPort.onError(boom)).not.toThrow();
    expect(err).toHaveBeenCalledWith('[layout] sweep failed', boom);
    err.mockRestore();
  });
});

// ── fail-open: every layout verb survives a missing grid ─────────────────────

describe('a missing grid is never a crash', () => {
  it('no-ops instead of throwing', () => {
    // These all run from commands and keybindings, which fire whether or not a
    // grid happens to exist (during teardown, before onReady, in a popout).
    seed([{ id: 'a', status: 'idle' }]);
    expect(() => {
      applyLayout(null, 'switch');
      applyLayout(null, 'react', { a: 'collapsed' });
      setCardLadder(null, 'a', 'collapsed');
      setCardLadder(noGrid, '', 'collapsed');
      stepCardLadder(null, 'a', 'down');
      applySubmitPolicy(null, 'a');
      applySubmitPolicy(noGrid, '');
    }).not.toThrow();
  });

  it('never sweeps before the grid is ready, even with an api in hand', async () => {
    // The `gridReady` fence from the outside. `.not.toThrow()` would prove
    // nothing — the sweep runs in a promise and lib/layout-sweep catches — so
    // the api is a probe that records ANY property read: a sweep that got past
    // the fence would have to touch it to move a card.
    const touched: string[] = [];
    const probe = new Proxy(
      {},
      { get: (_t, prop) => void touched.push(String(prop)) }
    ) as never;

    sessionStore.setLayout(withMode('grid'));
    seed([{ id: 'a' }]);
    place('a', 'collapsed');
    applyLayout(probe, 'switch');
    await Promise.resolve();
    expect(touched).toEqual([]);
    // ...and the plan it declined to run was not empty, so the fence is what
    // stopped it rather than there being nothing to do
    expect(layoutSweepPort.plan(sweep({ trigger: 'switch' }))).not.toEqual([]);
  });
});

// ── #355: the ended overlay tells the truth about which of the two it is ─────
//
// The overlay itself needs a live dockview, so what is pinned here is the
// mapping `endedCopy` owns: which words go with which state, and that every key
// it can name is really in en.json — a typo there renders the raw key on screen
// and no type checks it.

/** The English behind a key `endedCopy` returned. Throws if it is not there. */
function copyText(key: string): string {
  const text = key
    .split('.')
    .reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], en);
  if (typeof text !== 'string') throw new Error(`en.json has no string at "${key}"`);
  return text;
}

describe('endedCopy', () => {
  it('says a session that never started never started — and invents no exit code', () => {
    const copy = endedCopy({ kind: 'never-started' });
    expect(copy).toEqual({
      heading: 'grid.sessionNotStarted',
      detail: 'grid.notStartedHint',
      action: 'grid.tryAgain',
    });
    // The bug this issue is: the card used to read "Session ended — Exited
    // unexpectedly (code -1)" for a session that did neither. Assert on the
    // ENGLISH, not just the keys, so re-pointing a key at the old wording is red.
    const shown = `${copyText(copy.heading)} ${copyText(copy.detail)}`;
    expect(shown).not.toMatch(/\bended\b|\bexited\b|\bcode\b/i);
    // and it does not offer to "Restart" something that never ran
    expect(copyText(copy.action)).not.toMatch(/restart/i);
  });

  it('keeps the exit copy — with the real code — for a session that ran and died', () => {
    const copy = endedCopy({ kind: 'exited', code: 137, crashed: true });
    expect(copy).toEqual({
      heading: 'grid.sessionEnded',
      detail: 'grid.exitCrashed',
      detailVars: { code: 137 },
      action: 'grid.restart',
    });
    // the code is a real one off the exit event, and the string takes it
    expect(copyText(copy.detail)).toContain('{code}');
  });

  it('distinguishes a clean close from a crash', () => {
    const clean = endedCopy({ kind: 'exited', code: 0, crashed: false });
    expect(clean.detail).toBe('grid.exitClean');
    expect(clean.heading).toBe('grid.sessionEnded');
    expect(clean.action).toBe('grid.restart');
  });

  it('names only keys that exist in en.json', () => {
    for (const ended of [
      { kind: 'never-started' },
      { kind: 'exited', code: 0, crashed: false },
      { kind: 'exited', code: -1, crashed: true },
    ] as const) {
      const copy = endedCopy(ended);
      for (const key of [copy.heading, copy.detail, copy.action]) {
        expect(copyText(key).length).toBeGreaterThan(0);
      }
    }
  });
});

// ── #358: the card's live region says what the card is showing ──────────────
//
// The REGION cannot be reached here (same live-dockview wall as the overlay),
// and its load-bearing property — that it exists, empty, before there is
// anything to put in it — is a DOM fact, so e2e owns that half. What is pinned
// here is the decision `overlaySaid` makes: whether there is anything to say,
// and which of the two overlays' words to say. Getting that wrong announces the
// suspended copy over a dead session's panel, which is worse than the silence
// this issue is fixing.

/** the render's own branch order, as a table: [live, suspended, ended] */
const exited = { kind: 'exited', code: 137, crashed: true } as const;
const notStarted = { kind: 'never-started' } as const;

describe('overlaySaid', () => {
  it('says nothing while a live card is just being a card', () => {
    expect(overlaySaid({ live: true, suspended: false, ended: null })).toBeNull();
  });

  it('says nothing for a card that is still resuming', () => {
    // no overlay is drawn in that branch either — only "Resuming…", which is
    // the ordinary boot and not an event
    expect(overlaySaid({ live: false, suspended: false, ended: null })).toBeNull();
  });

  it('announces a session that died, with its exit code', () => {
    const said = overlaySaid({ live: true, suspended: false, ended: exited });
    expect(said).toEqual({
      heading: 'grid.sessionEnded',
      detail: 'grid.exitCrashed',
      detailVars: { code: 137 },
    });
  });

  it('announces a session that never started, in ITS words', () => {
    const said = overlaySaid({ live: false, suspended: false, ended: notStarted });
    expect(said).toEqual({ heading: 'grid.sessionNotStarted', detail: 'grid.notStartedHint' });
    // the #355 lie, re-checked at the announcement seam: a screen-reader user
    // must not be told a session ended when none ever ran
    const spoken = `${copyText(said!.heading)} ${copyText(said!.detail)}`;
    expect(spoken).not.toMatch(/\bended\b|\bexited\b|\bcode\b/i);
  });

  it('announces suspension — the other overlay #358 audited', () => {
    expect(overlaySaid({ live: false, suspended: true, ended: null })).toEqual({
      heading: 'grid.suspended',
      detail: 'grid.suspendedHint',
    });
  });

  it('never contradicts the branch that is actually drawn', () => {
    // suspended is ignored while the card is live: that branch renders the
    // views, not the suspended panel
    expect(overlaySaid({ live: true, suspended: true, ended: null })).toBeNull();
    // ...and the ended panel is drawn OVER them, so it still wins
    expect(overlaySaid({ live: true, suspended: true, ended: exited })?.heading).toBe(
      'grid.sessionEnded'
    );
    // once the card is not live, `suspended` is the branch the render picks
    // FIRST — the region must follow it, not the stale `ended`
    expect(overlaySaid({ live: false, suspended: true, ended: exited })?.heading).toBe(
      'grid.suspended'
    );
  });

  it('names only keys that exist in en.json', () => {
    for (const card of [
      { live: true, suspended: false, ended: exited },
      { live: false, suspended: false, ended: notStarted },
      { live: false, suspended: true, ended: null },
    ]) {
      const said = overlaySaid(card)!;
      expect(said).not.toBeNull();
      for (const key of [said.heading, said.detail]) {
        expect(copyText(key).length).toBeGreaterThan(0);
      }
    }
  });
});
