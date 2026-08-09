// The IPC choke point (P2-E15-04, §5.23 + §5.29, AR-P0-2).
//
// Every channel goes through here, in both directions, and every registration
// must name a channel from CHANNEL_CAPABILITIES — you cannot register an
// untagged channel, because the type of `channel` is the map's key set. That
// is what makes "every channel is tagged" a property of the code rather than a
// rule someone has to remember.
//
// Today the only caller is our own window, granted everything, so nothing is
// refused and behaviour is identical. §5.23's claim that "the main process is
// the sole enforcer" stops being true-by-vacuum and becomes true-in-code.
//
// HOW THIS SEAM SAYS NO (#346). A refused `invoke` RESOLVES with an
// `IpcRefusal` and never rejects — the last place in the app that still
// refused by throwing, after #326 (`groups:*`) and #347 (`sessions:*`). The
// full argument for the shape, and why it is neither bare `null` nor
// `{ok:false}`, is in `shared/ipc/refusal.ts`; the contract a Phase-4 caller
// reads is `docs/extensibility.md` → "How the broker refuses".
import { BrowserWindow, ipcMain, IpcMainInvokeEvent, WebContents } from 'electron';
import { Logger } from '../log/logger';
import {
  Capability,
  capabilityFor,
  Channel,
  CHANNEL_CAPABILITIES,
  StaticChannel,
} from '../../shared/ipc/capabilities';
import { IpcRefusalReason, ipcRefusal } from '../../shared/ipc/refusal';

/** What a caller is allowed to do. */
export interface CallerGrant {
  /** for the log line — 'renderer' today, a plugin id in Phase 4 */
  id: string;
  capabilities: Set<Capability>;
}

export class IpcBroker {
  /** webContents id -> grant. A caller with no grant can do nothing. */
  private readonly grants = new Map<number, CallerGrant>();

  constructor(private readonly log: Logger) {}

  /**
   * Grant a window its capabilities. First-party gets everything — narrowing
   * our OWN renderer is a different argument with real behaviour changes, and
   * this item's contract is explicitly that nothing changes at runtime.
   */
  grant(contents: WebContents, grant: CallerGrant): void {
    if (this.grants.has(contents.id)) {
      // re-granting would stack a second 'destroyed' listener; can't happen
      // today, and this is cheaper than finding out when it can
      this.log.warn('ipc caller granted twice — replacing', { caller: grant.id });
      this.grants.set(contents.id, grant);
      return;
    }
    this.grants.set(contents.id, grant);
    contents.once('destroyed', () => this.grants.delete(contents.id));
    this.log.info('ipc capabilities granted', {
      caller: grant.id,
      count: grant.capabilities.size,
    });
  }

  /**
   * WHY this caller may not use this channel — or `undefined` if it may.
   *
   * The decision and the reason are one function because they are one
   * decision: `handle` has to tell the caller which of the three refusals it
   * hit, and re-deriving that outside would be a second copy of the rule that
   * could disagree with the log line beside it.
   */
  private denyReason(
    channel: Channel,
    sender: WebContents | undefined
  ): IpcRefusalReason | undefined {
    const needed = capabilityFor(channel);
    if (!needed) {
      // An untagged channel cannot be judged, so it is refused. Failing CLOSED
      // here is the one place in the app where that is right: an unknown
      // channel is a bug in our own wiring, and a unit test asserts every
      // registered channel is tagged, so this should be unreachable.
      this.log.error('ipc call on an UNTAGGED channel — refused', { channel });
      return 'unknown-channel';
    }
    const grant = sender ? this.grants.get(sender.id) : undefined;
    if (!grant) {
      // An ungranted caller is not an error to shrug at: it is either a window
      // we forgot to grant, or something we did not create.
      this.log.warn('ipc call from an ungranted caller — refused', {
        channel,
        capability: needed,
        senderId: sender?.id ?? -1,
      });
      return 'not-granted';
    }
    if (!grant.capabilities.has(needed)) {
      this.log.warn('ipc call refused — capability not held', {
        channel,
        capability: needed,
        caller: grant.id,
      });
      return 'capability-not-held';
    }
    return undefined;
  }

  /** Does this caller hold the capability a channel needs? */
  private allowed(channel: Channel, sender: WebContents | undefined): boolean {
    return this.denyReason(channel, sender) === undefined;
  }

  /**
   * `ipcMain.handle`, gated. A refused call RESOLVES an `IpcRefusal` (#346).
   *
   * A handler's own throw is deliberately left alone: it still rejects the
   * caller. The broker refuses on the caller's behalf and has no idea what a
   * handler failing halfway means, so catching here would convert every
   * subsystem's genuine failure into a value the caller reads as a refusal —
   * the opposite of the honesty this change is for. Whether a FAMILY throws is
   * that family's own contract (#326, #347 answered it for `groups:*` and
   * `sessions:*`).
   */
  handle<C extends StaticChannel>(
    channel: C,
    // Mirrors Electron's own ipcMain.handle signature so call sites keep
    // annotating their own parameters (`(_e, id: string) => ...`); anything
    // narrower here erases their types instead.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handler: (event: IpcMainInvokeEvent, ...args: any[]) => unknown
  ): void {
    ipcMain.handle(channel, (event, ...args) => {
      const denied = this.denyReason(channel, event.sender);
      if (denied) {
        // Answer, don't throw. The old throw arrived as a rejected promise in
        // the caller's code, so the first partially-granted caller — a Phase-4
        // plugin — would meet a refusal as an unhandled rejection it had no
        // reason to expect. A value can be checked; a rejection has to be
        // remembered. Still not silent: `denyReason` has already written the
        // channel, the capability and the caller to the log, and the payload
        // stays coarse on purpose (`refusal.ts` has the why).
        return ipcRefusal(channel, denied);
      }
      return handler(event, ...args);
    });
  }

  /**
   * `ipcMain.on`, gated. Fire-and-forget, so a refusal is dropped and logged.
   *
   * The asymmetry with `handle` is the transport's, not a choice: `send` has no
   * reply channel, so there is nowhere to put an `IpcRefusal`. A caller that
   * needs to know whether a one-way call landed has to use an `invoke` channel.
   */
  on<C extends StaticChannel>(
    channel: C,
    // as above — mirrors Electron's ipcMain.on signature
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handler: (event: Electron.IpcMainEvent, ...args: any[]) => void
  ): void {
    ipcMain.on(channel, (event, ...args) => {
      if (!this.allowed(channel, event.sender)) return;
      handler(event, ...args);
    });
  }

  /**
   * Push to a window, gated on what THAT window holds.
   *
   * Outbound needs the check as much as inbound: without it a Phase-4 plugin
   * would receive every session event regardless of what it declared. A no-op
   * for first-party, which holds everything.
   *
   * Refusing here is a silent drop by design, and unlike `on` that is a choice
   * rather than the transport's limit: a window that may not hear about
   * sessions must not be told that sessions are happening. Telling it "refused"
   * on every push would leak exactly the traffic pattern the gate withholds.
   */
  send<C extends Channel>(win: BrowserWindow | null, channel: C, payload: unknown): void {
    if (!win || win.isDestroyed()) return;
    if (!this.allowed(channel, win.webContents)) return;
    win.webContents.send(channel, payload);
  }

  /** Registration coverage, for the test that asserts nothing is untagged. */
  static knownChannels(): StaticChannel[] {
    return Object.keys(CHANNEL_CAPABILITIES) as StaticChannel[];
  }
}
