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
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import {
  applyLayout,
  captureSlots,
  applySubmitPolicy,
  clusterCardWithGroup,
  cycleLayoutMode,
  endedCopy,
  forgetDockBacks,
  isDockviewReturn,
  layoutSweepPort,
  noteCardCameHome,
  overlaySaid,
  popOutCardPanel,
  rescueStrandedPopouts,
  revealCardPanel,
  setCardLadder,
  setLayoutMode,
  settleDockedBackCards,
  stepCardLadder,
  toggleMaximizeCard,
} from './SessionGrid';
import type { DockviewApi } from 'dockview-react';
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

// ── #292: a card whose popout window died comes home ─────────────────────────
//
// The DECISIONS are lib/popout-rescue's and are pinned there. What is pinned
// here is everything the rescue does to the workspace and to the store: the
// dead panel goes, the session is suspended the way a clean close suspends it,
// and a NEW panel is built. That last one is the load-bearing part and the
// reason the fake below models `removePanel`/`addPanel` rather than a move —
// a rescued card that was carried back from the destroyed window renders
// perfectly and answers no clicks, so "it is in the grid" is not the property
// worth asserting; "it was built again" is.
//
// A real DockviewApi cannot be had in jsdom, which is the wall the rest of this
// file lives behind.

interface FakeGroup {
  id: string;
  panels: FakePanel[];
  element: HTMLElement;
  api: {
    location: { type: string; getWindow?: () => Window | null };
    isVisible: boolean;
    setVisible: (v: boolean) => void;
  };
}
interface FakePanel {
  id: string;
  group: FakeGroup;
  focus: () => void;
  api: {
    location: { type: string; getWindow?: () => Window | null };
    moveTo: (opts: { group: FakeGroup; index?: number }) => void;
  };
}
interface GroupSpec {
  id: string;
  type?: string;
  win?: Window | null;
  /** a dock-back husk is a grid group that is EMPTY and hidden (#434/#558) */
  hidden?: boolean;
  /** registered with dockview but in no document — a popout mid-restore (#558) */
  detached?: boolean;
}

/** a group's element: in the document (a real slot) or merely created (#558) */
function makeElement(detached?: boolean): HTMLElement {
  const el = document.createElement('div');
  if (!detached) document.body.appendChild(el);
  return el;
}

function fakeGrid(): {
  api: DockviewApi;
  addGroups: (...specs: GroupSpec[]) => void;
  addPanel: (id: string, groupId: string) => FakePanel;
  /** panel ids currently in the grid, in order */
  ids: () => string[];
  /** panel ids this run of the rescue CREATED */
  built: string[];
  /** panel ids this run of the rescue removed */
  removed: string[];
  /** which group a panel is sitting in right now */
  groupOf: (panelId: string) => string | undefined;
} {
  const groups: FakeGroup[] = [];
  let panels: FakePanel[] = [];
  const built: string[] = [];
  const removed: string[] = [];
  let seq = 0;
  const makeGroup = (spec: GroupSpec): FakeGroup => {
    const g: FakeGroup = {
      id: spec.id,
      panels: [],
      // `captureSlots` asks whether the group is really in a document — a saved
      // popout is rebuilt as a DETACHED group that claims to be a grid one, so
      // an element that is merely created is the mid-restore case and one in
      // the body is a real slot.
      element: makeElement(spec.detached),
      api: {
        location:
          spec.type === 'popout'
            ? { type: 'popout', getWindow: () => spec.win ?? null }
            : { type: spec.type ?? 'grid' },
        isVisible: !spec.hidden,
        setVisible: (v: boolean) => {
          g.api.isVisible = v;
        },
      },
    };
    groups.push(g);
    return g;
  };
  const attach = (id: string, g: FakeGroup): FakePanel => {
    const p: FakePanel = {
      id,
      group: g,
      focus: () => {},
      // `location` is READ THROUGH the group, not copied off it: a moved panel
      // whose location still says `popout` would make the dock-back tests pass
      // for the wrong reason.
      api: {
        get location() {
          return p.group.api.location;
        },
        moveTo: ({ group, index }: { group: FakeGroup; index?: number }) => {
          p.group.panels = p.group.panels.filter((x) => x !== p);
          p.group = group;
          if (typeof index === 'number' && index >= 0) group.panels.splice(index, 0, p);
          else group.panels.push(p);
        },
      },
    };
    g.panels.push(p);
    panels.push(p);
    return p;
  };
  const api = {
    get panels(): FakePanel[] {
      return [...panels];
    },
    get groups(): FakeGroup[] {
      return [...groups];
    },
    getPanel: (id: string): FakePanel | undefined => panels.find((p) => p.id === id),
    addGroup: (): FakeGroup => makeGroup({ id: `new-${++seq}` }),
    addPanel: (opts: { id: string; position?: { referenceGroup?: FakeGroup } }): FakePanel => {
      built.push(opts.id);
      return attach(opts.id, opts.position?.referenceGroup ?? makeGroup({ id: `new-${++seq}` }));
    },
    removePanel: (panel: FakePanel): void => {
      removed.push(panel.id);
      panel.group.panels = panel.group.panels.filter((x) => x !== panel);
      panels = panels.filter((x) => x !== panel);
    },
  };
  return {
    api: api as unknown as DockviewApi,
    addGroups: (...specs: GroupSpec[]) => specs.forEach(makeGroup),
    groupOf: (panelId: string) => panels.find((p) => p.id === panelId)?.group.id,
    addPanel: (id: string, groupId: string) => attach(id, groups.find((x) => x.id === groupId)!),
    ids: () => panels.map((p) => p.id),
    built,
    removed,
  };
}

