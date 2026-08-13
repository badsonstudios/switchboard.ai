// Phone push + webhook (P2-E14-06, §5.9 + §5.29) — the shapes both sides read.
//
// Two rule ACTIONS that leave the machine, and everything in this file exists
// to keep the line between them and the rest of the app legible:
//
//   • `push`    — a notification on the user's phone, via **ntfy** (a topic URL,
//                 no account) or **Pushover** (an app token + a user key).
//   • `webhook` — one POST of a documented JSON body to a URL the user owns.
//
// **What is NOT here: the credentials.** The topic, the tokens and the webhook
// URL live in the OS credential store (`main/secrets/store.ts`, §5.29) and
// never cross this boundary — the renderer can ask WHICH of them are set and
// can WRITE a new one, and that is the whole of its access. Nothing in this
// file has a field that could hold a secret value, which is deliberate: the
// type is the guard rail.

/** Which push service the user picked. Neither is a default that does anything
 *  on its own — both need a credential the user pastes in (§5.29). */
export type PushService = 'ntfy' | 'pushover';

/** ntfy's public server. Overridable for a self-hosted instance. */
export const NTFY_DEFAULT_SERVER = 'https://ntfy.sh';

/**
 * The non-secret half of the configuration — this is what the workspace file
 * is allowed to hold.
 *
 * Both switches default OFF and stay off until the matching secret exists:
 * "the app is fully functional with none of this configured" is the
 * requirement, so the unconfigured state has to be the resting state, not a
 * degraded one.
 */
export interface PushPrefs {
  /** phone push enabled — needs the picked service's secret(s) as well */
  push: boolean;
  service: PushService;
  /** self-hosted ntfy base URL; absent = `NTFY_DEFAULT_SERVER` */
  ntfyServer?: string;
  /** the generic webhook enabled — needs the URL secret as well */
  webhook: boolean;
}

export const DEFAULT_PUSH_PREFS: PushPrefs = { push: false, service: 'ntfy', webhook: false };

/**
 * The credential-store slots this feature uses.
 *
 * The ntfy TOPIC is in here with the tokens on purpose. It is not a password —
 * ntfy.sh has no accounts — but anyone who knows it can read every notification
 * you send and publish notifications to your phone, which is exactly the
 * property a secret has. Treating it as one costs nothing and keeps it out of
 * the workspace file, the logs and any screen-share of this page.
 */
export const PUSH_SECRET_KEYS = [
  'ntfy.topic',
  'pushover.token',
  'pushover.user',
  'webhook.url',
] as const;

export type PushSecretKey = (typeof PUSH_SECRET_KEYS)[number];

export function isPushSecretKey(k: unknown): k is PushSecretKey {
  return typeof k === 'string' && (PUSH_SECRET_KEYS as readonly string[]).includes(k);
}

/** Which secrets are SET — booleans, never values. The renderer's whole view. */
export type PushSecretStatus = Record<PushSecretKey, boolean>;

export interface PushConfig {
  prefs: PushPrefs;
  secrets: PushSecretStatus;
  /**
   * Whether the OS credential store will encrypt for us at all
   * (`safeStorage.isEncryptionAvailable()`). `false` on a Linux box with no
   * keyring — and there the honest answer is "this machine cannot keep a
   * secret", not a plaintext fallback, so the setup surface says so and stores
   * nothing.
   */
  storeAvailable: boolean;
}

/** Why a send did not happen, or did not land. Never shown as an "error". */
export type PushFailure =
  /** the OS credential store is unavailable — nothing could be read */
  | 'no-store'
  /** the switch is off, or the credential it needs was never pasted in */
  | 'not-configured'
  /**
   * There IS a destination and it is not usable — a webhook URL with no
   * scheme, an ntfy server that is not a URL.
   *
   * Its own reason rather than `not-configured`, because the two need opposite
   * handling: nothing configured is the resting state of a feature nobody
   * turned on and must stay silent, while a destination that cannot work is a
   * mistake the user made two minutes ago and must be said out loud. Review
   * caught this as "paste a bare hostname, see 'saved', never hear from it
   * again".
   */
  | 'bad-url'
  /** the request never landed: DNS, timeout, refused */
  | 'network'
  /** it landed and the service said no (non-2xx, or ntfy/Pushover's own error) */
  | 'refused';

