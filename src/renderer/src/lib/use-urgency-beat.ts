// The post-jump highlight's BEAT (§5.8, #320, #426) — when it starts and when it
// ends.
//
// This was the body of the row of lamps. It moved here when the sessions strip
// (#1143) became a second thing a jump could light up, and since #1164 — when
// the lamps were removed from the app — it is called ONCE, by App.
//
// A mark arrives from the jump with no deadline. This code gives it one, two
// frames after the commit that could have painted it, and puts it out when the
// beat has passed. "Could have": App times the beat, a child (a row, a pill, a
// group's box) paints it, and when the list of sessions is hidden nothing
// paints it at all. The beat still starts and still ends then, unseen — on
// purpose. Holding it for the list to come back would show an outline for a
// jump made minutes ago. What IS waited for is a window that is not rendering
// (rAF does not fire there): a mark made while minimised keeps until you look.
//
// EXACTLY ONE caller. Two would each start the same beat and each arm a timer
// for it.
import React from 'react';
import { nextLitExpiry, UrgencyMarks } from './urgency';

export function useUrgencyBeat(
  /** card id -> epoch ms its highlight expires, or null for one not painted yet */
  urgency: UrgencyMarks,
  /** a beat has passed — ask the store to put it out. Must be stable: it is an
   *  effect dependency. */
  onExpire: () => void,
  /** these marks are now ON THE SCREEN — start their beat. Must be stable. */
  onBeatStart: (cardIds: readonly string[]) => void
): void {
  // ONE timer for the whole strip, armed at the soonest deadline: the strip has
  // no other reason to re-render when a beat runs out, and polling a clock for
  // a 1.5s highlight would keep the renderer busy forever.
  //
  // It RE-ARMS ITSELF rather than relying on the state write to re-run this
  // effect. `expireUrgency` skips the write when nothing has actually expired,
  // and setTimeout counts on a monotonic clock while the deadlines are wall
  // clock — so one NTP step backwards during a beat would fire the timer early,
  // prune nothing, publish nothing, and leave a lamp lit with no timer left to
  // put it out. Re-arming closes that: worst case it re-checks every ~20ms
  // until the wall clock catches up.
  React.useEffect(() => {
    let id: ReturnType<typeof setTimeout> | undefined;
    const arm = (): void => {
      const ms = nextLitExpiry(urgency, Date.now());
      if (ms === null) return;
      // +1ms past the deadline: isLit's boundary is strict, so firing ON it
      // would prune nothing. The 20ms floor only applies to a re-arm (a first
      // arm is a whole beat away) and keeps the skew case off a 1ms spin.
      id = setTimeout(() => {
        onExpire();
        // reads the SAME (now stale) map — that is what makes this a retry. A
        // successful prune re-runs the effect, whose cleanup kills this chain.
        arm();
      }, Math.max(ms, 20) + 1);
    };
    arm();
    return () => clearTimeout(id);
  }, [urgency, onExpire]);

  // ── the paint anchor (#320, Dan 2026-08-10) ────────────────────────────────
  //
  // A mark arrives from the jump WITHOUT a deadline (`null`); the beat starts
  // here, once the lit lamp is actually on the screen. Before this, the 1.5s
  // was measured from the keypress, so a machine busy enough to take longer
  // than that between the keydown and the paint drew no lit lamp at all — and
  // §5.8 asks for the beat so a HUMAN can see which session called them, which
  // makes "the pixels existed" the only start that means anything.
  //
  // WHY rAF, and why TWO of them. `useLayoutEffect` is commit-coupled, not
  // paint-coupled: it runs after the DOM is mutated and BEFORE the browser
  // paints, which is the same too-early moment the keypress was. (A passive
  // `useEffect` is no better as an anchor — it usually runs after paint, but
  // React is free to flush it earlier, so it is a probability, not a promise.)
  // The first rAF callback runs at the start of the next frame, still before
  // that frame's pixels; the SECOND runs a frame later, by which time the frame
  // carrying the lit lamp has been painted. So the second callback is the first
  // moment we can honestly say the user could have seen it.
  //
  // It also gets a backgrounded window right for free: rAF does not fire in a
  // window that is not rendering, so a mark made while minimised waits for the
  // window to come back rather than starting a beat nobody can see.
  //
  // A chain in flight is NEVER restarted, which is why this effect keeps its
  // state in a ref instead of in its cleanup. Cancelling and rescheduling on
  // every dependency change reads tidier and is a starvation bug: a held-down
  // jump key writes a new urgency map about every 33ms (Windows auto-repeat)
  // and two frames is 32ms, so the second rAF would be cancelled just short of
  // firing, every time, for as long as the key was down — every lamp lit and no
  // beat ever started. Letting the chain run to completion instead costs
  // nothing: when it lands, its state write re-runs this effect, and anything
  // that went pending underneath it is scheduled then.
  //
  // (This effect runs BEFORE the timer effect above on every commit — React
  // flushes all layout effects ahead of any passive one — despite reading
  // second.)
  //
  // ── and the landing has to be able to re-run this effect (#426) ────────────
  //
  // Since the pending cap, a mark can be SUPERSEDED while its chain is in the
  // air: `markLit` keeps only the newest unpainted mark, so the ids this effect
  // captured may be gone by the time the second frame arrives. `onBeatStart`
  // then writes nothing — `startBeat` has nothing to start — and without a
  // state write this effect never re-runs, so the mark that replaced them would
  // sit lit with no chain to give it a beat and no timer to end it: a lamp lit
  // forever, in exactly the popout case the cap exists for. `landings` is the
  // nudge. It is bumped ONLY when the map moved under the chain, because when
  // it did not the landing drains everything it captured and the resulting
  // state write re-runs us — bumping there too would be a rAF spin.
  const chain = React.useRef<{ outer: number; inner: number } | null>(null);
  const committed = React.useRef(urgency);
  const [landings, chainLanded] = React.useReducer((n: number) => n + 1, 0);
  React.useLayoutEffect(() => {
    committed.current = urgency;
    if (chain.current) return;
    // Every mark still waiting on a paint, including any whose card has no lamp
    // in this render: the strip HAS painted, and a mark with nothing to draw has
    // nothing to wait for. Skipping those would leave an entry no timer can ever
    // expire, because nextLitExpiry ignores the unpainted.
    const waiting: string[] = [];
    for (const [id, until] of urgency) if (until === null) waiting.push(id);
    if (waiting.length === 0) return;
    // fail-open (§4): no rAF means no paint signal at all, and a lamp lit
    // forever is a worse readout than one whose beat starts a frame early
    if (typeof requestAnimationFrame !== 'function') {
      onBeatStart(waiting);
      return;
    }
    // `waiting` is deliberately the ids as of THIS commit and not re-read when
    // the chain lands: these are the ones the frame below is about to paint. A
    // mark that arrives underneath the chain has not been through a paint yet,
    // so it gets its own chain on the re-run rather than riding this one.
    const ids = { outer: 0, inner: 0 };
    chain.current = ids;
    ids.outer = requestAnimationFrame(() => {
      ids.inner = requestAnimationFrame(() => {
        // cleared FIRST: the call below re-runs this effect, which must be free
        // to schedule the next chain for whatever went pending in the meantime
        chain.current = null;
        onBeatStart(waiting);
        // the map moved under us: some of `waiting` may no longer exist, so the
        // call above may have written nothing. Re-run rather than assume it did.
        // Map IDENTITY is a proxy for "an unpainted mark may be left without a
        // chain" and over-fires — an expiry landing inside the same two frames
        // also trips it — which is the direction to be wrong in: over-firing
        // costs one render of a readout, under-firing costs a lamp lit forever.
        if (committed.current !== urgency) chainLanded();
      });
    });
  }, [urgency, onBeatStart, landings]);

  // Unmount only — the chain above deliberately outlives a re-render, so this
  // is the one place it is right to cancel.
  React.useEffect(() => {
    return () => {
      if (!chain.current) return;
      cancelAnimationFrame(chain.current.outer);
      cancelAnimationFrame(chain.current.inner);
      chain.current = null;
    };
  }, []);
}