const deadWindow = { closed: true } as unknown as Window;
const liveWindow = { closed: false } as unknown as Window;

/** the bridge calls a rescue makes: the card record it rebuilds from, and the
 *  suspend it asks main for. `groupId` is #503's half — the same `cards()` read
 *  answers the E12-02 clustering lookup. */
function stubBridge(
  cards: Array<{ cardId: string; groupId?: string | null }>
): { dropped: string[] } {
  const dropped: string[] = [];
  (window as unknown as { switchboard: unknown }).switchboard = {
    sessions: {
      cards: () => Promise.resolve(cards.map((c) => ({ ...c, title: c.cardId, folder: '/tmp/x' }))),
      dropLive: (cardId: string) => {
        dropped.push(cardId);
        return Promise.resolve();
      },
    },
  };
  return { dropped };
}

/** let the reveal's `await sessions.cards()` land */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('rescueStrandedPopouts (#292)', () => {
  let said: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    said = vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    said.mockRestore();
    delete (window as unknown as { switchboard?: unknown }).switchboard;
  });

  it('takes the dead panel away and builds the card again', async () => {
    const grid = fakeGrid();
    grid.addGroups({ id: 'pop1', type: 'popout', win: deadWindow });
    grid.addPanel('session-a', 'pop1');
    const bridge = stubBridge([{ cardId: 'a' }]);

    rescueStrandedPopouts(grid.api);
    await settle();

    // REBUILT, not moved — a carried-back card is a card with no listeners
    expect(grid.removed).toEqual(['session-a']);
    expect(grid.built).toEqual(['session-a']);
    expect(grid.ids()).toEqual(['session-a']);
    // ...and suspended, exactly as a clean close leaves it
    expect(sessionStore.getPresentation('a').suspended).toBe(true);
    expect(sessionStore.getPresentation('a').poppedOut).toBe(false);
    expect(bridge.dropped).toEqual(['a']);
    expect(said).toHaveBeenCalledWith(expect.stringContaining('session-a'));
  });

  it('leaves a LIVE popout completely alone', async () => {
    const grid = fakeGrid();
    grid.addGroups({ id: 'pop1', type: 'popout', win: liveWindow });
    grid.addPanel('session-a', 'pop1');
    const bridge = stubBridge([{ cardId: 'a' }]);

    rescueStrandedPopouts(grid.api);
    await settle();

    expect(grid.removed).toEqual([]);
    expect(grid.built).toEqual([]);
    expect(sessionStore.getPresentation('a').suspended).toBe(false);
    expect(bridge.dropped).toEqual([]);
  });

  it('rescues every card the dead window was holding', async () => {
    const grid = fakeGrid();
    grid.addGroups({ id: 'pop1', type: 'popout', win: deadWindow });
    grid.addPanel('session-a', 'pop1');
    grid.addPanel('session-b', 'pop1');
    const bridge = stubBridge([{ cardId: 'a' }, { cardId: 'b' }]);

    rescueStrandedPopouts(grid.api);
    await settle();

    expect(grid.built.sort()).toEqual(['session-a', 'session-b']);
    expect(bridge.dropped.sort()).toEqual(['a', 'b']);
  });

  it('drops a derived tab instead of rebuilding it beside the card', async () => {
    // a diff tab dragged into the popout has no record and no state: it is
    // rebuilt from the card's Changes tab the next time it is asked for
    const grid = fakeGrid();
    grid.addGroups({ id: 'pop1', type: 'popout', win: deadWindow });
    grid.addPanel('diff-a', 'pop1');
    stubBridge([{ cardId: 'a' }]);

    rescueStrandedPopouts(grid.api);
    await settle();

    expect(grid.removed).toEqual(['diff-a']);
    expect(grid.built).toEqual([]);
  });

  it('does nothing at all in an ordinary workspace', async () => {
    const grid = fakeGrid();
    grid.addGroups({ id: 'g1' });
    grid.addPanel('session-a', 'g1');
    const bridge = stubBridge([{ cardId: 'a' }]);

    rescueStrandedPopouts(grid.api);
    await settle();

    expect(grid.removed).toEqual([]);
    expect(grid.built).toEqual([]);
    expect(bridge.dropped).toEqual([]);
  });

  it('keeps its hands off during teardown and during a layout restore', async () => {
    // Both are moments when dockview's popout state is mid-flight and the
    // layout is about to be written: a rescue then would save the workspace
    // WITHOUT the popout the user should get back next launch.
    for (const flag of ['tearing-down', 'restoring'] as const) {
      const grid = fakeGrid();
      grid.addGroups({ id: 'pop1', type: 'popout', win: deadWindow });
      grid.addPanel('session-a', 'pop1');
      stubBridge([{ cardId: 'a' }]);
      if (flag === 'tearing-down') sessionStore.setTearingDown(true);
      else sessionStore.setRestoringLayout(true);

      rescueStrandedPopouts(grid.api);
      await settle();

      expect(grid.removed, flag).toEqual([]);
      expect(sessionStore.getPresentation('a').suspended, flag).toBe(false);
      sessionStore.setTearingDown(false);
      sessionStore.setRestoringLayout(false);
    }
  });

  it('survives a card it cannot rescue, and rescues the next one', async () => {
    // fail-open, and the loop continues: one card that cannot be rebuilt must
    // not cost the others their rescue
    const grid = fakeGrid();
    grid.addGroups({ id: 'pop1', type: 'popout', win: deadWindow });
    grid.addPanel('session-a', 'pop1');
    grid.addPanel('session-b', 'pop1');
    stubBridge([{ cardId: 'a' }, { cardId: 'b' }]);
    const real = grid.api.removePanel.bind(grid.api);
    let first = true;
    (grid.api as unknown as { removePanel: (p: unknown) => void }).removePanel = (p) => {
      if (first) {
        first = false;
        throw new Error('detached');
      }
      (real as (p: unknown) => void)(p);
    };
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => rescueStrandedPopouts(grid.api)).not.toThrow();
    await settle();

    expect(grid.built).toEqual(['session-b']);
    expect(err).toHaveBeenCalledTimes(1);
    err.mockRestore();
  });

  it('never lets a broken grid throw into the microtask that calls it', () => {
    // the registry wraps its listeners in a try; the deferral that makes this
    // rescue safe to run also puts it OUTSIDE that protection, so it has to
    // carry its own — a disposed dockview is a read this can really make
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const hostile = {
      get panels(): never {
        throw new Error('disposed');
      },
    } as unknown as DockviewApi;

    expect(() => rescueStrandedPopouts(hostile)).not.toThrow();

    expect(err).toHaveBeenCalledTimes(1);
    err.mockRestore();
  });

  it('is a no-op with no grid at all', () => {
    expect(() => rescueStrandedPopouts(null)).not.toThrow();
  });
});