export interface PushSendResult {
  ok: boolean;
  reason?: PushFailure;
  /**
   * The HTTP status, when there was one. Carried separately from `detail`
   * because it is the STABLE half of a failure: `detail` contains the service's
   * own body, and Pushover (like most APIs) puts a fresh request id in every
   * one — so keying "have I already logged this failure?" on the detail meant
   * never matching, and warning once per attention event forever. Found in
   * review, pinned by a test with a changing body.
   */
  status?: number;
  /**
   * One short line for the setup dialog's "Send test" — the service's own
   * complaint, truncated. **Scrubbed of anything secret before it gets here**
   * (`main/events/push.ts`): a service that echoes your token back in an error
   * message must not put it on screen or in the log.
   */
  detail?: string;
}

/** The webhook body's schema version. Bumped only for a BREAKING change. */
export const WEBHOOK_PAYLOAD_VERSION = 1;

/**
 * The documented webhook payload — the contract a consumer writes against.
 *
 * `event` is the attention state, and it is the field the requirement "a
 * consumer can distinguish event types" rests on: `needs-permission`,
 * `needs-input`, `done`, `crashed` (the §5.12 feed kinds). It is typed `string`
 * rather than a union so that a NEW kind is an ordinary value on the wire
 * rather than a breaking change to the schema — a consumer switches on it and
 * ignores what it does not know, which is also how this app reads unknown rule
 * actions.
 *
 * What is deliberately absent: the folder, the prompt, the transcript, any
 * path, and anything about the machine. The one string derived from the user's
 * own words is `title` (§5.11's auto task label, the same one on the card and
 * in OS toasts) — called out in the manual, because this payload leaves the
 * machine and the local-first constraint means the user gets to know exactly
 * what goes with it.
 */
export interface WebhookPayload {
  /** always `switchboard.ai` — lets a shared endpoint tell senders apart */
  source: 'switchboard.ai';
  version: number;
  /** the attention state: `needs-permission` | `needs-input` | `done` | `crashed` */
  event: string;
  /** the LIVE session id — changes every resume, useful for correlating a run */
  sessionId: string;
  /** the durable card id, or null when the binding could not be resolved */
  cardId: string | null;
  /** what a toast would have been headed with (task label, else session name) */
  title: string;
  /** the human phrase for the event, e.g. `needs permission` */
  body: string;
  /** which rule asked — the breadcrumb that matches the app's own log line */
  ruleId: string;
  /** `focused` | `visible` | `hidden` at the moment it fired */
  visibility: string;
  /** ISO-8601, from the feed event */
  at: string;
  /**
   * Present and `true` only for the setup dialog's **Send test**.
   *
   * Absent on every real event, so a consumer that ignores it is unaffected —
   * but one wired to an automation ("turn on the lamp when a session finishes")
   * can skip a test rather than acting on a session that never ran. Added in
   * review: without it the only tell was a magic `sessionId`.
   */
  test?: boolean;
}

/**
 * The answer to a WRITE (`push:setPrefs`, `push:setSecret`).
 *
 * Not just the new config: a credential can never be read back, so "did my
 * paste land?" is a question the dialog cannot answer by looking. A write that
 * was refused has to say so — otherwise the field empties, the status still
 * reads "not set", and nothing on screen explains why.
 */
export interface PushWriteResult {
  config: PushConfig;
  ok: boolean;
  /** why not — `bad-url`, or `not-stored` when the credential store refused */
  problem?: 'bad-url' | 'not-stored' | 'refused';
}

/**
 * What the renderer shows when main cannot answer at all — no `push` namespace
 * on the bridge, or a call that rejected.
 *
 * `storeAvailable: false` on purpose: a dialog that cannot reach main can no
 * more keep a secret than a machine with no keyring can, and rendering it as
 * live would give the user a Save button that silently does nothing. Same
 * fail-open posture, honest about which failure it is.
 */
export function unavailablePushConfig(): PushConfig {
  return {
    prefs: { ...DEFAULT_PUSH_PREFS },
    secrets: {
      'ntfy.topic': false,
      'pushover.token': false,
      'pushover.user': false,
      'webhook.url': false,
    },
    storeAvailable: false,
  };
}
