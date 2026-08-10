import { describe, it, expect, beforeEach } from 'vitest';
import { SessionStore } from './session-store';
import { EventDto, RailGroup, RailSession } from '../model/types';
import { DEFAULT_PRESENTATION } from '../lib/presentation';
import {
  DEFAULT_BOOK,
  withCard,
  withGlobal,
  withGroup,
} from '../lib/presentation-policy';
import { DEFAULT_LAYOUT, withMaximized, withMode } from '../lib/layout-mode';
import { DEFAULT_FOCUS_BOOK, withFocusCard, withFocusGlobal } from '../lib/focus-policy';
import { dropRetired } from '../lib/held-permissions';

// The done-when: "a unit test constructs a store, drives it, and asserts
// derived rail order + queue order WITHOUT React." That was impossible before
// — the ordering lived in App's render and in module-level maps inside
// SessionGrid, so asserting it meant mounting a tree and reading the DOM.

function session(id: string, over: Partial<RailSession> = {}): RailSession {
  return { id, title: id, folder: `C:/proj/${id}`, accent: 'var(--accent-test)', status: 'idle', ...over };
}

function event(id: number, sessionId: string, kind: EventDto['kind']): EventDto {
  // typed kind, not string: a typo used to compile and produce a silently
  // non-queueable event rather than a red test
  return { id, sessionId, kind, at: new Date(2026, 0, 1, 0, 0, id).toISOString() };
}

describe('SessionStore', () => {
  let store: SessionStore;
  beforeEach(() => {
    store = new SessionStore();
  });

  it('getState() is synchronous and reflects the last write immediately', () => {
    // the property every keyboard handler depends on: no commit in between
    store.setSessions([session('a')]);
    expect(store.getState().sessions.map((s) => s.id)).toEqual(['a']);
    store.setSessions([session('a'), session('b')]);
    expect(store.getState().sessions.map((s) => s.id)).toEqual(['a', 'b']);
  });

  it('notifies subscribers on change, and stops after unsubscribe', () => {
    let calls = 0;
    const off = store.subscribe(() => calls++);
    store.setCards(['c1']);
    store.setCards(['c1', 'c2']);
    expect(calls).toBe(2);
    off();
    store.setCards([]);
    expect(calls).toBe(2);
  });

  it('a subscriber that throws does not stop the others', () => {
    const seen: string[] = [];
    store.subscribe(() => {
      throw new Error('boom');
    });
    store.subscribe(() => seen.push('second'));
    store.setCards(['c1']);
    expect(seen).toEqual(['second']);
  });

  it('derived values keep a STABLE identity until something changes them', () => {
    // useSyncExternalStore compares getSnapshot() by identity — a fresh array
    // per call is an infinite render loop, not a performance detail
    store.setSessions([session('a')]);
    const rail = store.getRailOrder();
    expect(store.getRailOrder()).toBe(rail);
    store.setCards(['unrelated']); // does not touch sessions or groups
    expect(store.getRailOrder()).toBe(rail);
    store.setSessions([session('a'), session('b')]);
    expect(store.getRailOrder()).not.toBe(rail);
  });

  it('derives rail order from sessions + groups — the Ctrl+1..9 numbering', () => {
    const groups: RailGroup[] = [{ id: 'g1', name: 'Work', color: 'var(--accent-test)' } as RailGroup];
    store.setGroups(groups);
    store.setSessions([
      session('loose-1', { folder: 'C:/one' }),
      session('in-group', { groupId: 'g1', folder: 'C:/two' }),
    ]);
    const rail = store.getRailOrder();
    expect(rail.groups.map((g) => g.id)).toEqual(['g1']);
    expect(rail.groups[0].members.map((m) => m.id)).toEqual(['in-group']);
    expect(rail.loose.map((m) => m.id)).toEqual(['loose-1']);
  });

  it('the queue keeps a stable identity until events change it', () => {
    store.setEvents([event(1, 's', 'done')]);
    const q = store.getQueue();
    store.setSessions([session('a')]); // unrelated write
    expect(store.getQueue()).toBe(q);
    store.setEvents([event(2, 's', 'done')]);
    expect(store.getQueue()).not.toBe(q);
  });

  it('derives the attention queue in PRIORITY order, not arrival order', () => {
    store.setEvents([
      event(1, 's-done', 'done'),
      event(2, 's-perm', 'needs-permission'),
      event(3, 's-input', 'needs-input'),
    ]);
    // needs-permission -> needs-input -> crashed -> done (E9-03)
    expect(store.getQueue().map((e) => e.sessionId)).toEqual(['s-perm', 's-input', 's-done']);
  });
});

describe('the attention walk (the batching behaviour the refs protected)', () => {
  let store: SessionStore;
  beforeEach(() => {
    store = new SessionStore();
    store.setEvents([
      event(1, 'first', 'needs-permission'),
      event(2, 'second', 'needs-input'),
      event(3, 'third', 'done'),
    ]);
  });

  it('TWO presses in one frame advance TWO steps', () => {
    // The whole reason this is a store and not useState. With state, both
    // presses in a single frame would read the same visited set and hand back
    // the same session — Dan would press Ctrl+Space twice and go nowhere.
    const a = store.advanceQueue();
    const b = store.advanceQueue();
    expect(a?.sessionId).toBe('first');
    expect(b?.sessionId).toBe('second');
  });

  it('three presses clear the queue in priority order, then wrap', () => {
    expect([store.advanceQueue(), store.advanceQueue(), store.advanceQueue()].map((e) => e?.sessionId)).toEqual([
      'first',
      'second',
      'third',
    ]);
    // everything seen -> the walk starts again rather than dead-ending
    expect(store.advanceQueue()?.sessionId).toBe('first');
  });

  it('an empty queue is a no-op, never a focus change', () => {
    store.setEvents([]);
    expect(store.advanceQueue()).toBeNull();
  });

  it('the cursor is keyed by EVENT id, so a session that calls back re-enters', () => {
    store.advanceQueue(); // visits event 1
    // the same session raises a NEW event: EventFeed mints a fresh id on every
    // ingest, so keying by session id would have suppressed it for the life of
    // the process
    store.setEvents([event(9, 'first', 'needs-permission')]);
    expect(store.advanceQueue()?.sessionId).toBe('first');
  });
});

