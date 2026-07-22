import { describe, it, expect } from 'vitest';
import { EventFeed } from './feed';
import { StatusChange } from '../sessions/session-manager';

const change = (sessionId: string, to: string, at = new Date().toISOString()): StatusChange => ({
  sessionId,
  from: 'working',
  to: to as StatusChange['to'],
  cause: 'test',
  at,
});

describe('EventFeed (one item per session — Dan 2026-07-22 semantics)', () => {
  it('projects only attention-worthy transitions', () => {
    const f = new EventFeed();
    f.ingest(change('a', 'working'));
    f.ingest(change('a', 'starting'));
    f.ingest(change('a', 'needs-permission'));
    expect(f.list().map((e) => e.kind)).toEqual(['needs-permission']);
  });

  it("a session's newer event REPLACES its older one", () => {
    const f = new EventFeed();
    f.ingest(change('a', 'needs-permission'));
    f.ingest(change('a', 'done'));
    expect(f.list().map((e) => `${e.sessionId}:${e.kind}`)).toEqual(['a:done']);
  });

  it('a non-attention change CLEARS the session item (permission answered)', () => {
    const f = new EventFeed();
    f.ingest(change('a', 'needs-permission'));
    f.ingest(change('a', 'working')); // approval granted, tool runs
    expect(f.list()).toEqual([]);
  });

  it('interleaved sessions each keep exactly their latest state', () => {
    const f = new EventFeed();
    f.ingest(change('s1', 'needs-permission'));
    f.ingest(change('s2', 'needs-input'));
    f.ingest(change('s1', 'working')); // s1 answered
    f.ingest(change('s3', 'crashed'));
    f.ingest(change('s2', 'done'));
    const seq = f.list().map((e) => `${e.sessionId}:${e.kind}`);
    expect(seq).toEqual(['s3:crashed', 's2:done']);
  });

  it('done stays visible until the session produces something newer', () => {
    const f = new EventFeed();
    f.ingest(change('a', 'done'));
    expect(f.list().map((e) => e.kind)).toEqual(['done']);
    f.ingest(change('a', 'needs-input'));
    expect(f.list().map((e) => e.kind)).toEqual(['needs-input']);
  });

  it('forget() removes a closed session\'s item and notifies', () => {
    const f = new EventFeed();
    const changes: Array<unknown> = [];
    f.onEvent((e) => changes.push(e));
    f.ingest(change('a', 'done'));
    f.forget('a');
    expect(f.list()).toEqual([]);
    expect(changes).toHaveLength(2); // add + removal (null)
    expect(changes[1]).toBeNull();
  });

  it('notifies subscribers per change, isolated', () => {
    const f = new EventFeed();
    const seen: Array<string | null> = [];
    f.onEvent(() => {
      throw new Error('broken subscriber');
    });
    f.onEvent((e) => seen.push(e ? e.kind : null));
    f.ingest(change('a', 'done'));
    f.ingest(change('a', 'working')); // pure removal
    expect(seen).toEqual(['done', null]);
  });
});
