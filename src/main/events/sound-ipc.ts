// Per-session sound IPC (P2-E14-05a, §5.9 + §5.11).
//
// Two channels, the same shape as `rules-ipc.ts`: a read, and a write that
// answers with the state the store now holds — so a refused write leaves the
// menu showing the truth rather than the thing the user just clicked.
//
// Nothing here plays anything. The renderer previews a cue by synthesizing it
// locally from the shared bank; main is only ever asked which cue a card owns.
import { IpcBroker } from '../ipc/broker';
import { LogFields, Logger } from '../log/logger';
import { WorkspaceStore } from '../workspace/store';
import { CardSound, isSoundId } from '../../shared/sounds';

export interface SoundIpcDeps {
  broker: IpcBroker;
  log: Logger;
  store: WorkspaceStore;
  /** a rule, a cue, or anything else scoped to a card that is not in the
   *  workspace is a write we cannot explain later — refuse it here */
  knownCard: (cardId: string) => boolean;
}

export function registerSoundIpc(deps: SoundIpcDeps): void {
  const { broker, log, store } = deps;

  const refuse = (channel: string, reason: string, fields: LogFields = {}): null => {
    log.warn(`${channel} refused: ${reason}`, fields);
    return null;
  };

  broker.handle('sounds:get', (_e, cardId: string): CardSound | null => {
    if (typeof cardId !== 'string') return refuse('sounds:get', 'cardId must be a string');
    return store.cardSound(cardId);
  });

  broker.handle('sounds:set', (_e, cardId: string, sound: unknown): CardSound | null => {
    if (typeof cardId !== 'string') return refuse('sounds:set', 'cardId must be a string');
    // `null` is a real value here and means "back to auto" — the only way out
    // of a pinned cue, so it must not be lumped in with a bad argument.
    if (sound !== null && !isSoundId(sound))
      return refuse('sounds:set', 'not a sound this build can play', { cardId });
    if (!deps.knownCard(cardId)) return refuse('sounds:set', 'unknown card', { cardId });
    store.setCardSound(cardId, sound as string | null);
    const now = store.cardSound(cardId);
    log.info('session sound changed', { cardId, sound: now.id, pinned: now.pinned });
    return now;
  });
}