describe('membership changes (the DOM CustomEvent bus this replaced)', () => {
  let store: SessionStore;
  beforeEach(() => {
    store = new SessionStore();
  });

  it('does NOT fire on ordinary state writes — that is its whole design', () => {
    // it means "go re-read from main", not "state changed". Firing it on every
    // write would re-fetch the world several times a second.
    let fired = 0;
    store.subscribeMembership(() => fired++);
    store.setSessions([session('a')]);
    store.setEvents([event(1, 'a', 'done')]);
    store.setCards(['c1']);
    expect(fired).toBe(0);
  });

  it('fires when a grid drag changed membership, and stops after unsubscribe', () => {
    let fired = 0;
    const off = store.subscribeMembership(() => fired++);
    store.notifyMembershipChanged();
    expect(fired).toBe(1);
    off();
    store.notifyMembershipChanged();
    expect(fired).toBe(1);
  });

  it('a membership listener that throws does not stop the others', () => {
    const seen: string[] = [];
    store.subscribeMembership(() => {
      throw new Error('boom');
    });
    store.subscribeMembership(() => seen.push('second'));
    store.notifyMembershipChanged();
    expect(seen).toEqual(['second']);
  });
});

describe('the panel and the keyboard share one cursor', () => {
  let store: SessionStore;
  beforeEach(() => {
    store = new SessionStore();
    store.setEvents([event(1, 'first', 'needs-permission'), event(2, 'second', 'needs-input')]);
  });

  it('clicking a row in the panel makes the walk SKIP it', () => {
    // the two entry points write the same visited set — if they did not, the
    // panel's "next" marker and Ctrl+Space would point at different rows
    store.visit(1);
    expect(store.advanceQueue()?.sessionId).toBe('second');
  });

  it('visiting prunes ids that have left the queue', () => {
    store.visit(1);
    store.setEvents([event(2, 'second', 'needs-input')]); // event 1 is gone
    store.visit(2);
    expect(store.getState().visited.has(1)).toBe(false);
  });
});

describe('dockview lifecycle flags (written by the grid, read by the panel)', () => {
  it('default to false and round-trip', () => {
    const store = new SessionStore();
    expect(store.isTearingDown()).toBe(false);
    expect(store.isRestoringLayout()).toBe(false);
    store.setTearingDown(true);
    store.setRestoringLayout(true);
    expect(store.isTearingDown()).toBe(true);
    expect(store.isRestoringLayout()).toBe(true);
  });

  it('are OUTSIDE the notify path — teardown must not trigger renders', () => {
    const store = new SessionStore();
    let fired = 0;
    store.subscribe(() => fired++);
    store.setTearingDown(true);
    store.setRestoringLayout(true);
    expect(fired).toBe(0);
  });
});

// #201 is unbounded GROWTH, and the map's size is the only direct witness to
// it — a lookup samples one id at a time. Read through a cast rather than
// adding production API that exists only for a test.
function liveMapSize(store: SessionStore): number {
  return (store as unknown as { liveToCard: Map<string, string> }).liveToCard.size;
}
// #224 is the same defect one registry over: the grant set was never released
// at all, so its size is the witness for the same reason.
function allowAllSize(store: SessionStore): number {
  return (store as unknown as { allowAllByLive: Set<string> }).allowAllByLive.size;
}