// ── ⤡ PUTS A CARD BACK WHERE IT CAME FROM (#558) ────────────────────────────
//
// The owner's repro in four lines: pop A out, start B inside that window (#531),
// dock A back, dock B back — and B landed in A's old slot while A was left in
// somebody else's group. One popout window carries ONE dock-back reference, the
// group it was torn from, and every card in it inherited that on the way home.
//
// What is pinned here is the DESTINATION, which is the whole of the fix: the
// decision (`homeGroupId`) is unit-tested in lib/dock-slot, the ordering and
// the aliveness are e2e's in `popout-dock-back.spec.ts`, and this is the layer
// between — `popOutCardPanel` reading a card's remembered home and choosing a
// group with it. The window-close half cannot be modelled here (a fake window
// does not tear a document down) and is deliberately not tried.
describe('docking a card back — where it lands (#558)', () => {
  const popoutWin = { closed: false, close: () => {} } as unknown as Window;

  afterEach(() => {
    for (const id of ['a', 'b', 'c']) sessionStore.forgetPresentation(id);
  });

  it('sends a card home to its OWN slot, reviving the husk it left', () => {
    // A is out in a window it shares with C, so ⤡ moves the panel rather than
    // closing the window. Its slot survives as the empty hidden group dockview
    // left behind — that husk IS the slot, and it must come back on screen.
    const grid = fakeGrid();
    grid.addGroups({ id: 'g-left', hidden: true }, { id: 'g-right' }, { id: 'pop', type: 'popout', win: popoutWin });
    grid.addPanel('session-b', 'g-right');
    grid.addPanel('session-a', 'pop');
    grid.addPanel('session-c', 'pop');
    sessionStore.setPresentation('a', { home: { groupId: 'g-left', index: 0, location: 'grid' } });

    popOutCardPanel(grid.api, 'a');

    expect(grid.groupOf('session-a')).toBe('g-left');
    expect(grid.api.groups.find((g) => g.id === 'g-left')?.api.isVisible).toBe(true);
    // ...and it did NOT join the first visible group it could find, which is
    // what the bug looked like from the outside: A abandoning its own half of
    // the screen for whatever else happened to be on it
    expect(grid.groupOf('session-b')).toBe('g-right');
  });

  it('a card born in the popout has no slot to claim, so it takes the ordinary one', () => {
    // C is #531's card: created inside A's window, never in the grid, no home.
    // The reference it would otherwise inherit is A's — the bug. `sessionCardHome`
    // is where a brand new session lands, which is the right answer for a card
    // that is, as far as the grid is concerned, brand new.
    const grid = fakeGrid();
    grid.addGroups({ id: 'g-left', hidden: true }, { id: 'g-right' }, { id: 'pop', type: 'popout', win: popoutWin });
    grid.addPanel('session-b', 'g-right');
    grid.addPanel('session-a', 'pop');
    grid.addPanel('session-c', 'pop');

    popOutCardPanel(grid.api, 'c');

    expect(grid.groupOf('session-c')).toBe('g-right');
    // A's slot is untouched — still empty, still hidden, still A's
    expect(grid.api.groups.find((g) => g.id === 'g-left')?.api.isVisible).toBe(false);
  });

  it('refuses a home that has become the document area', () => {
    // #462/#501 hold even for the card's own former group: a session never
    // displaces what you are reading.
    const grid = fakeGrid();
    grid.addGroups({ id: 'g-left' }, { id: 'g-right' }, { id: 'pop', type: 'popout', win: popoutWin });
    grid.addPanel('doc-1', 'g-left');
    grid.addPanel('session-b', 'g-right');
    grid.addPanel('session-a', 'pop');
    grid.addPanel('session-c', 'pop');
    sessionStore.setPresentation('a', { home: { groupId: 'g-left', index: 0, location: 'grid' } });

    popOutCardPanel(grid.api, 'a');

    expect(grid.groupOf('session-a')).toBe('g-right');
  });

  it('falls back when the slot is gone, and never rewrites the session’s group', () => {
    // The group A remembers was closed while it was away. And whichever branch
    // it takes, the move must not read as a user drag: E12-04 would adopt the
    // destination's membership, which for an empty slot means erasing A's.
    const grid = fakeGrid();
    grid.addGroups({ id: 'g-right' }, { id: 'pop', type: 'popout', win: popoutWin });
    grid.addPanel('session-b', 'g-right');
    grid.addPanel('session-a', 'pop');
    grid.addPanel('session-c', 'pop');
    sessionStore.setPresentation('a', { home: { groupId: 'g-vanished', index: 0, location: 'grid' } });
    const a = grid.api.getPanel('session-a')!;
    let movingDuringMove = false;
    // `.bind(a.api)` and not a bare `const moveTo = a.api.moveTo`: dockview
    // declares `moveTo` as a method, so carrying the original around as a
    // loose reference drops the receiver it is allowed to want
    // (`unbound-method`, #255 T4). The fake behind this api does not use
    // `this`, so this is the same call today and the correct one if the real
    // DockviewApi is ever put underneath the test.
    const moveTo = a.api.moveTo.bind(a.api);
    a.api.moveTo = (opts) => {
      movingDuringMove = sessionStore.isMoving('a');
      moveTo(opts);
    };

    popOutCardPanel(grid.api, 'a');

    expect(grid.groupOf('session-a')).toBe('g-right'); // the ordinary rules
    expect(movingDuringMove).toBe(true);
    expect(sessionStore.isMoving('a')).toBe(false); // ...and cleared after
  });
});

