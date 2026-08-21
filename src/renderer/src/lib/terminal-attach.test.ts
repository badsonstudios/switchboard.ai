import { describe, it, expect, vi } from 'vitest';
import { attachTerminalFeed, TerminalFeedPorts } from './terminal-attach';
import type { PtyChunk } from '../../../shared/ipc/pty';
import { ipcRefusal } from '../../../shared/ipc/refusal';

/** A controllable stand-in for the preload bridge + xterm. Records everything
 *  in one ordered log, because the ORDER is what #117 is about. */
function harness(
  opts: {
    subscribeThrows?: boolean;
    attachThrows?: boolean;
    unsubscribeThrows?: boolean;
    onErrorThrows?: boolean;
  } = {},
): {
  ports: TerminalFeedPorts;
  log: string[];
  /** push a chunk down the `pty:data:<id>` listener, as main would. Holds the
   *  callback directly so it can still be invoked after an unsubscribe — the
   *  case a real EventEmitter produces mid-dispatch. */
  emit: (d: string, epoch?: number) => void;
  /** resolve the in-flight `pty:attach` invoke */
  resolveAttach: (snapshot: string | null, epoch?: number) => void;
  resolveAttachRaw: (value: unknown) => void;
  rejectAttach: (err: unknown) => void;
  subscribed: () => boolean;
  errors: unknown[];
  readyCount: () => number;
  throwFrom: (part: 'write' | 'reset' | 'onReady', needle?: string) => void;
  stopThrowing: () => void;
} {
  const log: string[] = [];
  const errors: unknown[] = [];
  let chunkCb: ((c: PtyChunk) => void) | null = null;
  let attached = false;
  let resolve!: (a: { epoch: number; snapshot: string } | null) => void;
  let reject!: (e: unknown) => void;
  let ready = 0;
  let throwing: { part: 'write' | 'reset' | 'onReady'; needle?: string } | null = null;

  const attachPromise = new Promise<{ epoch: number; snapshot: string } | null>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  const ports: TerminalFeedPorts = {
    subscribe: (cb) => {
      if (opts.subscribeThrows) throw new Error('bridge gone');
      log.push('subscribe');
      chunkCb = cb;
      attached = true;
      return () => {
        log.push('unsubscribe');
        attached = false;
        if (opts.unsubscribeThrows) throw new Error('removeListener blew up');
      };
    },
    attach: () => {
      if (opts.attachThrows) throw new Error('could not be cloned');
      log.push('attach');
      return attachPromise;
    },
    detach: () => log.push('detach'),
    reset: () => {
      if (throwing?.part === 'reset') throw new Error('reset blew up');
      log.push('reset');
    },
    write: (d) => {
      if (throwing?.part === 'write' && (throwing.needle === undefined || d.includes(throwing.needle)))
        throw new Error('write blew up');
      log.push(`write:${d}`);
    },
    onReady: () => {
      if (throwing?.part === 'onReady') throw new Error('fit blew up');
      ready += 1;
      log.push('ready');
    },
    onError: (e) => {
      errors.push(e);
      log.push('error');
      if (opts.onErrorThrows) throw new Error('the reporter itself is broken');
    },
  };

  return {
    ports,
    log,
    errors,
    emit: (d, epoch = 1) => chunkCb?.({ epoch, d }),
    resolveAttach: (snapshot, epoch = 1) => resolve(snapshot === null ? null : { epoch, snapshot }),
    /** resolve `pty:attach` with something the declared type says cannot happen
     *  — #346 declined to widen the preload by `| IpcRefusal`, so a refusal is
     *  exactly that (see the #650 case below) */
    resolveAttachRaw: (value: unknown) =>
      resolve(value as { epoch: number; snapshot: string } | null),
    rejectAttach: (e) => reject(e),
    subscribed: () => attached,
    readyCount: () => ready,
    throwFrom: (part, needle) => {
      throwing = { part, needle };
    },
    stopThrowing: () => {
      throwing = null;
    },
  };
}