describe('identity maps that used to be module globals', () => {
  let store: SessionStore;
  beforeEach(() => {
    store = new SessionStore();
  });

  it('maps a live session id to its durable card, and passes unknowns through', () => {
    store.mapLiveToCard('live-1', 'card-A');
    expect(store.cardIdForLive('live-1')).toBe('card-A');
    // an id it does not recognise goes straight through — the rail and the
    // grid both call this with ids of either kind
    expect(store.cardIdForLive('card-B')).toBe('card-B');
  });

  it("forgets the closed card's live id, and only that card's", () => {
    store.mapLiveToCard('live-1', 'card-A');
    // a resume: this bind is itself what releases live-1 (#201, below), so by
    // the close there is only ever one id to forget
    store.mapLiveToCard('live-2', 'card-A');
    store.mapLiveToCard('live-3', 'card-B');
    store.forgetCardLiveIds('card-A');
    expect(store.cardIdForLive('live-2')).toBe('live-2');
    expect(store.cardIdForLive('live-3')).toBe('card-B');
  });

  // #201 — the renderer mirror of #187/PR #199's reap. Main unbinds the dead
  // session when a fresh one takes the card; this side used to keep the corpse.
  it("drops the card's previous live id when a respawn rebinds it", () => {
    store.mapLiveToCard('live-1', 'card-A');
    store.mapLiveToCard('live-2', 'card-B');
    store.mapLiveToCard('live-1b', 'card-A'); // card-A crashed and respawned

    // the corpse passes through, exactly as an id the store never knew would
    expect(store.cardIdForLive('live-1')).toBe('live-1');
    expect(store.cardIdForLive('live-1b')).toBe('card-A');
    // only THIS card's bindings are swept — the neighbour is untouched
    expect(store.cardIdForLive('live-2')).toBe('card-B');
  });

  it('holds exactly one entry per card across repeated crash-respawn cycles', () => {
    for (let i = 0; i < 4; i++) store.mapLiveToCard(`live-${i}`, 'card-A');
    store.mapLiveToCard('other', 'card-B');
    store.mapLiveToCard('live-3', 'card-A'); // the same pair again: a no-op
    // the growth itself: three respawn cycles used to leave four entries for
    // the one card, released only when the card was closed
    expect(liveMapSize(store)).toBe(2);
    expect(store.cardIdForLive('live-3')).toBe('card-A');
    expect(store.cardIdForLive('other')).toBe('card-B');
  });

  it('allow-all is keyed by LIVE id, so a respawn prompts again', () => {
    store.setAllowAll('live-1');
    expect(store.isAllowAll('live-1')).toBe(true);
    expect(store.isAllowAll('live-2')).toBe(false); // the same card, respawned
  });

  // #224 — the grant is keyed by an ephemeral id and nothing dropped it, so it
  // outlived the session, the card, and everything but the app run itself.
  it("releases the closed card's allow-all grant, and only that card's", () => {
    store.mapLiveToCard('live-1', 'card-A');
    store.mapLiveToCard('live-2', 'card-B');
    store.setAllowAll('live-1');
    store.setAllowAll('live-2');

    store.forgetCardLiveIds('card-A');

    expect(store.isAllowAll('live-1')).toBe(false);
    expect(store.isAllowAll('live-2')).toBe(true); // the neighbour is untouched
    expect(allowAllSize(store)).toBe(1);
  });

  it("releases the corpse's grant when a respawn rebinds the card", () => {
    store.mapLiveToCard('live-1', 'card-A');
    store.setAllowAll('live-1');
    store.mapLiveToCard('live-1b', 'card-A'); // card-A crashed and respawned

    // the fresh session prompts again (it always did) — and the dead one's
    // grant is gone rather than parked for the rest of the run
    expect(store.isAllowAll('live-1b')).toBe(false);
    expect(store.isAllowAll('live-1')).toBe(false);
    expect(allowAllSize(store)).toBe(0);
  });

  it('holds at most one grant per card across repeated grant-respawn cycles', () => {
    for (let i = 0; i < 4; i++) {
      store.mapLiveToCard(`live-${i}`, 'card-A');
      store.setAllowAll(`live-${i}`);
    }
    // the growth itself: four granted sessions on one card used to leave four
    // entries, released by nothing at all
    expect(allowAllSize(store)).toBe(1);
    store.forgetCardLiveIds('card-A');
    expect(allowAllSize(store)).toBe(0);
  });

  it('keeps the grant when the SAME live session is rebound to its card', () => {
    // a remount over a still-running session: hide/reveal, a ladder move or a
    // pop-out re-enters the lazy spawn, and `sessions:create` adopts the running
    // session and returns its own id. Revoking there would make a granted
    // session start prompting again mid-run.
    store.mapLiveToCard('live-1', 'card-A');
    store.setAllowAll('live-1');
    store.mapLiveToCard('live-1', 'card-A');

    expect(store.isAllowAll('live-1')).toBe(true);
    expect(store.cardIdForLive('live-1')).toBe('card-A');
    expect(liveMapSize(store)).toBe(1);
  });

  it('dock-back is a one-shot flag: taking it consumes it', () => {
    // a button dock-back and a bare window close look identical to dockview
    // and mean opposite things (E8-04)
    store.markDockingBack('card-A');
    expect(store.takeDockingBack('card-A')).toBe(true);
    expect(store.takeDockingBack('card-A')).toBe(false);
  });

  it('hiding is flagged per card, so dockview removals can be told apart', () => {
    // removing a panel to HIDE it and the user closing the tab look identical
    // to dockview and mean opposite things (P2-E15-08)
    expect(store.isHiding('card-A')).toBe(false);
    store.setHiding('card-A', true);
    expect(store.isHiding('card-A')).toBe(true);
    expect(store.isHiding('card-B')).toBe(false);
    store.setHiding('card-A', false);
    expect(store.isHiding('card-A')).toBe(false);
  });

  // #312 — the tab strip's side of the identity, the half `getCardTitle` left.
  it("answers a card's accent and badge, and undefined for what it does not know", () => {
    store.setSessions([session('card-A', { accent: 'var(--accent-1)', badge: 'TS' })]);

    expect(store.getCardAccent('card-A')).toBe('var(--accent-1)');
    expect(store.getCardBadge('card-A')).toBe('TS');
    // a card the store has never heard of, and a tab with no card id at all (a
    // derived tab): both must read as "no answer", never as a stale neighbour's
    expect(store.getCardAccent('card-B')).toBeUndefined();
    expect(store.getCardBadge('card-B')).toBeUndefined();
    expect(store.getCardAccent(undefined)).toBeUndefined();
    expect(store.getCardBadge(undefined)).toBeUndefined();
  });

  it('settles by VALUE, so a useSyncExternalStore snapshot cannot loop', () => {
    // the reason these are two scalar getters and not one getCardIdentity():
    // a fresh {accent, badge} per call is a new identity every render, and
    // React re-renders until the snapshot stops changing — i.e. never
    store.setSessions([session('card-A', { accent: 'var(--accent-1)', badge: 'TS' })]);
    expect(store.getCardAccent('card-A')).toBe(store.getCardAccent('card-A'));
    expect(store.getCardBadge('card-A')).toBe(store.getCardBadge('card-A'));
  });

  it('reports a session that genuinely has no accent as having none', () => {
    store.setSessions([{ id: 'card-A', title: 'acme' }]);
    expect(store.getCardAccent('card-A')).toBeUndefined();
    expect(store.getCardBadge('card-A')).toBeUndefined();
  });
});