// ── WHAT COUNTS AS A CARD'S HOME (#558) ─────────────────────────────────────
//
// `captureSlots` banks two records per card on every layout change: `slot`,
// which is where it is NOW, and `home`, which is the grid slot ⤡ brings it back
// to. The difference between them is the whole reason the dock-back can be
// fixed at all, and both of the rules below were bugs before they were tests —
// the second one was measured: without it, quitting with a card popped out lost
// its slot on the next launch.
describe('captureSlots — what counts as a card’s home (#558)', () => {
  afterEach(() => sessionStore.forgetPresentation('a'));

  it('banks the grid slot as home, and a popout never overwrites it', () => {
    const grid = fakeGrid();
    grid.addGroups({ id: 'g-left' }, { id: 'pop', type: 'popout', win: liveWindow });
    grid.addPanel('session-a', 'g-left');

    captureSlots(grid.api);
    expect(sessionStore.getPresentation('a').home).toEqual({
      groupId: 'g-left',
      index: 0,
      location: 'grid',
    });

    // now it goes out into a window. `slot` follows it — that is how a reveal
    // finds the monitor again — and `home` must not: a card in another OS
    // window has not moved house, it has gone out.
    grid.api.getPanel('session-a')!.api.moveTo({
      group: grid.api.groups.find((g) => g.id === 'pop')!,
    });
    captureSlots(grid.api);
    expect(sessionStore.getPresentation('a').slot?.location).toBe('popout');
    expect(sessionStore.getPresentation('a').home?.groupId).toBe('g-left');
  });

  it('refuses a group that is in no document — the popout mid-restore', () => {
    // dockview rebuilds a saved popout as an ordinary group and only makes it a
    // popout ~100ms later, so for that window it is a grid group holding the
    // card and it is not a slot at all: its OS window does not exist yet.
    // Writing it would REPLACE the home the blob just restored, and nothing
    // would put that back — `slot` self-corrects on the next layout change,
    // `home` is only ever written from the grid.
    const grid = fakeGrid();
    grid.addGroups({ id: 'restoring', detached: true });
    grid.addPanel('session-a', 'restoring');
    sessionStore.setPresentation('a', {
      home: { groupId: 'g-real', index: 0, location: 'grid' },
    });

    captureSlots(grid.api);

    expect(sessionStore.getPresentation('a').home?.groupId).toBe('g-real');
    expect(sessionStore.getPresentation('a').slot?.groupId).toBe('restoring');
  });
});

