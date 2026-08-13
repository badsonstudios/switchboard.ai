// The two channels that leave the machine (P2-E14-06, §5.9): phone push (ntfy /
// Pushover) and a generic webhook.
//
// This file is the WIRE and nothing else — build a request, send it, report
// what happened. It holds no state, reads no store, and never decides whether
// to send: `push-actions.ts` owns that, and the rules engine owns whether it is
// even asked. Split that way so the payload a consumer writes against can be
// pinned by a test with no electron, no network and no credential store in
// sight (`push.test.ts`).
//
// ── the fail-open contract (P6) ──────────────────────────────────────────────
//
// **Nothing in here throws or rejects.** Every send resolves with a
// `PushSendResult`, and a dead phone, a wrong token, a captive-portal DNS
// answer and an unreachable self-hosted server all land on the same shape.
// There is no retry: a session must never wait on a notification, and a retry
// loop against a service that is refusing us is how a fail-open channel turns
// into a storm.
//
// ── never send a secret to the log or the screen ─────────────────────────────
//
// `scrubSecrets` runs over every string that comes back from a service before
// it can reach a log line or the setup dialog. Pushover echoes the token it
// rejected in its own error body — which is reasonable of them and unacceptable
// of us.
import {
  NTFY_DEFAULT_SERVER,
  PushSendResult,
  WEBHOOK_PAYLOAD_VERSION,
  WebhookPayload,
} from '../../shared/push';
import type { RuleActionContext } from './rules-engine';

/** How long a service gets before we give up. The socket is aborted with it. */
export const PUSH_TIMEOUT_MS = 8_000;

/** Pushover's one endpoint (their documented messages API). */
export const PUSHOVER_ENDPOINT = 'https://api.pushover.net/1/messages.json';

/** Enough of a service's complaint to act on, and no more. */
const MAX_DETAIL = 200;

export type FetchLike = typeof fetch;

export interface SendDeps {
  fetchImpl?: FetchLike;
  /** every value that must never appear in a result's `detail` */
  secrets?: readonly string[];
  /** the app version, for the User-Agent. Courtesy, not identity. */
  userAgent?: string;
  now?: () => Date;
}

/**
 * Replace every known credential with `***`.
 *
 * Applied to service error bodies and to thrown-error strings — a URL that
 * failed to resolve arrives inside the error message, and for the webhook that
 * URL *is* the secret.
 *
 * Two limits, stated rather than discovered: it is an exact-substring match, so
 * a value a service echoes back re-encoded (percent-escaped, JSON-escaped) is
 * not caught; and anything under four characters is left alone, because
 * redacting a three-letter topic would redact half the English in the message
 * and tell the reader nothing. Neither is a hole in the STORAGE promise — this
 * is defence in depth over one string that reaches a log and a dialog.
 */
export function scrubSecrets(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const s of secrets) {
    if (typeof s === 'string' && s.length >= 4) out = out.split(s).join('***');
  }
  return out;
}

function detail(text: string, secrets: readonly string[] | undefined): string {
  return scrubSecrets(String(text), secrets ?? [])
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_DETAIL);
}

/**
 * Is this a URL we are willing to POST to?
 *
 * `http`/`https` only. The webhook URL comes from the user, but "the user typed
 * it" is not a reason to hand `file:` or a custom scheme to `fetch` — and the
 * check also catches the commonest paste mistake, a bare `example.com`, with a
 * message instead of a network failure.
 */
export function isPostableUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * How loud the phone should be, per event.
 *
 * Attention events are the ones you are away from the desk for, so they go out
 * at HIGH; a finished turn goes at the service's default. Nothing uses the
 * top priority either service offers — those bypass the phone's own
 * do-not-disturb, and a tool whose whole design principle is "calm" does not
 * get to override the user's night.
 */
export function isUrgentKind(kind: string): boolean {
  return kind === 'needs-permission' || kind === 'needs-input' || kind === 'crashed';
}

/** ntfy: 1..5, 3 is default, 4 is high. */
export function ntfyPriority(kind: string): number {
  return isUrgentKind(kind) ? 4 : 3;
}

/** Pushover: -2..2, 0 is default, 1 is high. */
export function pushoverPriority(kind: string): number {
  return isUrgentKind(kind) ? 1 : 0;
}

/** A phone-friendly icon per event (ntfy renders these as emoji). */
export function ntfyTags(kind: string): string[] {
  switch (kind) {
    case 'needs-permission':
      return ['closed_lock_with_key'];
    case 'needs-input':
      return ['speech_balloon'];
    case 'crashed':
      return ['warning'];
    case 'done':
      return ['white_check_mark'];
    default:
      return ['bell'];
  }
}

/**
 * The documented webhook body (`shared/push.ts` → `WebhookPayload`).
 *
 * Built from the SAME `RuleActionContext` every other channel reads, which is
 * what makes "the phone and the toast said the same thing" true by
 * construction rather than by two code paths agreeing today.
 */
export function buildWebhookPayload(ctx: RuleActionContext): WebhookPayload {
  return {
    source: 'switchboard.ai',
    version: WEBHOOK_PAYLOAD_VERSION,
    event: ctx.event.kind,
    sessionId: ctx.event.sessionId,
    cardId: ctx.cardId,
    title: ctx.title,
    body: ctx.body,
    ruleId: ctx.rule.id,
    visibility: ctx.visibility,
    at: ctx.event.at,
  };
}

interface RawResult {
  ok: boolean;
  status?: number;
  body?: string;
  error?: string;
}