describe('SessionStore — presentation (P2-E15-08)', () => {
  let store: SessionStore;
  let persisted: Record<string, unknown>[];

  beforeEach(() => {
    store = new SessionStore();
    persisted = [];
    store.setPresentationPersister((blob) => persisted.push(blob));
  });

  it('an unknown card gets the SAME default object every read', () => {
    // useSyncExternalStore compares snapshots by identity: a fresh object per
    // call is an infinite render loop, not a cosmetic issue
    expect(store.getPresentation('nobody')).toBe(store.getPresentation('nobody'));
    expect(store.getPresentation(undefined)).toBe(store.getPresentation('nobody'));
    expect(store.getPresentation('nobody').view).toBe('feed');
  });

  it('a write publishes a NEW object for that card and leaves the others alone', () => {
    store.setPresentation('card-A', { view: 'terminal' });
    store.setPresentation('card-B', { view: 'diff' });
    const a = store.getPresentation('card-A');
    store.setPresentation('card-B', { view: 'feed' });
    expect(store.getPresentation('card-A')).toBe(a); // untouched card, same ref
    expect(store.getPresentation('card-B').view).toBe('feed');
  });

  it('a no-op write neither notifies nor persists', () => {
    store.setPresentation('card-A', { view: 'terminal' });
    const before = persisted.length;
    let notified = 0;
    store.subscribe(() => notified++);
    // slots are recaptured on every layout change — an identical one must not
    // re-render every card in the grid
    store.setPresentation('card-A', { view: 'terminal' });
    store.setPresentation('card-A', {
      slot: { groupId: 'g1', index: 0, location: 'grid' },
    });
    store.setPresentation('card-A', {
      slot: { groupId: 'g1', index: 0, location: 'grid' },
    });
    expect(notified).toBe(1); // only the first (real) slot change
    expect(persisted.length).toBe(before + 1);
  });

  it('reflected-only fields never reach the blob', () => {
    // dockview's layout JSON already round-trips popout location; a second
    // copy is two authorities waiting to disagree
    store.setPresentation('card-A', { poppedOut: true, suspended: true });
    expect(store.getPresentation('card-A').poppedOut).toBe(true);
    expect(persisted).toEqual([]);
  });

  it('persists the ladder and the slot, and prunes cards that are gone', () => {
    store.setPresentation('card-A', {
      ladder: 'hidden',
      slot: { groupId: 'g1', index: 2, location: 'grid' },
    });
    store.setPresentation('card-B', { view: 'terminal' });
    expect(persisted.at(-1)).toEqual({
      'card-A': { ladder: 'hidden', slot: { groupId: 'g1', index: 2, location: 'grid' } },
      'card-B': { view: 'terminal' },
    });
    store.prunePresentation(['card-B']);
    expect(store.isHidden('card-A')).toBe(false); // record gone with the card
    expect(persisted.at(-1)).toEqual({ 'card-B': { view: 'terminal' } });
  });

  it('init seeds the map without writing it back', () => {
    store.initPresentation(
      new Map([['card-A', { ...DEFAULT_PRESENTATION, ladder: 'hidden' as const }]])
    );
    expect(store.isHidden('card-A')).toBe(true);
    expect(persisted).toEqual([]); // it just READ the blob; writing it is a no-op at best
  });

  it('says whether the FEED has spoken, separately from what it said', () => {
    // E9-05's reveal-on-attention seeds itself from the first list and acts on
    // every one after. The store starts with an empty events array, so without
    // this flag that seeding pass is spent on a list nobody sent — and the first
    // REAL list arrives looking like a burst of new events, unfolding every
    // session that was blocked when you quit. `events.length` cannot answer it:
    // "the feed has not spoken" and "the feed says nothing is waiting" are the
    // same array.
    expect(store.hasFeed()).toBe(false);
    expect(store.getState().events).toEqual([]);
    store.setEvents([]); // an EMPTY list is still the feed speaking
    expect(store.hasFeed()).toBe(true);
  });

  it('tells our own panel moves from the user dragging a tab', () => {
    // dockview fires the same events for both, and two listeners act on them —
    // one adopts the new neighbours' persistent group, the other reads a popout
    // leaving its window as a user close and suspends the session. A ladder
    // change must do neither.
    expect(store.isMoving('card-A')).toBe(false);
    store.setMoving('card-A', true);
    expect(store.isMoving('card-A')).toBe(true);
    expect(store.isMoving('card-B')).toBe(false); // per card, like isHiding
    store.setMoving('card-A', false);
    expect(store.isMoving('card-A')).toBe(false);
  });
});