// ── WHERE A CLOSING POPOUT'S CARDS END UP (#656, #657) ──────────────────────
//
// #558 fixed the ⤡ we drive ourselves. dockview drives the rest: it hands EVERY
// member of a closing window back through ONE reference — the group the window
// was torn from — so the card that did not tear it off is handed a slot it
// never earned. `settleDockedBackCards` is the correction, and it runs AFTER
// the panel is safely in the grid, because moving the last panel OUT of a
// popout group is the move that kills the card's DOM (#564's lesson, twice
// documented at the source).
//
// WHAT THESE TESTS CANNOT SEE, and it is the load-bearing half: the ORDER of
// `onDidLocationChange` and `onDidRemovePopoutGroup`, which is what tells a
// dockview return from a user drag. `noteCardCameHome` stands in for the first
// here; the real thing is pinned in `popout-dock-back.spec.ts`.
describe('settling a card a closing popout handed back (#656/#657)', () => {
  /** the microtask the settle defers into */
  const flush = (): Promise<void> => Promise.resolve();

  afterEach(() => {
    for (const id of ['a', 'b', 'c']) sessionStore.forgetPresentation(id);
    // the settle drains its own note; this clears one a failing assertion
    // stranded, so the next test cannot inherit it
    settleDockedBackCards(fakeGrid().api);
  });

  it('leaves a card in the slot dockview gave it when that slot is its OWN', async () => {
    // The ordinary lone round trip: the card that tore the window off comes
    // home to the group it left, dockview's reference and its `home` agree, and
    // the correction must cost that case nothing.
    const grid = fakeGrid();
    grid.addGroups({ id: 'g-left' }, { id: 'g-right' });
    grid.addPanel('session-a', 'g-left');
    grid.addPanel('session-b', 'g-right');
    sessionStore.setPresentation('a', { home: { groupId: 'g-left', index: 0, location: 'grid' } });

    noteCardCameHome('a');
    settleDockedBackCards(grid.api);
    await flush();

    expect(grid.groupOf('session-a')).toBe('g-left');
  });

  it('leaves a card that arrived BESIDE somebody where it is', async () => {
    // #558's rule for a card with no claim: a tab beside the card that owns
    // that half rather than instead of it. Nothing to correct.
    const grid = fakeGrid();
    grid.addGroups({ id: 'g-left' }, { id: 'g-right' });
    grid.addPanel('session-a', 'g-left');
    grid.addPanel('session-c', 'g-left');
    grid.addPanel('session-b', 'g-right');

    noteCardCameHome('c');
    settleDockedBackCards(grid.api);
    await flush();

    expect(grid.groupOf('session-c')).toBe('g-left');
  });

  it('moves a popout-born card OUT of the slot it inherited', async () => {
    // #657 itself. C was created inside A's window (#531) and never had a grid
    // slot; A has since left that group, so dockview handed C the whole of A's
    // half of the screen. Note the husk is VISIBLE by now — dockview un-hides
    // the reference group on the way in — which is exactly why the fallback has
    // to be told to exclude it.
    const grid = fakeGrid();
    grid.addGroups({ id: 'g-left' }, { id: 'g-right' });
    grid.addPanel('session-c', 'g-left');
    grid.addPanel('session-b', 'g-right');

    noteCardCameHome('c');
    settleDockedBackCards(grid.api);
    await flush();

    expect(grid.groupOf('session-c')).toBe('g-right');
  });

  it('sends a card whose own home still exists back to it', async () => {
    // Not the window's reference, the CARD's record — the same question ⤡ asks,
    // asked one step later because dockview got there first.
    const grid = fakeGrid();
    grid.addGroups({ id: 'g-left' }, { id: 'g-right' }, { id: 'g-mine', hidden: true });
    grid.addPanel('session-c', 'g-left');
    grid.addPanel('session-b', 'g-right');
    sessionStore.setPresentation('c', { home: { groupId: 'g-mine', index: 0, location: 'grid' } });

    noteCardCameHome('c');
    settleDockedBackCards(grid.api);
    await flush();

    expect(grid.groupOf('session-c')).toBe('g-mine');
    // ...and the husk it landed in is on screen again, or the card would be in
    // the DOM, in the right window, and ~1px wide (#434)
    expect(grid.api.groups.find((g) => g.id === 'g-mine')?.api.isVisible).toBe(true);
  });

  it('judges the card by the home it had when it CAME home, not the one it has now', async () => {
    // MEASURED, and the difference between this fix working and doing nothing:
    // dockview's own return fires a layout change, `captureSlots` runs on it,
    // sees the card sitting in a perfectly real grid group and banks THAT group
    // as its home — so by the time the settle asks "is this slot yours?" the
    // answer has become yes for the one card the question exists for. The note
    // carries the record taken as the card crossed back.
    const grid = fakeGrid();
    grid.addGroups({ id: 'g-left' }, { id: 'g-right' });
    grid.addPanel('session-c', 'g-left');
    grid.addPanel('session-b', 'g-right');

    noteCardCameHome('c'); // C had no home: it was born in the popout
    // ...and now the layout change lands, granting it the slot it never earned
    sessionStore.setPresentation('c', { home: { groupId: 'g-left', index: 0, location: 'grid' } });
    settleDockedBackCards(grid.api);
    await flush();

    expect(grid.groupOf('session-c')).toBe('g-right');
  });

  it('never reads the move as a user drag', async () => {
    // E12-04 adopts the destination's membership from a group change, and the
    // destination here is frequently EMPTY — `pickAdoptedGroupId` would return
    // null and erase the session's persistent group outright. That is #656's
    // headline for the lone branch and it must not come back through this door.
    const grid = fakeGrid();
    grid.addGroups({ id: 'g-left' }, { id: 'g-right' });
    grid.addPanel('session-c', 'g-left');
    grid.addPanel('session-b', 'g-right');
    const c = grid.api.getPanel('session-c')!;
    let movingDuringMove = false;
    const moveTo = c.api.moveTo.bind(c.api);
    c.api.moveTo = (opts) => {
      movingDuringMove = sessionStore.isMoving('c');
      moveTo(opts);
    };

    noteCardCameHome('c');
    settleDockedBackCards(grid.api);
    await flush();

    expect(movingDuringMove).toBe(true);
    expect(sessionStore.isMoving('c')).toBe(false);
  });

  it('DROPS a note nothing came to read, rather than saving it for later', async () => {
    // The note is only ever read by the `onDidRemovePopoutGroup` dockview fires
    // later in the SAME synchronous operation. Every other popout->grid move
    // leaves one nothing will drain — a tab dragged out of a window that
    // survives, and the drag that empties one (where the removal fires while
    // the panel is still in limbo, i.e. before the note exists). Kept, one of
    // those would be drained by an unrelated window closing minutes later and
    // would teleport a card the user had deliberately placed, on a record taken
    // before they placed it.
    const grid = fakeGrid();
    grid.addGroups({ id: 'g-left' }, { id: 'g-right' });
    grid.addPanel('session-c', 'g-left');
    grid.addPanel('session-b', 'g-right');

    noteCardCameHome('c');
    await flush(); // the task the note lives in ends here
    settleDockedBackCards(grid.api); // ...and some LATER window closes
    await flush();

    expect(grid.groupOf('session-c')).toBe('g-left');
  });

  it('does nothing during a quit or a layout restore', async () => {
    // The layout being written on the way out is the one WITH the popout in it,
    // and §5.25 promises that window comes back. A restore is the same layout
    // being rebuilt.
    const grid = fakeGrid();
    grid.addGroups({ id: 'g-left' }, { id: 'g-right' });
    grid.addPanel('session-c', 'g-left');
    grid.addPanel('session-b', 'g-right');

    sessionStore.setTearingDown(true);
    noteCardCameHome('c');
    settleDockedBackCards(grid.api);
    await flush();
    sessionStore.setTearingDown(false);

    expect(grid.groupOf('session-c')).toBe('g-left');
  });

  it('is a no-op when nothing came home, and survives a card that has gone', async () => {
    const grid = fakeGrid();
    grid.addGroups({ id: 'g-left' });
    grid.addPanel('session-b', 'g-left');

    settleDockedBackCards(grid.api); // nothing noted at all
    noteCardCameHome('ghost'); // ...and one whose panel is not there
    settleDockedBackCards(grid.api);
    await flush();

    expect(grid.ids()).toEqual(['session-b']);
  });

  it('tells our own moves from dockview handing a card back', () => {
    // The note must not be taken for a move that has already placed the card:
    // hiding removes the panel outright, and the ⤡-with-company branch does its
    // own `moveTo`. The lone ⤡ is the exception that needs saying — it arms
    // `isMoving` too and IS one of dockview's returns.
    // `finally`: both flags are module-singleton sets, so an assertion that
    // throws mid-test would leave card `a` flagged for the rest of the file and
    // fail something unrelated three tests later
    try {
      sessionStore.setHiding('a', true);
      expect(isDockviewReturn('a')).toBe(false);
      sessionStore.setHiding('a', false);

      sessionStore.setMoving('a', true);
      expect(isDockviewReturn('a')).toBe(false);
      sessionStore.setMoving('a', false);

      expect(isDockviewReturn('a')).toBe(true);

      const grid = fakeGrid();
      const win = { closed: false, close: () => {} } as unknown as Window;
      grid.addGroups({ id: 'g-left' }, { id: 'pop', type: 'popout', win });
      grid.addPanel('session-a', 'pop');
      popOutCardPanel(grid.api, 'a'); // the lone dock-back: armed AND a return
      expect(sessionStore.isMoving('a')).toBe(true);
      expect(isDockviewReturn('a')).toBe(true);
      forgetDockBacks();
      expect(sessionStore.isMoving('a')).toBe(false);
    } finally {
      sessionStore.setHiding('a', false);
      forgetDockBacks();
      sessionStore.setMoving('a', false);
    }
  });

  it('releases the lone dock-back’s flag on its own if the window never returns', () => {
    // The arm has no `finally`: `w.close()` does not tear the window down
    // synchronously, so the settle is the ordinary release and this is the
    // release for a window that simply never comes back. A card left `isMoving`
    // for ever would silently stop adopting a group on a real drag AND stop
    // suspending when its window is closed — worse than the bug being fixed.
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.useFakeTimers();
    try {
      const grid = fakeGrid();
      const win = { closed: false, close: () => {} } as unknown as Window;
      grid.addGroups({ id: 'g-left' }, { id: 'pop', type: 'popout', win });
      grid.addPanel('session-a', 'pop');

      popOutCardPanel(grid.api, 'a');
      expect(sessionStore.isMoving('a')).toBe(true);

      vi.advanceTimersByTime(60_000); // nothing ever came home
      expect(sessionStore.isMoving('a')).toBe(false);
    } finally {
      vi.useRealTimers();
      warned.mockRestore();
    }
  });

  it('releases the lone dock-back’s flag even when it has nothing to move', async () => {
    // `popOutCardPanel`'s lone branch arms `setMoving` BEFORE `w.close()`,
    // because the window does not tear down synchronously and there is no
    // `finally` to release it in. The settle is that release — and it has to
    // happen on the path that decides to move nothing as well.
    const grid = fakeGrid();
    const win = { closed: false, close: () => {} } as unknown as Window;
    grid.addGroups({ id: 'g-left' }, { id: 'pop', type: 'popout', win });
    grid.addPanel('session-a', 'pop');
    sessionStore.setPresentation('a', { home: { groupId: 'g-left', index: 0, location: 'grid' } });

    popOutCardPanel(grid.api, 'a'); // alone in its window: the close path
    expect(sessionStore.isMoving('a')).toBe(true);

    // dockview's own return, which the fake window cannot do for us
    grid.api.getPanel('session-a')!.api.moveTo({
      group: grid.api.groups.find((g) => g.id === 'g-left')!,
    });
    noteCardCameHome('a');
    settleDockedBackCards(grid.api);
    await flush();

    expect(grid.groupOf('session-a')).toBe('g-left');
    expect(sessionStore.isMoving('a')).toBe(false);
  });
});

