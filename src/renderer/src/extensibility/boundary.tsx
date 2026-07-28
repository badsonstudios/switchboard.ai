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
import React from 'react';

interface Props {
  /** contribution id, for the log line */
  id: string;
  children: React.ReactNode;
}

export class ContributionBoundary extends React.Component<Props, { failed: boolean }> {
  constructor(props: Props) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: Error): void {
    console.error(`[contributions] "${this.props.id}" threw while rendering`, error);
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
