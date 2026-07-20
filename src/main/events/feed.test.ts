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

describe('EventFeed', () => {
  it('projects only attention-worthy transitions', () => {
    const f = new EventFeed();
    f.ingest(change('a', 'working'));
    f.ingest(change('a', 'starting'));
    f.ingest(change('a', 'needs-permission'));
    f.ingest(change('a', 'done'));
    expect(f.list().map((e) => e.kind)).toEqual(['needs-permission', 'done']);
  });

  it('a 3-session interleaved work cycle reads coherently (the done-when)', () => {
    const f = new EventFeed();
    // three sessions running the recorded S-06 cycle, interleaved
    f.ingest(change('s1', 'working'));
    f.ingest(change('s2', 'working'));
    f.ingest(change('s1', 'needs-permission'));
    f.ingest(change('s3', 'working'));
    f.ingest(change('s2', 'needs-input'));
    f.ingest(change('s1', 'done'));
    f.ingest(change('s3', 'crashed'));
    f.ingest(change('s2', 'done'));
    const seq = f.list().map((e) => `${e.sessionId}:${e.kind}`);
    expect(seq).toEqual([
      's1:needs-permission',
      's2:needs-input',
      's1:done',
      's3:crashed',
      's2:done',
    ]);
    // ordered, session-attributed, noise-free
    expect(new Set(f.list().map((e) => e.id)).size).toBe(5);
  });

  it('caps the ring', () => {
    const f = new EventFeed(3);
    for (let i = 0; i < 6; i++) f.ingest(change('s', 'done'));
    expect(f.list()).toHaveLength(3);
    expect(f.list()[0].id).toBe(4);
  });

  it('notifies subscribers per event, isolated', () => {
    const f = new EventFeed();
    const seen: string[] = [];
    f.onEvent(() => {
      throw new Error('broken subscriber');
    });
    f.onEvent((e) => seen.push(e.kind));
    f.ingest(change('a', 'done'));
    expect(seen).toEqual(['done']);
  });
});