const writes = (log: string[]): string[] => log.filter((l) => l.startsWith('write:'));

describe('attachTerminalFeed', () => {
  it('subscribes BEFORE invoking attach', () => {
    const h = harness();
    attachTerminalFeed(h.ports);
    // the whole point: main must never emit into a channel with no listener
    expect(h.log).toEqual(['subscribe', 'attach']);
  });

  it('replays a chunk that arrives during the round trip AFTER the snapshot', async () => {
    const h = harness();
    const feed = attachTerminalFeed(h.ports);

    // main streamed this the instant after it took the snapshot, while the
    // invoke was still crossing the bridge
    h.emit('gap');
    expect(h.log).not.toContain('write:gap'); // held, not written early

    h.resolveAttach('SNAP');
    await feed.ready;

    expect(h.log).toEqual(['subscribe', 'attach', 'reset', 'write:SNAP', 'write:gap', 'ready']);
  });

  it('keeps multiple gap chunks in arrival order and writes each once', async () => {
    const h = harness();
    const feed = attachTerminalFeed(h.ports);

    h.emit('a');
    h.emit('b');
    h.emit('c');
    h.resolveAttach('SNAP');
    await feed.ready;

    expect(writes(h.log)).toEqual(['write:SNAP', 'write:a', 'write:b', 'write:c']);
  });

  it('buffers a chunk that lands between the resolve and the replay', async () => {
    const h = harness();
    const feed = attachTerminalFeed(h.ports);

    h.resolveAttach('SNAP'); // resolved, but the .then has not run yet
    h.emit('late');
    await feed.ready;

    // the buffer must be read at FLUSH time, not at resolve time
    expect(writes(h.log)).toEqual(['write:SNAP', 'write:late']);
  });

  it('writes live chunks straight through, with no re-flush of the buffer', async () => {
    const h = harness();
    const feed = attachTerminalFeed(h.ports);

    h.emit('gap');
    h.resolveAttach('SNAP');
    await feed.ready;

    h.emit('live-1');
    h.emit('live-2');

    expect(writes(h.log)).toEqual(['write:SNAP', 'write:gap', 'write:live-1', 'write:live-2']);
  });

  // ---- epochs: a chunk from a PREVIOUS attach is already in our snapshot ----

  it('drops a buffered chunk from an earlier epoch — it is already in the snapshot', async () => {
    const h = harness();
    const feed = attachTerminalFeed(h.ports);

    // queued by main for the previous attach, dispatched after this one
    // subscribed. It reached main's ring buffer before our snapshot was taken,
    // so replaying it would DUPLICATE output.
    h.emit('stale', 7);
    h.emit('mine', 8);
    h.resolveAttach('SNAP', 8);
    await feed.ready;

    expect(writes(h.log)).toEqual(['write:SNAP', 'write:mine']);
  });

  it('drops a live straggler from an earlier epoch', async () => {
    const h = harness();
    const feed = attachTerminalFeed(h.ports);
    h.resolveAttach('SNAP', 8);
    await feed.ready;

    h.emit('stale', 7);
    h.emit('mine', 8);

    expect(writes(h.log)).toEqual(['write:SNAP', 'write:mine']);
  });

  it('a null attachment resets, drops everything buffered, and goes live', async () => {
    const h = harness();
    const feed = attachTerminalFeed(h.ports);

    h.emit('orphan', 3); // no live PTY means no chunk can be ours
    h.resolveAttach(null);
    await feed.ready;

    // no "write:null" — a missing snapshot is not content
    expect(h.log).toEqual(['subscribe', 'attach', 'reset', 'ready']);
  });

  it('a BROKER refusal is treated exactly as "no live PTY" (#650)', async () => {
    // `attach` is an injected closure, so `scripts/refusal-truthiness.js` cannot
    // see that it calls `pty:attach` — this is the whole net for that site.
    //
    // The fix here is BEHAVIOUR-IDENTICAL today (a refusal has neither `epoch`
    // nor `snapshot`, so `?.` already lands it on this path), and that is the
    // reason to pin it rather than a reason not to: the day someone reads
    // `attachment.epoch` without the `?.`, or adds a field to `IpcRefusal` that
    // collides, this is what says which path a refusal is supposed to take.
    // The failure it guards is the one the module's own comment names — an
    // `epoch` left null while the feed goes live drops every later chunk,
    // silently and for good, which is #117 through the path written to avoid it.
    const h = harness();
    const feed = attachTerminalFeed(h.ports);

    h.emit('orphan', 3); // buffered while the (refused) invoke is in flight
    h.resolveAttachRaw(ipcRefusal('pty:attach', 'capability-not-held'));
    await feed.ready;

    // no snapshot written, nothing replayed, and live — the null-attachment path
    expect(h.log).toEqual(['subscribe', 'attach', 'reset', 'ready']);
    // …and the brand never reached the terminal as content
    expect(writes(h.log)).toEqual([]);
  });

  // ---- teardown ----

  it('off() during the round trip unsubscribes, detaches, and writes nothing', async () => {
    const h = harness();
    const feed = attachTerminalFeed(h.ports);

    h.emit('gap');
    feed.off();
    expect(h.subscribed()).toBe(false);

    // the invoke still lands — the pane is gone, so nothing may touch it
    h.resolveAttach('SNAP');
    await feed.ready;

    expect(h.log).toEqual(['subscribe', 'attach', 'unsubscribe', 'detach']);
    expect(h.readyCount()).toBe(0);
  });

  it('a chunk dispatched to an already-removed listener is ignored', async () => {
    const h = harness();
    const feed = attachTerminalFeed(h.ports);
    h.resolveAttach('SNAP');
    await feed.ready;

    feed.off();
    h.emit('after-off'); // EventEmitter dispatches to a listener removed mid-emit

    expect(writes(h.log)).toEqual(['write:SNAP']);
  });

  it('off() is idempotent', async () => {
    const h = harness();
    const feed = attachTerminalFeed(h.ports);
    h.resolveAttach(null);
    await feed.ready;

    feed.off();
    feed.off();

    expect(h.log.filter((l) => l === 'unsubscribe')).toHaveLength(1);
    expect(h.log.filter((l) => l === 'detach')).toHaveLength(1);
  });

  // ---- fail open ----

  it('fails open when the attach invoke rejects', async () => {
    const h = harness();
    const feed = attachTerminalFeed(h.ports);

    h.rejectAttach(new Error('no such channel'));
    await expect(feed.ready).resolves.toBeUndefined(); // never rejects

    expect(h.subscribed()).toBe(false);
    expect(h.errors).toHaveLength(1);
    expect(h.log).not.toContain('reset');
  });

  it('fails open — and never throws — when attach() throws synchronously', () => {
    const h = harness({ attachThrows: true });

    // must not escape into the caller's effect: the caller would never receive a
    // feed, so it could never unsubscribe the listener we just registered
    expect(() => attachTerminalFeed(h.ports)).not.toThrow();
    expect(h.subscribed()).toBe(false);
    expect(h.errors).toHaveLength(1);
  });

  it('survives a subscribe() that throws, and still replays the snapshot', async () => {
    const h = harness({ subscribeThrows: true });
    const feed = attachTerminalFeed(h.ports);

    h.resolveAttach('SNAP');
    await feed.ready;

    // no live stream, but history still lands — better than a blank pane
    expect(h.errors).toHaveLength(1);
    expect(writes(h.log)).toEqual(['write:SNAP']);
  });

  it('a replay failure keeps the feed live rather than leaving a dead pane', async () => {
    const h = harness();
    const feed = attachTerminalFeed(h.ports);
    h.throwFrom('write', 'SNAP');

    h.resolveAttach('SNAP');
    await expect(feed.ready).resolves.toBeUndefined();

    expect(h.errors).toHaveLength(1);
    expect(h.subscribed()).toBe(true); // still attached
    h.stopThrowing();
    h.emit('next-redraw');
    expect(writes(h.log)).toEqual(['write:next-redraw']); // self-heals
  });

  it('a throw from onReady cannot stop the stream', async () => {
    const h = harness();
    const feed = attachTerminalFeed(h.ports);
    h.throwFrom('onReady');

    h.resolveAttach('SNAP');
    await feed.ready;
    h.stopThrowing();
    h.emit('live');

    // fitting is cosmetic; it must not poison the data path
    expect(h.errors).toHaveLength(1);
    expect(h.subscribed()).toBe(true);
    expect(writes(h.log)).toEqual(['write:SNAP', 'write:live']);
  });

  it('a live write failure is reported once, not per chunk', async () => {
    const h = harness();
    const feed = attachTerminalFeed(h.ports);
    h.resolveAttach('SNAP');
    await feed.ready;

    h.throwFrom('write');
    h.emit('a');
    h.emit('b');
    h.emit('c');

    expect(h.errors).toHaveLength(1);
    expect(h.subscribed()).toBe(true);
  });

  it('a reset() failure does not leave the feed epoch-blind', async () => {
    const h = harness();
    const feed = attachTerminalFeed(h.ports);
    h.throwFrom('reset');

    h.resolveAttach('SNAP', 8);
    await feed.ready;
    h.stopThrowing();
    h.emit('after', 8);

    // the epoch must be recorded BEFORE anything that can throw, or every later
    // chunk fails the epoch test and is dropped for good — #117's own failure
    // mode, reached through the path that is supposed to survive
    expect(h.errors).toHaveLength(1);
    expect(writes(h.log)).toEqual(['write:after']);
  });

  it('adopts a newer epoch instead of going deaf', async () => {
    const h = harness();
    const feed = attachTerminalFeed(h.ports);
    h.resolveAttach('SNAP', 8);
    await feed.ready;

    // something attached after us; main streams under the new epoch now. Those
    // bytes are genuinely new, so they must land.
    h.emit('newer', 9);
    h.emit('newer-still', 9);

    expect(writes(h.log)).toEqual(['write:SNAP', 'write:newer', 'write:newer-still']);
  });

  it('detaches even when the unsubscribe throws', async () => {
    const h = harness({ unsubscribeThrows: true });
    const feed = attachTerminalFeed(h.ports);
    h.resolveAttach('SNAP');
    await feed.ready;

    expect(() => feed.off()).not.toThrow();
    // main must still be told to stop streaming — otherwise it feeds a channel
    // with no listener for the rest of the session
    expect(h.log).toContain('detach');
  });

  it('survives an onError that throws', async () => {
    const h = harness({ onErrorThrows: true });
    const feed = attachTerminalFeed(h.ports);

    h.rejectAttach(new Error('boom'));
    // `ready` promises never to reject; a broken reporter must not break that
    await expect(feed.ready).resolves.toBeUndefined();
    expect(h.errors).toHaveLength(1);
  });

  it('says nothing when the attach rejects after the caller closed the feed', async () => {
    const h = harness();
    const feed = attachTerminalFeed(h.ports);

    feed.off();
    h.rejectAttach(new Error('channel closed'));
    await feed.ready;

    // expected at quit/unmount — not a problem the pane can act on
    expect(h.errors).toHaveLength(0);
  });

  it('does not require the optional ports', async () => {
    const off = vi.fn();
    const feed = attachTerminalFeed({
      subscribe: () => off,
      attach: () => Promise.resolve({ epoch: 1, snapshot: 'x' }),
      reset: () => {},
      write: () => {},
    });
    await expect(feed.ready).resolves.toBeUndefined();
    feed.off();
    expect(off).toHaveBeenCalledOnce();
  });
});
