// The missed-events digest's IPC (P2-E14-05c, §5.9) — the READ half of #482's record.
//
// #482 wrote the record and stopped at the count: `notifications:quietState`
// answers "is the window open, and how many have been held", and the list itself
// was left for this item. `WorkspaceStore.clearSuppressed` has been sitting
// there with no caller for the same reason — "it clears on review" is this
// item's done-when, and the surface that reviews it is the drawer.
//
// TWO CHANNELS, AND THIS FILE EXISTS SO THEY CAN BE TESTED. `quietState` is
// registered inline in `index.ts`, which is fine for a three-line reader; a
// clear that takes a caller-supplied id list has input to validate and a refusal
// to get right, and neither should need a booted app to exercise. Same split
// `rules-ipc.ts` made, for the same reason.
//
// ── FAIL-OPEN IS A DONE-WHEN HERE, NOT A COURTESY ──────────────────────────
//
// "Digest breakage never blocks or delays live events" (#483). The digest is a
// READER: nothing on the notification path learns it exists. What this file owes
// that promise is narrower and it is the house shape anyway — a refusal is a
// VALUE back to the caller plus one line in the log, never a throw
// (`workspace/group-ipc.ts`, `rules-ipc.ts`). A renderer asking a malformed
// question gets an honest answer and the event path never sees it.
import { IpcBroker } from '../ipc/broker';
import { LogFields, Logger } from '../log/logger';
import { WorkspaceStore } from '../workspace/store';
import { ClearSuppressedResult, SuppressedEvent } from '../../shared/suppressed';

export interface DigestIpcDeps {
  broker: IpcBroker;
  log: Logger;
  store: WorkspaceStore;
}

export function registerDigestIpc(deps: DigestIpcDeps): void {
  const { broker, log, store } = deps;

  const refuse = (channel: string, reason: string, fields: LogFields = {}): ClearSuppressedResult => {
    log.warn(`${channel} refused: ${reason}`, fields);
    // The list is still returned on a refusal. A renderer that asked badly is
    // still entitled to the truth about what is held, and answering `cleared: 0`
    // with no list would make a refused clear indistinguishable from one that
    // emptied everything.
    return { cleared: 0, remaining: store.listSuppressed() };
  };

  /** The held list, oldest first — the store's own order. */
  broker.handle('notifications:listSuppressed', (): SuppressedEvent[] => store.listSuppressed());

  /**
   * Mark held events reviewed.
   *
   * BY ID, and `ids` is required rather than optional even though the store
   * accepts `undefined` for "all". The store's signature is right for the store;
   * an IPC channel where a missing argument means "delete everything" is one
   * dropped parameter away from clearing a digest nobody read.
   *
   * What the ids buy is that a clear takes exactly the rows it was asked for and
   * cannot take a row it was not — the reason #482 minted ids unique across
   * restarts. It is NOT a promise about the window between a render and a click:
   * the renderer sends what the digest is accounting for at the moment of the
   * click, and the notice's own heading is derived from that same list, so the
   * button and the sentence above it can never disagree about how much is going.
   */
  broker.handle(
    'notifications:clearSuppressed',
    (_e, ids: unknown): ClearSuppressedResult => {
      if (!Array.isArray(ids)) return refuse('notifications:clearSuppressed', 'ids must be an array');
      if (!ids.every((id) => typeof id === 'string' && id))
        return refuse('notifications:clearSuppressed', 'every id must be a non-empty string', {
          count: ids.length,
        });
      const cleared = store.clearSuppressed(ids as string[]);
      // Logged at info because it is a user action that destroys data, and the
      // count is the only trace left of a digest once it is gone.
      log.info('held notifications cleared', { asked: ids.length, cleared });
      return { cleared, remaining: store.listSuppressed() };
    }
  );
}
