// The window's side of `send_to_session` (P2-E11-05, §5.4).
//
// Four channels, and the split between them is the delivery policy made
// visible:
//
//   sessions:siblingMessage          OUT  hold this message in a card's composer
//   sessions:siblingMessageAck       IN   …here is what became of it
//   sessions:acceptFromSiblings      IN   read a card's auto-accept flag
//   sessions:setAcceptFromSiblings   IN   switch it
//
// Nothing on this list lets the window SEND a sibling's message. It sends one
// the ordinary way — `sessions:submitPrompt`, when the user presses Enter on
// it — and the automatic path never involves the window at all.
//
// Same read/write-answering-the-truth shape as `rules-ipc.ts` and
// `sound-ipc.ts`, for the same reason: a refused write leaves the menu showing
// what the store holds, not what the user just clicked.
import type { BrowserWindow } from 'electron';
import { IpcBroker } from '../ipc/broker';
import { LogFields, Logger } from '../log/logger';
import type { SiblingMessage } from '../../shared/sibling-message';
import type { SiblingDelivery } from './delivery';

export interface DeliveryIpcDeps {
  broker: IpcBroker;
  log: Logger;
  store: {
    cardAcceptsSiblings(cardId: string): boolean;
    setCardAcceptsSiblings(cardId: string, on: boolean): boolean;
  };
  knownCard: (cardId: string) => boolean;
  delivery: Pick<SiblingDelivery, 'ack'>;
}

export function registerDeliveryIpc(deps: DeliveryIpcDeps): void {
  const { broker, log, store } = deps;

  const refuse = (channel: string, reason: string, fields: LogFields = {}): false => {
    log.warn(`${channel} refused: ${reason}`, fields);
    return false;
  };

  broker.handle('sessions:acceptFromSiblings', (_e, cardId: unknown): boolean => {
    if (typeof cardId !== 'string') return refuse('sessions:acceptFromSiblings', 'cardId must be a string');
    return store.cardAcceptsSiblings(cardId);
  });

  broker.handle('sessions:setAcceptFromSiblings', (_e, cardId: unknown, on: unknown): boolean => {
    if (typeof cardId !== 'string') return refuse('sessions:setAcceptFromSiblings', 'cardId must be a string');
    // §5.29: renderer input is untrusted, and this is the flag that removes a
    // human from the loop — so "truthy" is not good enough. Only a real
    // boolean moves it.
    if (typeof on !== 'boolean') {
      return refuse('sessions:setAcceptFromSiblings', 'the value must be true or false', { cardId });
    }
    if (!deps.knownCard(cardId)) return refuse('sessions:setAcceptFromSiblings', 'unknown card', { cardId });
    const now = store.setCardAcceptsSiblings(cardId, on);
    // At INFO, both directions: "why did that session act on a message nobody
    // approved" is exactly the question this line answers after the fact.
    log.info('accept-from-siblings changed', { cardId, on: now });
    return now;
  });

  broker.handle('sessions:siblingMessageAck', (_e, deliveryId: unknown, ack: unknown): boolean =>
    deps.delivery.ack(deliveryId, ack)
  );
}

/**
 * Push one message to the window. FALSE when there is no window to push to —
 * which `SiblingDelivery` turns into an explicit refusal, never a silent drop.
 *
 * The MAIN window only, and that is enough: popouts load without a preload and
 * render in the opener's JS realm (`composer-attachment-draft.ts` has the
 * detail), so a popped-out composer is held by the same inbox as a docked one.
 */
export function pushSiblingMessage(
  broker: IpcBroker,
  win: BrowserWindow | null,
  message: SiblingMessage
): boolean {
  try {
    // A CRASHED renderer is not a window: the push would vanish and the send
    // would wait out its whole deadline to report "not confirmed" about a
    // message that provably went nowhere. Same test the audio sink uses.
    if (!win || win.isDestroyed() || win.webContents.isDestroyed() || win.webContents.isCrashed()) {
      return false;
    }
  } catch {
    return false; // a window that throws when asked whether it is dead is dead
  }
  broker.send(win, 'sessions:siblingMessage', message);
  return true;
}
