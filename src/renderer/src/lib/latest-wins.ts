// Ordering guard for "fetch a snapshot over IPC, then apply it" refreshes
// (#251).
//
// The renderer keeps several lists — sessions, groups — as whole snapshots
// re-read from the main process whenever something might have changed. Each
// refresh is an async round-trip, and several independent triggers can start
// one: for sessions alone, `onStatus`, `onExited`, `onCardsChanged` and the
// effect body itself. Nothing sequences them, so two calls are routinely in
// flight at once — and `await` gives NO ordering guarantee about which of them
// resolves first.
//
// When the older one resolves last, its stale snapshot is written over the
// newer one. That is not a cosmetic blip: the swallowed value can be a
// TERMINAL status (`needs-permission` — the session has stopped and is waiting
// for a human), after which no further event arrives to trigger another
// refresh. The rail and the urgency strip then show the wrong status forever,
// while the card's own pill — which applies the pushed value directly, with no
// round-trip — shows the right one. Measured on a targeted repro: ~1 failure
// in 12 without this guard, 24/24 (and a further 24/24 under load) with it.
// Full forensics are on issue #251.
//
// This is a RELATED but different rule to the one the events list already has
// (`App.tsx`, "pushes always win", review P1 #15). That one is push-vs-pull: a
// value delivered by an event beats a list() answer still in flight. This one
// is pull-vs-pull: a newer snapshot beats an older one. The events list cannot
// simply adopt `latestWins` — it would lose the push half — so the two guards
// stay separate.
//
// THE RULE: a snapshot may only be applied if no NEWER snapshot has already
// been applied. Comparing against what has LANDED — rather than against the
// most recently issued request — is deliberate: it keeps the guard purely
// about ordering. A response that is the freshest thing anyone has is applied
// even while a later request is still in flight, so a request that hangs or
// rejects can never strand the UI on old data.
//
// WHAT THIS INHERITS FROM THE MAIN PROCESS: "issued later" only means "fresher"
// because the handlers on the other end read their snapshot SYNCHRONOUSLY, in
// the tick the invoke arrives. `sessions:cards` (src/main/sessions/ipc.ts)
// reads `manager.list()`, `deps.persist.list()` and each `rec.status` before
// its only `await`, so handler-start order — which is invoke order, which is
// the order counted here — is also snapshot order. Move a resolution step
// above that status read and this guard quietly degrades to a coin flip with
// every test still green, which is why the constraint is written down at both
// ends.
//
// Pure by construction: no React, no DOM, no timers. Every rule below is a
// unit test rather than an e2e guess.

/** A refresh whose response can never overwrite a newer one. */
export type GuardedRefresh = () => Promise<void>;

/** What a fetch may hand back: a snapshot, or nothing at all. */
type Fetched<T> = PromiseLike<T | null | undefined> | T | null | undefined;

/**
 * Wrap a snapshot fetch so out-of-order responses are dropped.
 *
 * `fetch` is called on every invocation; `apply` is called only if the value it
 * resolved to is still the newest anyone has seen. Nullish means "no snapshot"
 * — an absent bridge method reached through optional chaining, or an empty
 * answer over IPC — and is never applied. Critically it also never COUNTS as a
 * snapshot, so it cannot retire a real one that is still in flight.
 *
 * A rejected `fetch` rejects the returned promise; it is deliberately the
 * caller's to handle (or, as the refreshes in `App` do under the fail-open
 * principle, to ignore). Like a nullish answer it leaves the counters alone,
 * so a failed round-trip never blocks the next one from landing.
 *
 * Each call to `latestWins` owns its own counters, so two lists guarded this
 * way never interfere with each other.
 */
export function latestWins<T>(fetch: () => Fetched<T>, apply: (value: T) => void): GuardedRefresh {
  let issued = 0;
  let applied = 0;

  return async (): Promise<void> => {
    const seq = ++issued;
    const value = await fetch();
    if (value === undefined || value === null) return; // nothing came back — not a snapshot
    if (seq <= applied) return; // a newer snapshot already landed; this one is stale
    // Marked applied BEFORE the apply, not after: `apply` writes to a store
    // that notifies subscribers synchronously, and a subscriber that triggers
    // another refresh must not find the counter still describing the world as
    // it was before this snapshot landed.
    applied = seq;
    apply(value);
  };
}