describe("SessionStore — the urgency strip's delayed reset (P2-E9-04)", () => {
  let store: SessionStore;
  const T = 1_000_000;
  beforeEach(() => {
    store = new SessionStore();
  });

  it('starts with nothing lit', () => {
    expect(store.getState().urgency.size).toBe(0);
  });

  it('markUrgency lights a card and publishes a new state object', () => {
    const before = store.getState();
    store.markUrgency('card-A', T);
    // no deadline yet: the strip starts the beat from the paint (#320), so all
    // the keypress records is that the lamp is lit
    expect(store.getState().urgency.get('card-A')).toBeNull();
    expect(store.getState().urgency.has('card-A')).toBe(true);
    expect(store.getState()).not.toBe(before); // identity IS the change signal
  });

  it('startUrgencyBeat turns the paint into the deadline', () => {
    store.markUrgency('card-A', T);
    store.startUrgencyBeat(['card-A'], T + 9000); // nine seconds of stalled frame
    expect(store.getState().urgency.get('card-A')).toBe(T + 9000 + 1500);
    // ...and it is a full beat from THERE, not from the keypress
    store.expireUrgency(T + 9000 + 1499);
    expect(store.getState().urgency.has('card-A')).toBe(true);
    store.expireUrgency(T + 9000 + 1500);
    expect(store.getState().urgency.has('card-A')).toBe(false);
  });

  it('startUrgencyBeat with nothing waiting is a NO-OP — a frame is not a re-render', () => {
    // it runs after the paint of every urgency change; most have nothing to start
    store.markUrgency('card-A', T);
    store.startUrgencyBeat(['card-A'], T);
    let notifications = 0;
    store.subscribe(() => {
      notifications += 1;
    });
    const before = store.getState();
    store.startUrgencyBeat(['card-A'], T + 100);
    expect(store.getState()).toBe(before);
    expect(notifications).toBe(0);
  });

  it('is readable SYNCHRONOUSLY, the way the keydown handler needs it', () => {
    // the jump marks the lamp from a keydown handler that runs outside React's
    // commit; two presses in one frame must both land, and the SECOND must see
    // the first without a render in between
    store.markUrgency('card-A', T);
    expect(store.getState().urgency.has('card-A')).toBe(true); // visible already
    store.markUrgency('card-B', T);
    expect([...store.getState().urgency.keys()]).toEqual(['card-A', 'card-B']);
  });

  it('ignores an empty card id rather than lighting a lamp nobody owns', () => {
    store.markUrgency('', T);
    expect(store.getState().urgency.size).toBe(0);
  });

  it('expireUrgency puts out only the lamps whose beat has passed', () => {
    store.markUrgency('card-A', T);
    store.startUrgencyBeat(['card-A'], T);
    store.markUrgency('card-B', T + 400);
    store.startUrgencyBeat(['card-B'], T + 400);
    store.expireUrgency(T + 1500);
    expect([...store.getState().urgency.keys()]).toEqual(['card-B']);
  });

  it('expireUrgency leaves a lamp nobody has seen yet alone', () => {
    // it is waiting on a frame, not on a clock — putting it out here is the
    // silent no-lamp case (#320) with extra steps
    store.markUrgency('card-A', T);
    store.expireUrgency(T + 60_000);
    expect(store.getState().urgency.has('card-A')).toBe(true);
  });

  it('expireUrgency with nothing to drop is a NO-OP — no re-render for a stray timer', () => {
    store.markUrgency('card-A', T);
    store.startUrgencyBeat(['card-A'], T);
    let notifications = 0;
    store.subscribe(() => {
      notifications += 1;
    });
    const before = store.getState();
    store.expireUrgency(T + 100);
    expect(store.getState()).toBe(before);
    expect(notifications).toBe(0);
  });

  it('notifies subscribers when a lamp lights, so the strip repaints', () => {
    let notifications = 0;
    store.subscribe(() => {
      notifications += 1;
    });
    store.markUrgency('card-A', T);
    expect(notifications).toBe(1);
  });
});

describe('SessionStore — presentation policy (P2-E9-06)', () => {
  let store: SessionStore;
  let persisted: Array<Record<string, unknown> | null>;
  beforeEach(() => {
    store = new SessionStore();
    persisted = [];
    store.setPolicyPersister((blob) => persisted.push(blob));
  });

  it('resolves a card through its GROUP without the caller knowing groups exist', () => {
    // the submit path, the rail's tick and any future layout mode all ask this
    // one question — three separate walks of the precedence chain is how two of
    // them end up wrong
    store.setSessions([session('card-A', { groupId: 'g1' }), session('card-B')]);
    store.setPolicies(withGroup(withGlobal(DEFAULT_BOOK, 'auto-hide'), 'g1', 'always-visible'));
    expect(store.policyFor('card-A')).toBe('always-visible');
    expect(store.policyFor('card-B')).toBe('auto-hide');
  });

  it('a per-session override beats the group and the global (the done-when)', () => {
    store.setSessions([session('card-A', { groupId: 'g1' })]);
    store.setPolicies(
      withCard(
        withGroup(withGlobal(DEFAULT_BOOK, 'always-visible'), 'g1', 'always-visible'),
        'card-A',
        'auto-hide'
      )
    );
    expect(store.policyFor('card-A')).toBe('auto-hide');
  });

  it('an unknown card gets the global — never a throw', () => {
    expect(store.policyFor('nobody')).toBe('always-visible');
    expect(store.policyFor(undefined)).toBe('always-visible');
  });

  it('init seeds the book without writing it back', () => {
    store.initPolicies(withGlobal(DEFAULT_BOOK, 'auto-hide'));
    expect(store.getPolicies().global).toBe('auto-hide');
    expect(persisted).toEqual([]); // it just READ the blob
  });

  it('persists on change, and writes null once nothing differs from the default', () => {
    store.setPolicies(withCard(DEFAULT_BOOK, 'card-A', 'auto-hide'));
    expect(persisted.at(-1)).toEqual({ cards: { 'card-A': 'auto-hide' } });
    store.setPolicies(withCard(store.getPolicies(), 'card-A', undefined));
    // null means "forget the key" — an untouched workspace must not keep a
    // settings record it no longer needs
    expect(persisted.at(-1)).toBeNull();
  });

  it('the same book twice is not a write and not a re-render', () => {
    const book = withGlobal(DEFAULT_BOOK, 'auto-hide');
    store.setPolicies(book);
    let notifications = 0;
    store.subscribe(() => notifications++);
    store.setPolicies(book);
    expect(notifications).toBe(0);
    expect(persisted.length).toBe(1);
  });

  it('prunes overrides for cards and groups that are gone', () => {
    store.setPolicies(
      withGroup(withCard(DEFAULT_BOOK, 'card-A', 'auto-hide'), 'g1', 'always-visible')
    );
    store.prunePolicies(['card-B'], ['g2']);
    expect(store.getPolicies().cards).toEqual({});
    expect(store.getPolicies().groups).toEqual({});
    expect(persisted.at(-1)).toBeNull();
  });
});

