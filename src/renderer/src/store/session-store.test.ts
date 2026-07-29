import { describe, it, expect, beforeEach } from 'vitest';
import { SessionStore } from './session-store';
import { EventDto, RailGroup, RailSession } from '../model/types';

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

  it('card actions unregister by IDENTITY, so a remount does not drop the live handle', () => {
    const first = { setView: () => {}, currentView: () => 'feed', popOutToggle: () => {} };
    const second = { setView: () => {}, currentView: () => 'terminal', popOutToggle: () => {} };
    const offFirst = store.registerCardActions('card-A', first);
    // React remounts: the NEW registration lands before the old cleanup runs
    store.registerCardActions('card-A', second);
    offFirst();
    expect(store.actionsFor('card-A')).toBe(second);
  });
});