/** One POST, with a deadline that covers the body read. Never throws. */
async function post(
  url: string,
  init: { headers: Record<string, string>; body: string },
  deps: SendDeps
): Promise<RawResult> {
  const doFetch = deps.fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== 'function') return { ok: false, error: 'no fetch in this runtime' };
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), PUSH_TIMEOUT_MS);
  try {
    const res = await doFetch(url, {
      method: 'POST',
      headers: {
        'user-agent': `switchboard.ai/${deps.userAgent ?? 'dev'}`,
        ...init.headers,
      },
      body: init.body,
      signal: abort.signal,
      // NOT `follow`, unlike the status poller next door — and the difference
      // is the body. A 307/308 re-POSTs it to whatever host the redirect
      // names, which for these two requests means handing an ntfy topic or a
      // session's title to a third party the user never configured. Neither
      // service redirects its publish endpoint, so this costs nothing real,
      // and a setup that does redirect fails visibly in Send test rather than
      // leaking quietly.
      redirect: 'error',
    });
    let body = '';
    try {
      body = await res.text();
    } catch {
      // A body we could not read says nothing about whether it was accepted.
      body = '';
    }
    return { ok: res.ok, status: res.status, body };
  } catch (err) {
    return { ok: false, error: String(err) };
  } finally {
    clearTimeout(timer);
  }
}

function failure(raw: RawResult, deps: SendDeps): PushSendResult {
  if (raw.error) return { ok: false, reason: 'network', detail: detail(raw.error, deps.secrets) };
  return {
    ok: false,
    reason: 'refused',
    ...(typeof raw.status === 'number' ? { status: raw.status } : {}),
    detail: detail(`HTTP ${raw.status ?? '?'} ${raw.body ?? ''}`, deps.secrets),
  };
}

export interface NtfyMessage {
  server?: string;
  topic: string;
  title: string;
  message: string;
  priority?: number;
  tags?: string[];
}

/**
 * Publish to ntfy.
 *
 * The **JSON** publish form (topic in the body, POST to the server root) rather
 * than ntfy's URL form (`POST /<topic>`), for one reason that matters here: the
 * topic is a credential, and with the URL form it would end up in every error
 * string, every log line that names the request, and every proxy access log
 * between here and there. In the body it goes over TLS and nowhere else.
 */
export async function sendNtfy(msg: NtfyMessage, deps: SendDeps = {}): Promise<PushSendResult> {
  const base = (msg.server?.trim() || NTFY_DEFAULT_SERVER).replace(/\/+$/, '');
  if (!isPostableUrl(base))
    return { ok: false, reason: 'bad-url', detail: 'the ntfy server is not an http(s) URL' };
  if (!msg.topic.trim()) return { ok: false, reason: 'not-configured' };
  const raw = await post(
    `${base}/`,
    {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        topic: msg.topic.trim(),
        title: msg.title,
        message: msg.message,
        ...(msg.priority ? { priority: msg.priority } : {}),
        ...(msg.tags?.length ? { tags: msg.tags } : {}),
      }),
    },
    deps
  );
  return raw.ok ? { ok: true } : failure(raw, deps);
}

export interface PushoverMessage {
  /** the APPLICATION token, from the user's Pushover app registration */
  token: string;
  /** the USER key (or a group key) */
  user: string;
  title: string;
  message: string;
  priority?: number;
}

/**
 * Send via Pushover.
 *
 * Form-encoded, which is what their API takes. A 200 can still be a refusal —
 * they answer `{"status":1}` for accepted and `{"status":0,"errors":[…]}`
 * otherwise — so the body is checked as well as the code, or a typo'd user key
 * would report success and buzz nothing forever.
 */
export async function sendPushover(
  msg: PushoverMessage,
  deps: SendDeps = {}
): Promise<PushSendResult> {
  if (!msg.token.trim() || !msg.user.trim()) return { ok: false, reason: 'not-configured' };
  // Their documented ceilings (250 / 1024). Nothing we send is near them —
  // these are a task label and four words — but a title long enough to be
  // refused would fail every push with a 4xx nobody could read.
  const form = new URLSearchParams({
    token: msg.token.trim(),
    user: msg.user.trim(),
    title: msg.title.slice(0, 250),
    message: msg.message.slice(0, 1024),
  });
  if (msg.priority) form.set('priority', String(msg.priority));
  const raw = await post(
    PUSHOVER_ENDPOINT,
    { headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString() },
    deps
  );
  if (!raw.ok) return failure(raw, deps);
  try {
    const parsed = JSON.parse(raw.body ?? '{}') as { status?: number; errors?: unknown };
    if (parsed.status !== 1)
      return {
        ok: false,
        reason: 'refused',
        detail: detail(
          Array.isArray(parsed.errors) ? parsed.errors.join(', ') : (raw.body ?? ''),
          deps.secrets
        ),
      };
  } catch {
    // A 2xx with a body we cannot parse is still a 2xx. Their documented
    // contract is the status field; an unreadable body is not evidence of a
    // refusal, and calling it one would put a red line under a push that
    // actually arrived.
  }
  return { ok: true };
}

/** POST the documented body to the user's own endpoint. */
export async function postWebhook(
  url: string,
  payload: WebhookPayload,
  deps: SendDeps = {}
): Promise<PushSendResult> {
  if (!isPostableUrl(url))
    return { ok: false, reason: 'bad-url', detail: 'the webhook URL is not http(s)' };
  const raw = await post(
    url,
    { headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) },
    deps
  );
  return raw.ok ? { ok: true } : failure(raw, deps);
}
