// The status a session's surfaces paint, with a held question told apart from
// an approval (#1351). See `shownStatus` in rail-view for why the two share a
// status in main and must not share a word on screen.
import React from 'react';
import { sessionStore } from '../store/session-store';
import { shownStatus } from './rail-view';

const subscribe = (cb: () => void): (() => void) => sessionStore.subscribe(cb);

export function useShownStatus<S extends string | undefined>(
  cardId: string | undefined,
  status: S
): S | 'needs-input' {
  const question = React.useSyncExternalStore(subscribe, () =>
    cardId !== undefined && status === 'needs-permission' ? sessionStore.hasHeldQuestion(cardId) : false
  );
  return shownStatus(status, question);
}
