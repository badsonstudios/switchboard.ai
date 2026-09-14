// `FeedBuffer` had no test file of its own until #788 — it was exercised
// entirely through `stream-feed.test.ts`, which is fine for the streaming
// lifecycle and useless for the one property this item added: that a block's
// ORIGIN survives `replace`. That method re-stamps the origin wholesale across
// a delta→message supersede, and a field left off the list does not fail, it
// comes back `undefined` — the #153 shape its own comment warns about.
import { describe, expect, it, vi } from 'vitest';
import { FeedBuffer } from './buffer';
import type { BlockOrigin, DerivedBlock, FeedBlock } from './blocks';

const seed: DerivedBlock = { kind: 'assistant', text: 'hi' };

function buffer(cap?: number): { buf: FeedBuffer; emitted: FeedBlock[] } {
  const emitted: FeedBlock[] = [];
  return { buf: new FeedBuffer((b) => emitted.push(b), cap), emitted };
}

describe('FeedBuffer origin', () => {
  it('stamps every origin field on push', () => {
    const { buf } = buffer();
    const origin: BlockOrigin = { sidechain: true, agentId: 'idA', agentName: 'Explore' };
    const b = buf.push(seed, origin);
    expect(b).toMatchObject({ seq: 1, sidechain: true, agentId: 'idA', agentName: 'Explore' });
  });

  it('leaves absent origin fields ABSENT, not undefined-valued', () => {
    // `{...b, agentId: undefined}` has the own key, so `toEqual` against a
    // pre-#788 shape stops matching and `'agentId' in block` starts lying.
    const { buf } = buffer();
    const b = buf.push(seed, { sidechain: false });
    expect(Object.prototype.hasOwnProperty.call(b, 'agentId')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(b, 'agentName')).toBe(false);
    expect(b).toEqual({ kind: 'assistant', text: 'hi', seq: 1, sidechain: false });
  });

  it('CARRIES the whole origin across replace', () => {
    const { buf } = buffer();
    const first = buf.push(seed, { sidechain: true, agentId: 'idA', agentName: 'Explore' });
    const merged = buf.replace(first, { kind: 'todos', todos: [{ content: 'x', status: 'done' }] });
    expect(merged).toMatchObject({
      seq: 1, // same seq — the renderer upserts on it
      kind: 'todos', // the message is authoritative about the block's KIND
      sidechain: true,
      agentId: 'idA',
      agentName: 'Explore',
    });
  });

  it('does not let a pushed BODY invent an origin', () => {
    // The origin argument is the authority on the whole group, not just on the
    // field that happens to always be present. A body carrying `agentId`
    // alongside `sidechain: false` would be stamped with both — the one
    // combination `agentOriginFor`'s gate exists to make impossible.
    const { buf } = buffer();
    const b = buf.push(
      { kind: 'assistant', text: 'hi', agentId: 'smuggled', agentName: 'evil' } as DerivedBlock,
      { sidechain: false }
    );
    expect(b.agentId).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(b, 'agentName')).toBe(false);
  });

  it('does not let the replacement INVENT an origin', () => {
    // `DerivedBlock` makes this unrepresentable in TypeScript, which is the
    // point of the type — but the cast below is exactly what a future caller
    // reaching for `as` would do, and the answer must still come from the block
    // being replaced. The message knows what the line said; it cannot know
    // which FILE the line came out of.
    const { buf } = buffer();
    const first = buf.push(seed, { sidechain: false });
    const merged = buf.replace(first, {
      kind: 'assistant',
      text: 'no',
      agentId: 'smuggled',
      sidechain: true,
    } as unknown as DerivedBlock);
    expect(merged.sidechain).toBe(false);
    expect(merged.agentId).toBeUndefined();
  });

  it('keeps a replaced block addressable by a tool result still in flight', () => {
    const { buf } = buffer();
    const call = buf.push(
      { kind: 'tool', tool: { name: 'Bash', category: 'shell', summary: 'ls' } },
      { sidechain: true, agentId: 'idA' }
    );
    buf.remember('tu_1', call);
    const merged = buf.replace(call, {
      kind: 'tool',
      tool: { name: 'Bash', category: 'shell', summary: 'ls -la' },
    });
    buf.attachResult('tu_1', 'out');
    expect(merged.tool?.out).toBe('out');
    expect(merged.agentId).toBe('idA');
  });

  it('gives two agents distinct origins in one buffer — the interleaved case', () => {
    // What the watcher actually produces: two subagent files draining into one
    // buffer in tail-arrival order.
    const { buf } = buffer();
    buf.push(seed, { sidechain: true, agentId: 'idA', agentName: 'Explore' });
    buf.push(seed, { sidechain: true, agentId: 'idB', agentName: 'Plan' });
    buf.push(seed, { sidechain: true, agentId: 'idA' });
    expect(buf.list().map((b) => [b.seq, b.agentId])).toEqual([
      [1, 'idA'],
      [2, 'idB'],
      [3, 'idA'],
    ]);
  });

  it('a thinking block still learns its duration from the next push', () => {
    // The origin argument changed shape under this rule; pinned so the change
    // could not have quietly skipped the branch above it.
    const { buf } = buffer();
    const think = buf.push({ kind: 'thinking', text: '', ts: '2026-09-14T00:00:00.000Z' }, {
      sidechain: false,
    });
    buf.push({ ...seed, ts: '2026-09-14T00:00:02.000Z' }, { sidechain: false });
    expect(think.durationMs).toBe(2000);
  });

  describe('a thinking duration is never measured across two agents (#788 review)', () => {
    const thought = { kind: 'thinking', text: '', ts: '2026-09-14T00:00:00.000Z' } as const;
    const later = { ...seed, ts: '2026-09-14T00:00:42.000Z' };

    it('does not time agent A`s thought by agent B`s clock', () => {
      // The defect in one line: two subagent files drain into one buffer with
      // NO ordering relation between them, so B's next line lands 42s after A
      // stopped thinking and A renders "Thought for 42s". A number about A
      // produced entirely by B.
      const { buf } = buffer();
      const think = buf.push(thought, { sidechain: true, agentId: 'idA' });
      buf.push(later, { sidechain: true, agentId: 'idB' });
      expect(think.durationMs).toBeUndefined();
    });

    it('does not time a subagent`s thought by the main conversation`s clock', () => {
      const { buf } = buffer();
      const think = buf.push(thought, { sidechain: true, agentId: 'idA' });
      buf.push(later, { sidechain: false });
      expect(think.durationMs).toBeUndefined();
    });

    it('STILL times one agent`s thought by its own next line', () => {
      // The control. Without this the rule above is satisfied by never
      // measuring anything, which is not the fix.
      const { buf } = buffer();
      const think = buf.push(thought, { sidechain: true, agentId: 'idA' });
      buf.push(later, { sidechain: true, agentId: 'idA' });
      expect(think.durationMs).toBe(42_000);
    });

    it('and still times the main conversation, where both sides are undefined', () => {
      const { buf } = buffer();
      const think = buf.push(thought, { sidechain: false });
      buf.push(later, { sidechain: false });
      expect(think.durationMs).toBe(42_000);
    });
  });

  it('emits nothing while muted', () => {
    const { buf, emitted } = buffer();
    buf.silently(() => buf.push(seed, { sidechain: true, agentId: 'idA' }));
    expect(emitted).toEqual([]);
    expect(buf.list()[0]?.agentId).toBe('idA');
  });

  it('does not throw when the emit callback does', () => {
    // fail-open: our breakage never blocks a session
    const buf = new FeedBuffer(vi.fn());
    expect(() => buf.push(seed, { sidechain: false })).not.toThrow();
  });
});
