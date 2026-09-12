// The renderer's answer to a message another session sent one of our cards
// (P2-E11-05, #774).
//
// WHY THIS IS A MODULE AND NOT THREE LINES IN `App.tsx`. It joins two halves
// that are each carefully tested on their own and were, until #774's second
// review round, joined by nothing at all:
//
//   * `lib/sibling-inbox.ts` holds the message and knows nothing about cards;
//   * `store/session-store.ts` knows which cards exist and nothing about
//     messages.
//
// The join is where the interesting mistake lives — swapping `mayHoldForCard`
// for the obvious-looking `hasCard` destroys a live session's message and tells
// its sender the target was closed — and a mistake reachable only from inside a
// 2,000-line component is a mistake no test can stand in front of. Here, it is
// one exported function with its own test.
import { receiveSiblingMessage } from './sibling-inbox';
import { sessionStore } from '../store/session-store';
import type { SiblingAck } from '../../../shared/sibling-message';

/**
 * File a pushed message and say what became of it — the body of the
 * `sessions:siblingMessage` listener.
 *
 * `null` means "that was not a message I could read", which main reports as
 * unconfirmed. Nothing here can submit anything; see `sibling-inbox.ts`.
 */
export function holdSiblingMessage(raw: unknown): SiblingAck | null {
  // ⚠️ `mayHoldForCard`, NEVER `hasCard`. That method's docstring is the whole
  // argument: "is it in the list?" is not "has it been closed?", and only one
  // of those may refuse a message.
  return receiveSiblingMessage(raw, (cardId) => sessionStore.mayHoldForCard(cardId));
}