// ── THE LADDER'S OWN HUSK BLINDNESS (#502) ──────────────────────────────────
//
// `moveHome` puts a card stepping back up to `expanded` at its remembered slot.
// It looked that slot up by location alone, which is blind to three things
// #501 taught the `+ session` and reveal doors: a group that has become the
// hidden dock-back husk, one that has become the document area, and one that is
// now in another OS window. The e2e measures the geometry (`toBeVisible()`
// passes at 1.33px); these pin the decision.
describe('expanding a tabbed card — where it goes (#502)', () => {
  afterEach(() => {
    for (const id of ['a', 'b']) sessionStore.forgetPresentation(id);
    delete (window as unknown as { switchboard?: unknown }).switchboard;
  });

  /** a tabbed card sharing the stack with another tabbed card */
  function stacked(slotGroupId: string): ReturnType<typeof fakeGrid> {
    const grid = fakeGrid();
    grid.addGroups(
      { id: 'stack' },
      { id: slotGroupId, hidden: slotGroupId === 'g-husk' },
      { id: 'g-other' }
    );
    grid.addPanel('session-a', 'stack');
    grid.addPanel('session-b', 'stack');
    sessionStore.setPresentation('a', {
      ladder: 'tabbed',
      slot: { groupId: slotGroupId, index: 0, location: 'grid' },
    });
    sessionStore.setPresentation('b', { ladder: 'tabbed' });
    return grid;
  }

  it('revives the husk its slot has become, rather than landing 1px wide in it', async () => {
    const grid = stacked('g-husk');

    await revealCardPanel(grid.api, 'a', false);

    expect(grid.groupOf('session-a')).toBe('g-husk');
    expect(grid.api.groups.find((g) => g.id === 'g-husk')?.api.isVisible).toBe(true);
    expect(sessionStore.getPresentation('a').ladder).toBe('expanded');
  });

  it('refuses a slot that has become the document area, and takes a fresh group', async () => {
    // #462/#501's mirror rule: a session must not displace what you are
    // reading, even when the group used to be its own.
    const grid = stacked('g-doc');
    grid.addPanel('doc-1', 'g-doc');

    await revealCardPanel(grid.api, 'a', false);

    expect(grid.groupOf('session-a')).not.toBe('g-doc');
    expect(grid.groupOf('session-a')).not.toBe('stack');
  });

  it('refuses a slot that is now in another OS window', async () => {
    // a rung change must never spawn or reach into an OS window — the same
    // argument the fresh-group branch already made for a POPOUT slot record,
    // which this had only ever applied when the group was gone
    const grid = fakeGrid();
    const win = { closed: false, close: () => {} } as unknown as Window;
    grid.addGroups({ id: 'stack' }, { id: 'gone-out', type: 'popout', win });
    grid.addPanel('session-a', 'stack');
    grid.addPanel('session-b', 'stack');
    sessionStore.setPresentation('a', {
      ladder: 'tabbed',
      slot: { groupId: 'gone-out', index: 0, location: 'grid' },
    });
    sessionStore.setPresentation('b', { ladder: 'tabbed' });

    await revealCardPanel(grid.api, 'a', false);

    expect(grid.groupOf('session-a')).not.toBe('gone-out');
    expect(grid.groupOf('session-a')).not.toBe('stack');
  });
});