describe('SessionStore — focus-stealing policy (P2-E9-10)', () => {
  let store: SessionStore;
  let persisted: Array<Record<string, unknown> | null>;
  beforeEach(() => {
    store = new SessionStore();
    persisted = [];
    store.setFocusPolicyPersister((blob) => persisted.push(blob));
  });

  it('resolves global then per-session, and never throws for an unknown card', () => {
    store.setFocusPolicies(withFocusCard(withFocusGlobal(DEFAULT_FOCUS_BOOK, 'urgent'), 'card-A', 'focus'));
    expect(store.focusPolicyFor('card-A')).toBe('focus');
    expect(store.focusPolicyFor('card-B')).toBe('urgent');
    expect(store.focusPolicyFor(undefined)).toBe('urgent');
  });

  it('init seeds the book without writing it back', () => {
    store.initFocusPolicies(withFocusGlobal(DEFAULT_FOCUS_BOOK, 'none'));
    expect(store.getFocusPolicies().global).toBe('none');
    expect(persisted).toEqual([]); // it just READ the blob
  });

  it('persists on change, and writes null once nothing differs from the default', () => {
    store.setFocusPolicies(withFocusCard(DEFAULT_FOCUS_BOOK, 'card-A', 'urgent'));
    expect(persisted.at(-1)).toEqual({ cards: { 'card-A': 'urgent' } });
    store.setFocusPolicies(withFocusCard(store.getFocusPolicies(), 'card-A', undefined));
    expect(persisted.at(-1)).toBeNull();
  });

  it('prunes overrides for cards that are gone', () => {
    store.setFocusPolicies(withFocusCard(DEFAULT_FOCUS_BOOK, 'card-A', 'none'));
    store.pruneFocusPolicies(['card-B']);
    expect(store.getFocusPolicies().cards).toEqual({});
    expect(persisted.at(-1)).toBeNull();
  });

  it('`none` takes a session off the queue — and off the walk', () => {
    // the one place `none` bites. Ctrl+Space, the count that enables it and the
    // panel's next-up highlight all read this list, so silencing it once here
    // is what keeps the three of them agreeing.
    store.setEvents([event(1, 'loud', 'needs-permission'), event(2, 'quiet', 'needs-permission')]);
    expect(store.getQueue().map((e) => e.sessionId)).toEqual(['loud', 'quiet']);
    store.setFocusPolicies(withFocusCard(DEFAULT_FOCUS_BOOK, 'quiet', 'none'));
    expect(store.getQueue().map((e) => e.sessionId)).toEqual(['loud']);
    // the walk visits `loud` and then WRAPS to it, rather than handing over the
    // silenced session on the second press
    expect(store.advanceQueue()?.sessionId).toBe('loud');
    expect(store.advanceQueue()?.sessionId).toBe('loud');
  });

  it('re-derives the queue the MOMENT the policy changes, not at the next push', () => {
    store.setEvents([event(1, 'a', 'done')]);
    expect(store.getQueue().length).toBe(1);
    store.setFocusPolicies(withFocusGlobal(DEFAULT_FOCUS_BOOK, 'none'));
    expect(store.getQueue()).toEqual([]);
    // ...and back again, without the feed saying anything
    store.setFocusPolicies(withFocusGlobal(store.getFocusPolicies(), 'smart'));
    expect(store.getQueue().length).toBe(1);
  });

  it('silences by CARD, through the live-id mapping', () => {
    // events carry the live id and the override is card-keyed; getting this
    // backwards would silence nothing and do it quietly
    store.mapLiveToCard('live-9', 'card-A');
    store.setEvents([event(1, 'live-9', 'done')]);
    store.setFocusPolicies(withFocusCard(DEFAULT_FOCUS_BOOK, 'card-A', 'none'));
    expect(store.getQueue()).toEqual([]);
  });

  it('leaves the LOG alone — the panel still lists a silenced session', () => {
    // §5.12: the feed is the log, the queue is the to-do list. `none` takes a
    // session off the list, not out of the history.
    store.setEvents([event(1, 'quiet', 'needs-permission')]);
    store.setFocusPolicies(withFocusGlobal(DEFAULT_FOCUS_BOOK, 'none'));
    expect(store.getState().events.length).toBe(1);
    expect(store.getAttentionEvents()).toEqual([]);
  });
});

