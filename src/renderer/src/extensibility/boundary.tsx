// A crash barrier around one contribution's output (§5.23 + the fail-open rule).
//
// Contributed renderers run inside a parent's render, and the renderer has no
// error boundary anywhere — so an exception in any of them white-screens the
// whole window, taking every session's terminal with it. That is precisely the
// "our breakage blocks a session" outcome the hard constraints forbid, and it
// matters more now than it did as hardcoded components: the seam's whole
// premise is that the set of contributors grows.
//
// One contribution failing costs that contribution, and nothing else.
//
// AND IT COMES BACK (#463). Until this issue the boundary latched: the first
// throw killed that surface for the life of the window, for every consumer —
// which is the mild version of the same forbidden outcome, since a transient
// failure (one malformed frame, one unlucky read) cost the user a status-bar
// item, a panel or a viewer until they restarted the app. The policy is now
// BOUNDED AUTOMATIC RETRY, and the two halves are equally load-bearing:
//
//   - **Automatic**, on the next render that brings something new. No "try
//     again" button: §5.23's convention for this boundary is that a broken
//     contribution leaves a GAP and does not shout at the user about an
//     internal fault they cannot act on, and a button would be exactly that
//     shout, on the status bar, in every consumer at once. Recovery is the
//     user doing anything that re-renders the surface, which is most things.
//   - **Bounded**, at `CONTRIBUTION_RETRY_LIMIT` consecutive failures. The
//     classic error-boundary trap is resetting on every render: a contribution
//     that ALWAYS throws then throws once per parent render forever — a
//     deterministic bug turned into an unbounded stream of exceptions, and on
//     a feed re-rendering per streamed chunk that is a spin. After the limit
//     the boundary latches for good and says so once, in the log.
//
// The streak is CONSECUTIVE, not lifetime: a render that survives clears it.
// A lifetime budget would mean a status-bar item that hiccups three times over
// a long session is dead for the rest of it — the latching bug again, just
// slower. Clearing on success cannot spin, because a contribution that
// alternates working and throwing IS working half the time, and each retry
// still costs one render, driven by the parent rather than by us.
import React from 'react';

/**
 * How many times in a row a contribution may throw before this boundary stops
 * offering it renders. Small on purpose: three failures with nothing changing
 * in between is a bug, not a hiccup, and the recovery from a latched boundary
 * is the one it always was — rebuild the surface (close and reopen the tab,
 * or restart).
 */
export const CONTRIBUTION_RETRY_LIMIT = 3;

interface Props {
  /** contribution id, for the log line */
  id: string;
  children: React.ReactNode;
}

export class ContributionBoundary extends React.Component<Props, { failed: boolean }> {
  /**
   * Consecutive failures. An instance field and NOT state: it is read to decide
   * whether to schedule a render, so making it state would mean writing it
   * could schedule one — and the one thing a crash barrier must never do is
   * generate renders of its own.
   */
  private failures = 0;

  constructor(props: Props) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: Error): void {
    this.failures += 1;
    // The log line NAMES THE CONTRIBUTION (the existing pattern) and now also
    // says what happens next, because "it threw" and "it threw and will never
    // be tried again" are different bug reports.
    if (this.failures >= CONTRIBUTION_RETRY_LIMIT) {
      console.error(
        `[contributions] "${this.props.id}" threw while rendering ${this.failures} times in a row — giving up on it until this surface is rebuilt`,
        error
      );
    } else {
      console.error(
        `[contributions] "${this.props.id}" threw while rendering (${this.failures} of ${CONTRIBUTION_RETRY_LIMIT}) — it will be tried again on its next update`,
        error
      );
    }
  }

  componentDidUpdate(prev: Props): void {
    // A different contribution in the same slot is a fresh start, not the
    // continuation of someone else's streak.
    if (prev.id !== this.props.id) this.failures = 0;
    if (!this.state.failed) {
      // A render that survived. The streak is over — see the header on why
      // this is consecutive and not lifetime.
      this.failures = 0;
      return;
    }
    if (this.failures >= CONTRIBUTION_RETRY_LIMIT) return; // latched, deliberately
    // ONLY a render that brought something new is worth retrying, and this is
    // what keeps an always-throwing contribution from spinning: the re-render
    // React does to show the fallback carries the SAME `children` element that
    // just threw, so it is not a new attempt and does not become one.
    if (prev.children === this.props.children) return;
    this.setState({ failed: false });
  }

  render(): React.ReactNode {
    // deliberately renders NOTHING rather than an error placeholder: a broken
    // status-bar item or block should leave a gap, not shout at the user about
    // an internal fault they cannot act on
    return this.state.failed ? null : this.props.children;
  }
}

/** Call a contribution's predicate; a throw counts as "no", never as a crash. */
export function safely<T>(id: string, what: string, fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch (err) {
    console.error(`[contributions] "${id}" threw in ${what}`, err);
    return fallback;
  }
}
