import { describe, it, expect } from 'vitest';
import { attentionQueue, nextInQueue, panelOrder, withVisit, AttentionEvent } from './queue';

let nextId = 1;
function ev(
  kind: AttentionEvent['kind'],
  sessionId: string,
  atMinute: number,
  id = nextId++,
): AttentionEvent {
  return { id, sessionId, kind, at: `2026-07-26T10:${String(atMinute).padStart(2, '0')}:00.000Z` };
}

describe('attentionQueue — priority ordering (§5.8)', () => {
  it('orders needs-permission -> needs-input -> crashed -> done', () => {
    // deliberately fed in the WRONG order, and newest-first within it, so a
    // pass-through implementation cannot accidentally satisfy this
    const events = [ev('done', 'd', 1), ev('crashed', 'c', 2), ev('needs-input', 'i', 3), ev('needs-permission', 'p', 4)];
    expect(attentionQueue(events).map((e) => e.sessionId)).toEqual(['p', 'i', 'c', 'd']);
  });

  it('is OLDEST first inside one priority band — longest wait is owed first', () => {
    const events = [ev('needs-permission', 'newer', 30), ev('needs-permission', 'older', 5)];
    expect(attentionQueue(events).map((e) => e.sessionId)).toEqual(['older', 'newer']);
  });

  it('breaks an exact timestamp tie by event id, not input order', () => {
    const later = ev('crashed', 'later', 10, 99);
    const earlier = ev('crashed', 'earlier', 10, 7);
    expect(attentionQueue([later, earlier]).map((e) => e.sessionId)).toEqual(['earlier', 'later']);
  });

  it('EXCLUDES ready — acknowledged work is reviewed, not to-do', () => {
    const events = [ev('ready', 'seen', 1), ev('done', 'unseen', 2)];
    expect(attentionQueue(events).map((e) => e.sessionId)).toEqual(['unseen']);
  });

  it('is empty when nothing needs a human', () => {
    expect(attentionQueue([ev('ready', 'a', 1)])).toEqual([]);
    expect(attentionQueue([])).toEqual([]);
  });

  it('does not mutate the events it was handed', () => {
    const events = [ev('done', 'd', 1), ev('needs-permission', 'p', 2)];
    const before = events.map((e) => e.sessionId);
    attentionQueue(events);
    expect(events.map((e) => e.sessionId)).toEqual(before);
  });
});