describe('SessionStore — layout mode (P2-E9-07)', () => {
  let store: SessionStore;
  let persisted: Array<Record<string, unknown> | null>;
  beforeEach(() => {
    store = new SessionStore();
    persisted = [];
    store.setLayoutPersister((blob) => persisted.push(blob));
  });

  it('starts on grid — the default is the absence of a layout rule', () => {
    expect(store.getLayout()).toEqual(DEFAULT_LAYOUT);
    expect(persisted).toEqual([]);
  });

  it('init seeds the mode without writing it back', () => {
    store.initLayout(withMode('queue'));
    expect(store.getLayout().mode).toBe('queue');
    expect(persisted).toEqual([]); // it just READ the blob
  });

  it('persists on change, and writes null once nothing differs from the default', () => {
    store.setLayout(withMode('focus'));
    expect(persisted.at(-1)).toEqual({ mode: 'focus' });
    store.setLayout(withMode('grid'));
    expect(persisted.at(-1)).toBeNull(); // forget the key entirely
  });

  it('the same state twice is not a write and not a re-render', () => {
    const next = withMode('focus');
    store.setLayout(next);
    let notifications = 0;
    store.subscribe(() => notifications++);
    store.setLayout(next);
    expect(notifications).toBe(0);
    expect(persisted.length).toBe(1);
  });

  it('drops a maximize whose card has been closed', () => {
    store.setLayout(withMaximized(DEFAULT_LAYOUT, 'card-A', { 'card-A': 'expanded' }));
    store.pruneLayout(['card-B']);
    expect(store.getLayout()).toEqual(DEFAULT_LAYOUT);
    expect(persisted.at(-1)).toBeNull();
  });

  it('forgets a closed card at the moment it closes, not at the next boot', () => {
    // a stale maximize makes the DEFAULT mode start enforcing, so this cannot
    // wait for the boot prune — see lib/layout-mode's isEnforced
    store.setLayout(withMaximized(DEFAULT_LAYOUT, 'card-A', { 'card-A': 'expanded' }));
    store.forgetLayoutCard('card-B'); // an unrelated close: no write, no re-render
    expect(store.getLayout().maximized).toBe('card-A');
    store.forgetLayoutCard('card-A');
    expect(store.getLayout()).toEqual(DEFAULT_LAYOUT);
  });
});

describe('SessionStore — the prompt-submit signal (P2-E9-06)', () => {
  it('carries the live session id to every listener, and one that throws costs only itself', () => {
    // the composer and the grid cannot see each other: the composer lives inside
    // a dockview panel, the grid owns the verb that would remove it
    const store = new SessionStore();
    const seen: string[] = [];
    const off1 = store.subscribePromptSubmit(() => {
      throw new Error('boom');
    });
    const off2 = store.subscribePromptSubmit((id) => seen.push(id));
    store.notifyPromptSubmitted('live-7');
    expect(seen).toEqual(['live-7']);
    off1();
    off2();
    store.notifyPromptSubmitted('live-8');
    expect(seen).toEqual(['live-7']); // unsubscribed
  });
});

describe('SessionStore — pinning (P2-E9-09)', () => {
  let store: SessionStore;
  let persisted: Array<string[] | null>;
  beforeEach(() => {
    store = new SessionStore();
    persisted = [];
    store.setPinPersister((blob) => persisted.push(blob));
  });

  it('starts with nothing pinned and nothing written', () => {
    expect(store.getPins().size).toBe(0);
    expect(store.isPinned('a')).toBe(false);
    expect(persisted).toEqual([]);
  });

  it('init seeds the pins without writing them back', () => {
    store.initPins(new Set(['a']));
    expect(store.isPinned('a')).toBe(true);
    expect(persisted).toEqual([]); // it just READ the blob
  });

  it('persists on change, and writes null once nothing is pinned', () => {
    store.togglePin('a');
    expect(persisted.at(-1)).toEqual(['a']);
    store.togglePin('a');
    expect(persisted.at(-1)).toBeNull(); // forget the key entirely
  });

  it('a no-op pin is not a write and not a re-render', () => {
    store.setPinned('a', true);
    let notifications = 0;
    store.subscribe(() => notifications++);
    store.setPinned('a', true);
    expect(notifications).toBe(0);
    expect(persisted.length).toBe(1);
  });

  it('§5.8: a pinned session sorts first in DERIVED rail order', () => {
    // the whole reason pinning is in `state` and not an imperative registry
    store.setSessions([session('a'), session('b'), session('c')]);
    expect(store.getRailOrder().flat.map((s) => s.id)).toEqual(['a', 'b', 'c']);
    store.togglePin('c');
    expect(store.getRailOrder().flat.map((s) => s.id)).toEqual(['c', 'a', 'b']);
    // ...and unpinning puts the rail back rather than leaving it re-sorted
    store.togglePin('c');
    expect(store.getRailOrder().flat.map((s) => s.id)).toEqual(['a', 'b', 'c']);
  });

  it('a session list that arrives AFTER the pin is still ordered by it', () => {
    // the boot order: presentation-boot seeds pins before the first session push
    store.initPins(new Set(['b']));
    store.setSessions([session('a'), session('b')]);
    expect(store.getRailOrder().flat.map((s) => s.id)).toEqual(['b', 'a']);
  });

  it('forgets a closed card at the moment it closes, and prunes the rest at boot', () => {
    store.setPinned('a', true);
    store.setPinned('b', true);
    store.forgetPin('c'); // an unrelated close: no write, no re-render
    expect(persisted.length).toBe(2);
    store.forgetPin('a');
    expect(store.isPinned('a')).toBe(false);
    store.prunePins(['b']);
    expect(persisted.length).toBe(3); // nothing stale: no fourth write
    store.prunePins([]);
    expect(store.getPins().size).toBe(0);
    expect(persisted.at(-1)).toBeNull();
  });
});

