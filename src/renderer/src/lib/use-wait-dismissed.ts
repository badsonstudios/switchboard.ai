// Re-render when a "waiting" is dismissed or re-armed (#1413).
//
// For a surface that COUNTS waiting sessions rather than painting one: a
// group's roll-up asks `sessionStore.isWaitDismissed` per member while it
// renders, and this is what makes it render again when the answer changes.
// One session's own surfaces read it through `useShownStatus` instead.
import React from 'react';
import { sessionStore, type WaitDismissal } from '../store/session-store';

const subscribe = (cb: () => void): (() => void) => sessionStore.subscribe(cb);
const read = (): ReadonlyMap<string, WaitDismissal> => sessionStore.getState().waitDismissed;
const isDismissed = (id: string): boolean => sessionStore.isWaitDismissed(id);

/** The predicate to hand `waitRollup`, kept current. */
export function useWaitDismissed(): (id: string) => boolean {
  React.useSyncExternalStore(subscribe, read);
  return isDismissed;
}
