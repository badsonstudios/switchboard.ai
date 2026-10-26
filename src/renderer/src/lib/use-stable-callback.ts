// One function identity for the life of a component, always calling the LATEST
// function it was given (#716).
//
// WHY IT EXISTS: `Composer` is memoised so that a streamed chunk — which
// re-renders the whole `FeedView` it sits in, many times a second, in every
// busy card at once — does not re-render the prompt box with it. A memo
// compares props by identity, and the card hands its callbacks down as fresh
// arrow functions on every render of its own, so without this one changed
// function would defeat the memo for every prop that did not change.
//
// ABSENCE IS KEPT. A callback the parent did not give stays `undefined`, not a
// stable function that would call nothing: the composer reads "is there an
// `onSwitchAi`" as "is there an AI switch to draw", and a wrapper that always
// existed would draw a control that does nothing.
//
// THE LATEST IS INSTALLED IN A LAYOUT EFFECT, i.e. at commit, which is the
// earliest moment any event handler can run against the new tree. Two places
// would get the PREVIOUS function and must not call the result: render, and a
// CHILD's layout effect (children's run before the parent's). The composer does
// neither — every one of these is a click or keyboard handler.
//
// A handler kept from before the function was TAKEN AWAY calls nothing and
// returns `undefined`, whatever the declared return type says. Unreachable in
// the composer (each control is drawn only while its callback exists), and
// better than calling a function the parent has withdrawn.
import React from 'react';

export function useStableCallback<A extends unknown[], R>(
  fn: ((...args: A) => R) | undefined
): ((...args: A) => R) | undefined {
  const latest = React.useRef(fn);
  React.useLayoutEffect(() => {
    latest.current = fn;
  });
  const stable = React.useCallback((...args: A): R => {
    const current = latest.current;
    // Unreachable while `fn` is defined, which is the only time `stable` is
    // handed out; a cleared callback must not throw from a stale handler.
    if (!current) return undefined as R;
    return current(...args);
  }, []);
  return fn ? stable : undefined;
}
