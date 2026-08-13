// Phone-push / webhook IPC (P2-E14-06, §5.9 + §5.29).
//
// Four channels, and the shape of them is the security story:
//
//   • `push:getConfig`  — the switches, and WHICH credentials are set. Booleans.
//   • `push:setPrefs`   — the switches. No field can hold a credential.
//   • `push:setSecret`  — write a credential INTO the OS store. One direction.
//   • `push:test`       — send one, now, and say what happened.
//
// **There is no `getSecret`, and there will not be one.** Once a credential is
// in the store the renderer cannot read it back — not to re-display it, not to
// pre-fill the field it was typed into. That costs the setup dialog the ability
// to show you your own token, which is a real cost and the right trade: the
// renderer is the process that runs third-party markdown and remote-ish
// content, and the whole point of putting the credential in main is that a
// compromise over there cannot walk off with it. The dialog shows "set" or
// "not set", and re-pasting is how you change one.
//
// Every write answers with the WHOLE config the store now holds, so a refused
// write leaves the dialog showing the truth rather than what it hoped for —
// the `rules-ipc.ts` shape, for the `rules-ipc.ts` reason.
import { IpcBroker } from '../ipc/broker';
import { LogFields, Logger } from '../log/logger';
import { WorkspaceStore } from '../workspace/store';
import {
  PushConfig,
  PushPrefs,
  PushSecretStatus,
  PushSendResult,
  PUSH_SECRET_KEYS,
  isPushSecretKey,
} from '../../shared/push';
import { PushActions, PushChannel } from './push-actions';
import { SecretStore } from '../secrets/store';

export interface PushIpcDeps {
  broker: IpcBroker;
  log: Logger;
  store: WorkspaceStore;
  secrets: SecretStore;
  actions: PushActions;
}

export function registerPushIpc(deps: PushIpcDeps): void {
  const { broker, log, store, secrets, actions } = deps;

  const status = (): PushSecretStatus => {
    const out = {} as PushSecretStatus;
    for (const key of PUSH_SECRET_KEYS) out[key] = secrets.has(key);
    return out;
  };
  const config = (): PushConfig => ({
    prefs: store.getPushPrefs(),
    secrets: status(),
    storeAvailable: secrets.available(),
  });
  const refuse = (channel: string, reason: string, fields: LogFields = {}): PushConfig => {
    log.warn(`${channel} refused: ${reason}`, fields);
    return config();
  };

  broker.handle('push:getConfig', (): PushConfig => config());

  broker.handle('push:setPrefs', (_e, p: unknown): PushConfig => {
    if (typeof p !== 'object' || p === null || Array.isArray(p))
      return refuse('push:setPrefs', 'the patch must be an object');
    const patch = p as Partial<PushPrefs>;
    const clean: Partial<PushPrefs> = {};
    if (patch.push !== undefined) {
      if (typeof patch.push !== 'boolean')
        return refuse('push:setPrefs', 'push must be true or false');
      clean.push = patch.push;
    }
    if (patch.webhook !== undefined) {
      if (typeof patch.webhook !== 'boolean')
        return refuse('push:setPrefs', 'webhook must be true or false');
      clean.webhook = patch.webhook;
    }
    if (patch.service !== undefined) {
      if (patch.service !== 'ntfy' && patch.service !== 'pushover')
        return refuse('push:setPrefs', 'unknown push service', { service: String(patch.service) });
      clean.service = patch.service;
    }
    if (patch.ntfyServer !== undefined) {
      if (typeof patch.ntfyServer !== 'string')
        return refuse('push:setPrefs', 'the ntfy server must be a string');
      clean.ntfyServer = patch.ntfyServer.trim();
    }
    const saved = store.setPushPrefs(clean);
    // The VALUES are switches and a hostname; none of them is a credential, so
    // this line is safe to write and useful to have when "why did my phone stop
    // buzzing" arrives.
    log.info('phone-push settings changed', {
      push: saved.push,
      webhook: saved.webhook,
      service: saved.service,
    });
    return config();
  });

  /**
   * Store one credential. An EMPTY value clears it — the dialog's "forget this"
   * and "I pasted nothing" are the same intent, and a separate channel for it
   * would be a second way to get the key wrong.
   *
   * The value is never logged, never echoed back, and never returned by any
   * channel in this file.
   */
  broker.handle('push:setSecret', (_e, key: unknown, value: unknown): PushConfig => {
    if (!isPushSecretKey(key)) return refuse('push:setSecret', 'unknown credential slot');
    if (typeof value !== 'string') return refuse('push:setSecret', 'the value must be a string', {
      key,
    });
    if (!value.trim()) {
      secrets.clear(key);
      return config();
    }
    if (!secrets.set(key, value))
      return refuse('push:setSecret', 'the credential could not be stored', { key });
    return config();
  });

  /** Send one now, and say what came back. Bypasses the enable switch. */
  broker.handle('push:test', async (_e, channel: unknown): Promise<PushSendResult> => {
    if (channel !== 'push' && channel !== 'webhook') {
      log.warn('push:test refused: unknown channel');
      return { ok: false, reason: 'not-configured' };
    }
    return actions.test(channel as PushChannel);
  });
}