// ── CLUSTERING A CARD WITH ITS GROUP-MATES (#503) ───────────────────────────
//
// The un-hardened twin of the lookup #501 fixed in `addSessionCardTo`: same
// rule, one path over, without the `isVisible` guard — and with the ordering
// argument that guard belongs to (`sessionCardHome` MUTATES, so it may only be
// asked after the sibling lookup, or a minted group is left in the grid empty
// for ever).
describe('clusterCardWithGroup — the E12-02 sibling lookup (#503)', () => {
  afterEach(() => {
    sessionStore.forgetPresentation('a');
    delete (window as unknown as { switchboard?: unknown }).switchboard;
  });

  it('joins a group-mate that is on screen', async () => {
    const grid = fakeGrid();
    grid.addGroups({ id: 'g-left' }, { id: 'g-right' });
    grid.addPanel('session-a', 'g-left');
    grid.addPanel('session-b', 'g-right');
    stubBridge([
      { cardId: 'a', groupId: 'team' },
      { cardId: 'b', groupId: 'team' },
    ]);

    await clusterCardWithGroup(grid.api, 'a', 'team');

    expect(grid.groupOf('session-a')).toBe('g-right');
  });

  it('refuses a group-mate sitting in an INVISIBLE grid group', async () => {
    // The husk blindness, one path over. A hidden grid group is a dock-back
    // shell or a leaf squeezed out by a maximize (E9-07); clustering is a
    // reason to land beside a group-mate, never a reason to land off-screen.
    const grid = fakeGrid();
    grid.addGroups({ id: 'g-left' }, { id: 'g-hidden', hidden: true });
    grid.addPanel('session-a', 'g-left');
    grid.addPanel('session-b', 'g-hidden');
    stubBridge([
      { cardId: 'a', groupId: 'team' },
      { cardId: 'b', groupId: 'team' },
    ]);

    await clusterCardWithGroup(grid.api, 'a', 'team');

    expect(grid.groupOf('session-a')).toBe('g-left');
  });

  it('LEAKS NO GROUP when there is no group-mate to join', async () => {
    // The regression this exists for: the shape #501 had to fix next door was
    // `find(...) ?? addGroup()`, where a sibling win left the minted group in
    // the grid, empty, for ever. This path has no fallback at all and must
    // never grow one — the card stays exactly where the user left it.
    const grid = fakeGrid();
    grid.addGroups({ id: 'g-left' });
    grid.addPanel('session-a', 'g-left');
    const groupsBefore = grid.api.groups.length;
    stubBridge([{ cardId: 'a', groupId: 'team' }]);

    await clusterCardWithGroup(grid.api, 'a', 'team');

    expect(grid.groupOf('session-a')).toBe('g-left');
    expect(grid.api.groups.length).toBe(groupsBefore);
  });

  it('does nothing at all for an UNGROUPING, or with no panel', async () => {
    const grid = fakeGrid();
    grid.addGroups({ id: 'g-left' }, { id: 'g-right' });
    grid.addPanel('session-a', 'g-left');
    grid.addPanel('session-b', 'g-right');
    stubBridge([
      { cardId: 'a', groupId: 'team' },
      { cardId: 'b', groupId: 'team' },
    ]);

    await clusterCardWithGroup(grid.api, 'a', null);
    await clusterCardWithGroup(null, 'a', 'team');
    await clusterCardWithGroup(grid.api, 'ghost', 'team');

    expect(grid.groupOf('session-a')).toBe('g-left');
    expect(grid.api.groups.length).toBe(2);
  });

  it('never reads its own move as a user drag', async () => {
    // the rail drop has ALREADY written the membership; E12-04 adopting from
    // the destination would let a group-mate's neighbours overwrite it
    const grid = fakeGrid();
    grid.addGroups({ id: 'g-left' }, { id: 'g-right' });
    grid.addPanel('session-a', 'g-left');
    grid.addPanel('session-b', 'g-right');
    const a = grid.api.getPanel('session-a')!;
    let movingDuringMove = false;
    const moveTo = a.api.moveTo.bind(a.api);
    a.api.moveTo = (opts) => {
      movingDuringMove = sessionStore.isMoving('a');
      moveTo(opts);
    };
    stubBridge([
      { cardId: 'a', groupId: 'team' },
      { cardId: 'b', groupId: 'team' },
    ]);

    await clusterCardWithGroup(grid.api, 'a', 'team');

    expect(movingDuringMove).toBe(true);
    expect(sessionStore.isMoving('a')).toBe(false);
  });
});