// #239 — the residual #224 named. The grid's held-permission queue is React
// state keyed by LIVE session id, and Restart / the popout-close suspend end
// the session with that component still mounted. The store is the only place
// that knows a live id has stopped being current, so it is the place that says
// so.
// (the issue number stays in the comment above: a `#nnn` inside a string
// literal trips the raw-hex-colour lint rule)
describe('SessionStore — the live-retired signal', () => {
  let store: SessionStore;
  beforeEach(() => {
    store = new SessionStore();
  });

  it('names the retired live id when a teardown unbinds its card', () => {
    const retired: string[] = [];
    store.subscribeLiveRetired((id) => retired.push(id));
    store.mapLiveToCard('live-1', 'card-A');
    store.mapLiveToCard('live-2', 'card-B');

    store.forgetCardLiveIds('card-A'); // Restart, or the popout-close suspend

    expect(retired).toEqual(['live-1']); // and NOT the neighbour's live session
  });

  it('names the corpse when a respawn rebinds the card, not the newcomer', () => {
    const retired: string[] = [];
    store.subscribeLiveRetired((id) => retired.push(id));
    store.mapLiveToCard('live-1', 'card-A');
    store.mapLiveToCard('live-1b', 'card-A'); // card-A crashed and respawned

    expect(retired).toEqual(['live-1']);
  });

  it('says nothing when the SAME live session is rebound to its card', () => {
    // The other half of #224's same-pair guard, and the reason this signal is
    // not "live went null": a remount over a STILL-RUNNING session re-enters
    // the lazy spawn and `sessions:create` hands back the id it already had.
    // Announcing a retirement there would take a live session's held prompt out
    // of the review bar with the CLI still blocked on it.
    const retired: string[] = [];
    store.subscribeLiveRetired((id) => retired.push(id));
    store.mapLiveToCard('live-1', 'card-A');
    store.mapLiveToCard('live-1', 'card-A');

    expect(retired).toEqual([]);
  });

  it('says nothing for a card that has no live session bound', () => {
    const retired: string[] = [];
    store.subscribeLiveRetired((id) => retired.push(id));
    store.forgetCardLiveIds('card-A'); // idempotent, and silent
    expect(retired).toEqual([]);
  });

  it('hands the subscriber a fully released id: unbound AND ungranted', () => {
    // the grid's subscriber runs synchronously inside forgetCardLiveIds, so
    // what it can read of this store while it runs is part of the contract.
    // (The batching itself is unobservable today — one live id per card means
    // one notify per sweep — so this pins the guarantee, not the mechanism.)
    store.mapLiveToCard('live-1', 'card-A');
    store.setAllowAll('live-1');
    let lookupDuringNotify: string | null = null;
    let grantedDuringNotify: boolean | null = null;
    store.subscribeLiveRetired((id) => {
      lookupDuringNotify = store.cardIdForLive(id);
      grantedDuringNotify = store.isAllowAll(id);
    });

    store.forgetCardLiveIds('card-A');

    // a STILL-BOUND id would answer 'card-A' here; an unbound one falls through
    expect(lookupDuringNotify).not.toBe('card-A');
    expect(lookupDuringNotify).toBe('live-1');
    expect(grantedDuringNotify).toBe(false); // and the grant is already gone
  });

  it('delivers to every listener, one that throws costs only itself, and off() stops it', () => {
    const seen: string[] = [];
    const off1 = store.subscribeLiveRetired(() => {
      throw new Error('boom');
    });
    const off2 = store.subscribeLiveRetired((id) => seen.push(id));
    store.mapLiveToCard('live-1', 'card-A');
    store.forgetCardLiveIds('card-A');
    expect(seen).toEqual(['live-1']);

    off1();
    off2();
    store.mapLiveToCard('live-2', 'card-A');
    store.forgetCardLiveIds('card-A');
    expect(seen).toEqual(['live-1']); // unsubscribed
  });

  // The two halves joined: this store's signal and the REAL rule the grid's
  // effect applies (`lib/held-permissions`, tested on its own next door).
  // SessionGrid has no test file, so the effect is the one uncovered link —
  // this is as close to the user-visible property as a unit test reaches.
  it("drops a torn-down session's held prompts from the review bar, and keeps a live card's", () => {
    let queue = [
      { requestId: 'perm-1', sessionId: 'live-A' },
      { requestId: 'perm-2', sessionId: 'live-A' },
      { requestId: 'perm-3', sessionId: 'live-B' },
    ];
    store.subscribeLiveRetired((liveId) => {
      queue = dropRetired(queue, liveId);
    });
    store.mapLiveToCard('live-A', 'card-A');
    store.mapLiveToCard('live-B', 'card-B');
    store.setAllowAll('live-A'); // the user had already granted the dead session

    store.mapLiveToCard('live-A2', 'card-A'); // card-A restarted

    // both of the dead session's questions leave the bar; the other card's
    // stays, because its session is still blocked on it
    expect(queue).toEqual([{ requestId: 'perm-3', sessionId: 'live-B' }]);
    // the grant went with the binding (#224), so a hold that HAD stayed in the
    // bar would have re-granted an id in no map — which is the leak, and the
    // reason the two releases have to happen together
    expect(store.isAllowAll('live-A')).toBe(false);
  });
});
