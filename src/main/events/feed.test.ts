import { describe, it, expect } from 'vitest';
import { EventFeed } from './feed';
import { StatusChange } from '../sessions/session-manager';
import type { DispatchResultDto } from '../../shared/dispatch-result';

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

  it('acknowledge relaxes Done. to Ready; other kinds unaffected (Dan #4)', () => {
    const f = new EventFeed();
    f.ingest(change('a', 'done'));
    f.acknowledge('a');
    expect(f.list().map((e) => e.kind)).toEqual(['ready']);
    // a needs-permission is NOT ack-able — it clears by being answered
    f.ingest(change('b', 'needs-permission'));
    f.acknowledge('b');
    expect(f.list().map((e) => `${e.sessionId}:${e.kind}`)).toEqual(['a:ready', 'b:needs-permission']);
    // newer activity replaces ready like anything else
    f.ingest(change('a', 'needs-input'));
    expect(f.list().find((e) => e.sessionId === 'a')!.kind).toBe('needs-input');
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

/**
 * The second family (P2-E13-05). Everything here is about the ONE rule §5.12's
 * "one item per session" turned out to need spelling out: it is scoped to a
 * session's own attention STATE, and a report about a session somebody else
 * dispatched is not one.
 */
describe('EventFeed — dispatch results (P2-E13-05)', () => {
  const result = (reviewer: string, over: Partial<DispatchResultDto> = {}): DispatchResultDto => ({
    reviewer,
    reviewerName: `Review of Alpha (${reviewer})`,
    templateName: 'Code Reviewer',
    outcome: 'reported',
    chars: 1200,
    truncated: false,
    ...over,
  });

  it('files the row under the AUTHOR, not the session that produced it', () => {
    const f = new EventFeed();
    f.dispatchResult('author', result('reviewer'));
    const [row] = f.list();
    expect(row.sessionId).toBe('author');
    expect(row.kind).toBe('dispatch-result');
    expect(row.dispatch?.reviewer).toBe('reviewer');
  });

  // THE ONE THAT MATTERS. Without the STATUS_KINDS scope, the author's very next
  // status change silently deletes the finding — and the author typing is
  // exactly what they do after being told a review came back.
  it("SURVIVES the author's own status changes, in both directions", () => {
    const f = new EventFeed();
    f.dispatchResult('author', result('reviewer'));
    f.ingest(change('author', 'working')); // a non-attention change: clears status rows
    f.ingest(change('author', 'needs-permission'));
    f.ingest(change('author', 'done'));
    const rows = f.list().map((e) => `${e.sessionId}:${e.kind}`);
    expect(rows).toContain('author:dispatch-result');
    expect(rows).toContain('author:done');
    expect(rows).toHaveLength(2);
  });

  it("a status change still replaces the author's OTHER status row", () => {
    const f = new EventFeed();
    f.dispatchResult('author', result('reviewer'));
    f.ingest(change('author', 'needs-input'));
    f.ingest(change('author', 'done'));
    expect(f.list().filter((e) => e.kind === 'done')).toHaveLength(1);
    expect(f.list().filter((e) => e.kind === 'needs-input')).toHaveLength(0);
  });

  it('two different reviewers reporting to one author are two rows', () => {
    const f = new EventFeed();
    f.dispatchResult('author', result('r1'));
    f.dispatchResult('author', result('r2'));
    expect(f.list()).toHaveLength(2);
  });

  it('the SAME reviewer reporting twice replaces its own row', () => {
    const f = new EventFeed();
    f.dispatchResult('author', result('r1', { chars: 10 }));
    f.dispatchResult('author', result('r1', { chars: 99 }));
    expect(f.list()).toHaveLength(1);
    expect(f.list()[0].dispatch?.chars).toBe(99);
  });

  // With two rows on one session, a bare `find` by session could land on the
  // dispatch-result, see a kind that is not `done`, and leave a finished session
  // calling for eyes.
  it('acknowledge still finds the STATUS row past a dispatch result', () => {
    const f = new EventFeed();
    f.dispatchResult('author', result('reviewer'));
    f.ingest(change('author', 'done'));
    f.acknowledge('author');
    expect(f.list().map((e) => e.kind).sort()).toEqual(['dispatch-result', 'ready']);
  });

  it('dismiss takes ONE row by id, and leaves the session its other one', () => {
    const f = new EventFeed();
    f.dispatchResult('author', result('reviewer'));
    f.ingest(change('author', 'needs-permission'));
    const row = f.list().find((e) => e.kind === 'dispatch-result')!;
    f.dismiss(row.id);
    expect(f.list().map((e) => e.kind)).toEqual(['needs-permission']);
  });

  it('dismissing an id nobody holds changes nothing and notifies nobody', () => {
    const f = new EventFeed();
    f.ingest(change('a', 'done'));
    const seen: Array<unknown> = [];
    f.onEvent((e) => seen.push(e));
    f.dismiss(9999);
    expect(f.list()).toHaveLength(1);
    expect(seen).toHaveLength(0);
  });

  // The author's card going away takes everything filed under it. The report
  // itself is dropped on the same teardown by `DispatchResults.forget`.
  it('forget(author) takes the dispatch result with the status row', () => {
    const f = new EventFeed();
    f.dispatchResult('author', result('reviewer'));
    f.ingest(change('author', 'done'));
    f.forget('author');
    expect(f.list()).toEqual([]);
  });

  it('forget(reviewer) does NOT touch a result filed under its author', () => {
    const f = new EventFeed();
    f.dispatchResult('author', result('reviewer'));
    f.forget('reviewer');
    expect(f.list()).toHaveLength(1);
  });

  // The row does not go away when the finding is injected — main re-raises it
  // with a `delivered` outcome and `chars: 0`, so the used-state lives in the
  // LIST rather than in one component's `useState`. Taking the row down instead
  // was the first fix and it took the confirmation with it.
  it('a delivered result REPLACES the row rather than adding one', () => {
    const f = new EventFeed();
    f.dispatchResult('author', result('r1'));
    f.dispatchResult('author', { ...result('r1'), outcome: 'delivered', chars: 0 });
    expect(f.list()).toHaveLength(1);
    expect(f.list()[0].dispatch).toMatchObject({ outcome: 'delivered', chars: 0 });
  });

  it('a delivered result leaves ANOTHER reviewer’s row alone', () => {
    const f = new EventFeed();
    f.dispatchResult('author', result('r1'));
    f.dispatchResult('author', result('r2'));
    f.dispatchResult('author', { ...result('r1'), outcome: 'delivered', chars: 0 });
    const byReviewer = new Map(f.list().map((e) => [e.dispatch!.reviewer, e.dispatch!.outcome]));
    expect(byReviewer.get('r1')).toBe('delivered');
    expect(byReviewer.get('r2')).toBe('reported');
  });

  it('notifies on the add, like every other row', () => {
    const f = new EventFeed();
    const seen: Array<string | null> = [];
    f.onEvent((e) => seen.push(e ? e.kind : null));
    f.dispatchResult('author', result('reviewer'));
    expect(seen).toEqual(['dispatch-result']);
  });
});
