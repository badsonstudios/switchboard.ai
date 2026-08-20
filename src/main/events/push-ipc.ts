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
  PushWriteResult,
  PUSH_SECRET_KEYS,
  isPushSecretKey,
} from '../../shared/push';
import { PushActions } from './push-actions';
import { SecretStore } from '../secrets/store';
import { isPostableUrl } from './push';

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
  const ok = (): PushWriteResult => ({ config: config(), ok: true });
  const refuse = (
    channel: string,
    reason: string,
    problem: PushWriteResult['problem'] = 'refused',
    fields: LogFields = {}
  ): PushWriteResult => {
    log.warn(`${channel} refused: ${reason}`, fields);
    return { config: config(), ok: false, problem };
  };

  /**
   * A destination we could never reach, refused at the DOOR rather than at
   * send time.
   *
   * Without this, pasting `hooks.example.com/x` (no scheme) stored fine, read
   * back "saved", and then silently never fired — the worst shape a setting can
   * have. Review caught it; the reason it belongs here and not only in the
   * sender is that this is the moment the user is looking at the screen.
   */
  const hasUserinfo = (value: string): boolean => {
    try {
      const u = new URL(value);
      return !!u.username || !!u.password;
    } catch {
      return false;
    }
  };

  broker.handle('push:getConfig', (): PushConfig => config());

  broker.handle('push:setPrefs', (_e, p: unknown): PushWriteResult => {
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
        return refuse('push:setPrefs', 'unknown push service', 'refused', {
          service: String(patch.service),
        });
      clean.service = patch.service;
    }
    if (patch.ntfyServer !== undefined) {
      if (typeof patch.ntfyServer !== 'string')
        return refuse('push:setPrefs', 'the ntfy server must be a string');
      const server = patch.ntfyServer.trim();
      // Empty is meaningful — it means "use ntfy.sh" — so only a NON-empty
      // unusable one is refused.
      if (server && !isPostableUrl(server))
        return refuse('push:setPrefs', 'the ntfy server is not an http(s) URL', 'bad-url');
      // …and this field, unlike the webhook URL, is stored in the WORKSPACE
      // FILE in plain text (a server address is not a secret). A password
      // smuggled into it as `https://user:pass@host` would be a credential in
      // that file through the side door, which is the one thing §5.29 forbids
      // outright. Refused with its own message rather than silently stripped.
      if (server && hasUserinfo(server))
        return refuse(
          'push:setPrefs',
          'the ntfy server may not carry a username or password',
          'url-userinfo'
        );
      clean.ntfyServer = server;
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
    return ok();
  });

  /**
   * Store one credential. An EMPTY value clears it — the dialog's "forget this"
   * and "I pasted nothing" are the same intent, and a separate channel for it
   * would be a second way to get the key wrong.
   *
   * The value is never logged, never echoed back, and never returned by any
   * channel in this file.
   */
  broker.handle('push:setSecret', (_e, key: unknown, value: unknown): PushWriteResult => {
    if (!isPushSecretKey(key)) return refuse('push:setSecret', 'unknown credential slot');
    if (typeof value !== 'string')
      return refuse('push:setSecret', 'the value must be a string', 'refused', { key });
    if (!value.trim()) {
      secrets.clear(key);
      return ok();
    }
    // The webhook URL is the one credential whose SHAPE we can check, and the
    // one users get wrong (a bare hostname). Note what is NOT checked here:
    // `https://user:pass@host` is allowed for this field, because this one goes
    // into the credential store encrypted — basic auth on a webhook is a real
    // setup, and there is no separate auth field to send someone to instead.
    if (key === 'webhook.url' && !isPostableUrl(value.trim()))
      return refuse('push:setSecret', 'the webhook URL is not an http(s) URL', 'bad-url', {
        key,
      });
    if (!secrets.set(key, value))
      return refuse('push:setSecret', 'the credential could not be stored', 'not-stored', { key });
    return ok();
  });

  /** Send one now, and say what came back. Bypasses the enable switch. */
  broker.handle('push:test', async (_e, channel: unknown): Promise<PushSendResult> => {
    if (channel !== 'push' && channel !== 'webhook') {
      log.warn('push:test refused: unknown channel');
      return { ok: false, reason: 'not-configured' };
    }
    return actions.test(channel);
  });
}
