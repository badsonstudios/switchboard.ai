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

  it('forgets every live id belonging to a closed card', () => {
    store.mapLiveToCard('live-1', 'card-A');
    store.mapLiveToCard('live-2', 'card-A'); // same card, after a resume
    store.mapLiveToCard('live-3', 'card-B');
    store.forgetCardLiveIds('card-A');
    expect(store.cardIdForLive('live-1')).toBe('live-1');
    expect(store.cardIdForLive('live-2')).toBe('live-2');
    expect(store.cardIdForLive('live-3')).toBe('card-B');
  });

  it('allow-all is keyed by LIVE id, so a respawn prompts again', () => {
    store.setAllowAll('live-1');
    expect(store.isAllowAll('live-1')).toBe(true);
    expect(store.isAllowAll('live-2')).toBe(false); // the same card, respawned
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
    expect(store.getState().urgency.get('card-A')).toBe(T + 1500);
    expect(store.getState()).not.toBe(before); // identity IS the change signal
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
    store.markUrgency('card-B', T + 400);
    store.expireUrgency(T + 1500);
    expect([...store.getState().urgency.keys()]).toEqual(['card-B']);
  });

  it('expireUrgency with nothing to drop is a NO-OP — no re-render for a stray timer', () => {
    store.markUrgency('card-A', T);
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