describe('nextInQueue — the Ctrl+Space walk', () => {
  it('clears three sessions in priority order under repeated presses', () => {
    // the item's headline done-when, as a unit test: nothing about the
    // sessions' STATE changes between presses — only the visited set moves
    const events = [ev('crashed', 'c', 1), ev('needs-permission', 'p', 2), ev('needs-input', 'i', 3)];
    const seen: string[] = [];
    let visited: ReadonlySet<number> = new Set();
    for (let i = 0; i < 3; i++) {
      const r = nextInQueue(events, visited);
      seen.push(r.next!.sessionId);
      visited = r.visited;
      expect(r.wrapped).toBe(false);
    }
    expect(seen).toEqual(['p', 'i', 'c']);
  });

  it('wraps to the head once everything has been visited', () => {
    const events = [ev('needs-permission', 'p', 1), ev('needs-input', 'i', 2)];
    let visited: ReadonlySet<number> = new Set();
    visited = nextInQueue(events, visited).visited;
    visited = nextInQueue(events, visited).visited;
    const third = nextInQueue(events, visited);
    expect(third.next!.sessionId).toBe('p');
    expect(third.wrapped).toBe(true);
    // and the walk continues cleanly after the wrap rather than sticking
    expect(nextInQueue(events, third.visited).next!.sessionId).toBe('i');
  });

  it('no-ops on an empty queue', () => {
    const r = nextInQueue([ev('ready', 'a', 1)], new Set());
    expect(r.next).toBeNull();
    expect(r.wrapped).toBe(false);
  });

  it('a session that calls AGAIN re-enters the walk (visited is keyed by event id)', () => {
    // visit the only item...
    const first = ev('needs-input', 'talky', 1, 100);
    const r1 = nextInQueue([first], new Set());
    expect(r1.next!.id).toBe(100);
    // ...then the session goes quiet and calls back: EventFeed mints a NEW id
    const again = ev('needs-permission', 'talky', 9, 101);
    const r2 = nextInQueue([again], r1.visited);
    expect(r2.next!.id).toBe(101);
    expect(r2.wrapped).toBe(false); // a genuine new call, not a wrap-around
  });

  it('an answered item leaves the queue and the walk moves on', () => {
    const held = ev('needs-permission', 'p', 1);
    const waiting = ev('needs-input', 'i', 2);
    const r1 = nextInQueue([held, waiting], new Set());
    expect(r1.next!.sessionId).toBe('p');
    // the human allows it: the feed drops that session's event entirely
    const r2 = nextInQueue([waiting], r1.visited);
    expect(r2.next!.sessionId).toBe('i');
  });

  it('prunes visited ids that are no longer queued', () => {
    const gone = ev('crashed', 'gone', 1, 200);
    const stays = ev('crashed', 'stays', 2, 201);
    const r1 = nextInQueue([gone, stays], new Set());
    expect(r1.visited.has(200)).toBe(true);
    // 'gone' is closed; its id must not linger in the set forever
    const r2 = nextInQueue([stays], r1.visited);
    expect(r2.visited.has(200)).toBe(false);
    expect(r2.visited.has(201)).toBe(true);
  });

  it('a newly arrived higher-priority item cuts the line ahead of unvisited work', () => {
    const low = ev('done', 'd', 1);
    const r1 = nextInQueue([low], new Set());
    expect(r1.next!.sessionId).toBe('d');
    const urgent = ev('needs-permission', 'p', 5);
    expect(nextInQueue([low, urgent], r1.visited).next!.sessionId).toBe('p');
  });
});

describe('withVisit — the shared prune rule', () => {
  it('is the same rule the hotkey walk uses, so a click and a jump agree', () => {
    // a click marks a row visited; the very next hotkey press must skip it
    const p = ev('needs-permission', 'p', 1, 300);
    const i = ev('needs-input', 'i', 2, 301);
    const clicked = withVisit(new Set(), [p, i], 300);
    expect(nextInQueue([p, i], clicked).next!.id).toBe(301);
  });

  it('drops ids that are no longer queued rather than growing forever', () => {
    const stays = ev('crashed', 'stays', 2, 401);
    const visited = withVisit(new Set([400, 999]), [stays], 401);
    expect([...visited]).toEqual([401]);
  });

  it('treats an acknowledged (ready) event as gone — it is out of the queue', () => {
    const reviewed = ev('ready', 'r', 1, 500);
    const live = ev('done', 'd', 2, 501);
    expect([...withVisit(new Set([500]), [reviewed, live], 501)]).toEqual([501]);
  });
});

describe('panelOrder — what the Events panel renders', () => {
  it('puts the queue first and the reviewed tail after it', () => {
    const events = [ev('ready', 'r', 1), ev('done', 'd', 2), ev('needs-permission', 'p', 3)];
    expect(panelOrder(events).map((e) => e.sessionId)).toEqual(['p', 'd', 'r']);
  });

  it('shows the reviewed tail newest first — down there it is a log again', () => {
    const events = [ev('ready', 'old', 1), ev('ready', 'new', 20)];
    expect(panelOrder(events).map((e) => e.sessionId)).toEqual(['new', 'old']);
  });

  it('never drops an event the feed is holding', () => {
    const events = [ev('ready', 'r', 1), ev('crashed', 'c', 2), ev('done', 'd', 3)];
    expect(panelOrder(events)).toHaveLength(events.length);
  });
});
