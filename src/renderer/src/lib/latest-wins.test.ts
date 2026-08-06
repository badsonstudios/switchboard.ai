// The ordering guard behind #251.
//
// Every test here drives resolution order EXPLICITLY (deferred promises the
// test resolves by hand) rather than racing timers — the bug being guarded
// against is exactly a schedule you cannot reproduce on demand, so the tests
// reproduce it by construction and are deterministic.
import { describe, it, expect, vi } from 'vitest';
import { GuardedRefresh, latestWins } from './latest-wins';

/** A promise the test resolves when it wants to, not when a timer says so. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let every already-resolved microtask run. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('latestWins', () => {
  it('applies a snapshot when nothing else is in flight', async () => {
    const apply = vi.fn();
    const refresh = latestWins(async () => 'a', apply);

    await refresh();

    expect(apply).toHaveBeenCalledExactlyOnceWith('a');
  });

  // THE BUG. Two refreshes in flight, the OLDER one resolving last: without the
  // guard the stale snapshot is written over the fresh one and the UI is stuck
  // on it until some unrelated event triggers another refresh — which, for a
  // terminal status like `needs-permission`, never comes.
  it('drops an older response that resolves after a newer one', async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const responses = [first.promise, second.promise];
    const apply = vi.fn();
    const refresh = latestWins(() => responses.shift(), apply);

    void refresh(); // stale, issued first
    void refresh(); // fresh, issued second

    second.resolve('needs-permission'); // …but answers first
    await settle();
    expect(apply).toHaveBeenCalledExactlyOnceWith('needs-permission');

    first.resolve('starting'); // the stale snapshot lands last
    await settle();

    expect(apply).toHaveBeenCalledExactlyOnceWith('needs-permission');
    expect(apply).not.toHaveBeenCalledWith('starting');
  });

  it('applies responses that resolve in order', async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const responses = [first.promise, second.promise];
    const apply = vi.fn();
    const refresh = latestWins(() => responses.shift(), apply);

    void refresh();
    void refresh();

    first.resolve('working');
    await settle();
    second.resolve('needs-permission');
    await settle();

    expect(apply.mock.calls.map((c) => c[0])).toEqual(['working', 'needs-permission']);
  });

  // Three deep, resolving fully backwards: only the newest may land, and the
  // two older ones must not "recover" the list afterwards.
  it('keeps the newest of three responses that all resolve out of order', async () => {
    const d = [deferred<number>(), deferred<number>(), deferred<number>()];
    const responses = d.map((x) => x.promise);
    const apply = vi.fn();
    const refresh = latestWins(() => responses.shift(), apply);

    void refresh();
    void refresh();
    void refresh();

    d[2].resolve(3);
    await settle();
    d[1].resolve(2);
    await settle();
    d[0].resolve(1);
    await settle();

    expect(apply).toHaveBeenCalledExactlyOnceWith(3);
  });

  // The guard is about ORDERING, not about "is a newer request outstanding".
  // A response that is the freshest thing anyone has must be applied even while
  // a later request is still in flight — otherwise a request that hangs (or
  // rejects) strands the UI on data it already knows is old.
  it('applies a response even while a later request is still in flight', async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const responses = [first.promise, second.promise];
    const apply = vi.fn();
    const refresh = latestWins(() => responses.shift(), apply);

    void refresh();
    void refresh(); // never resolves

    first.resolve('needs-permission');
    await settle();

    expect(apply).toHaveBeenCalledExactlyOnceWith('needs-permission');
  });

  it('lets a fresh response land after a stale one was dropped', async () => {
    const d = [deferred<number>(), deferred<number>(), deferred<number>()];
    const responses = d.map((x) => x.promise);
    const apply = vi.fn();
    const refresh = latestWins(() => responses.shift(), apply);

    void refresh();
    void refresh();
    d[1].resolve(2);
    await settle();
    d[0].resolve(1); // dropped
    await settle();

    void refresh();
    d[2].resolve(3);
    await settle();

    expect(apply.mock.calls.map((c) => c[0])).toEqual([2, 3]);
  });

  // `undefined` is what an absent bridge method yields through optional
  // chaining. It is not a snapshot: it must not be applied, and — critically —
  // it must not retire a real snapshot that is still in flight.
  it('never applies undefined and never lets it retire a real snapshot', async () => {
    const real = deferred<string>();
    const responses: (Promise<string> | undefined)[] = [real.promise, undefined];
    const apply = vi.fn();
    const refresh = latestWins(() => responses.shift(), apply);

    void refresh(); // the real one, still in flight
    await refresh(); // an empty answer, issued later, resolves first
    expect(apply).not.toHaveBeenCalled();

    real.resolve('needs-permission');
    await settle();

    expect(apply).toHaveBeenCalledExactlyOnceWith('needs-permission');
  });

  // `null` is what an empty answer over IPC looks like. The pre-guard code
  // skipped it with a falsy check; nothing may have started applying it.
  it('treats null the same as undefined', async () => {
    const apply = vi.fn();
    const refresh = latestWins<string[]>(async () => null, apply);

    await refresh();

    expect(apply).not.toHaveBeenCalled();
  });

  // `apply` writes to a store whose subscribers run synchronously, and one of
  // them may kick off another refresh. That re-entrant call must see counters
  // that already account for the snapshot being applied around it.
  it('survives a refresh triggered from inside apply', async () => {
    const seen: number[] = [];
    let n = 0;
    let reentered = false;
    const refresh: GuardedRefresh = latestWins(
      async () => ++n,
      (v) => {
        seen.push(v);
        if (!reentered) {
          reentered = true;
          void refresh();
        }
      }
    );

    await refresh();
    await settle();

    expect(seen).toEqual([1, 2]);
  });

  it('does not let a rejected fetch retire a later snapshot', async () => {
    const bad = deferred<string>();
    const good = deferred<string>();
    const responses = [bad.promise, good.promise];
    const apply = vi.fn();
    const refresh = latestWins(() => responses.shift(), apply);

    const failing = refresh();
    void refresh();

    bad.reject(new Error('bridge gone'));
    await expect(failing).rejects.toThrow('bridge gone');

    good.resolve('needs-permission');
    await settle();

    expect(apply).toHaveBeenCalledExactlyOnceWith('needs-permission');
  });

  // Two lists guarded this way (sessions and groups) must not share counters.
  it('gives each guarded refresh its own ordering', async () => {
    const applyA = vi.fn();
    const applyB = vi.fn();
    const a = latestWins(async () => 'a', applyA);
    const b = latestWins(async () => 'b', applyB);

    await a();
    await b();
    await a();

    expect(applyA).toHaveBeenCalledTimes(2);
    expect(applyB).toHaveBeenCalledTimes(1);
  });

  it('calls fetch once per invocation', async () => {
    const fetch = vi.fn(async () => 1);
    const refresh = latestWins(fetch, vi.fn());

    await refresh();
    await refresh();

    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
