// The `push` and `webhook` rule actions (P2-E14-06, §5.9) — the deciding half.
//
// `push.ts` knows how to talk to a service; this file knows WHETHER to, with
// what credential, and what to do when it does not work. It is the only place
// that reads the credential store on the notification path, and the credential
// never leaves it: not into a rule, not into the action payload, not into a log
// line, not into an IPC answer.
//
// ── why the action payload carries no configuration ──────────────────────────
//
// A rule's action is `{ type: 'push' }` and nothing else. The alternative —
// `{ type: 'push', topic: '…' }` — would have put the credential in the
// workspace file the moment anyone wrote a rule, which is the exact thing
// §5.29 forbids and the exact thing a hand-edited rules file would leak. The
// cost is that all push rules share one destination, which is also the whole
// requirement today ("the phone", singular). When a rules editor gives rules
// separate destinations, the payload gets a *reference* (a slot name), never a
// value.
//
// ── one failure, one log line ────────────────────────────────────────────────
//
// A phone that is off, a webhook host that went away, a laptop on a plane: the
// same failure arrives on every attention event, and a warn per event turns the
// log into the thing you cannot read while debugging the session that actually
// broke. So a repeat of the SAME failure is counted, not logged, and the count
// is reported when it changes or when it recovers. There is no retry anywhere
// in this file — the storm this prevents is a logging one, because the sending
// one was never built.
import { PushPrefs, PushSecretKey, PushSendResult } from '../../shared/push';
import type { Logger } from '../log/logger';
import {
  FetchLike,
  buildWebhookPayload,
  ntfyPriority,
  ntfyTags,
  postWebhook,
  pushoverPriority,
  sendNtfy,
  sendPushover,
} from './push';
import type { RuleActionContext, RuleActionHandler } from './rules-engine';

/** Just enough of `SecretStore` to run these two actions (and to fake in a test). */
export interface SecretReader {
  available(): boolean;
  get(key: PushSecretKey): string | null;
}

export interface PushActionsDeps {
  secrets: SecretReader;
  /** read fresh per event, so flipping a switch takes effect at once */
  getPrefs: () => PushPrefs;
  log?: Logger;
  fetchImpl?: FetchLike;
  userAgent?: string;
}

/** Which outbound channel a result belongs to — the log's first field. */
export type PushChannel = 'push' | 'webhook';

export class PushActions {
  /** channel -> the failure last LOGGED, so a repeat can be counted instead */
  private lastFailure = new Map<PushChannel, string>();
  private suppressed = new Map<PushChannel, number>();

  constructor(private readonly deps: PushActionsDeps) {}

  /** Every stored value, for scrubbing service replies. Never logged. */
  private allSecrets(): string[] {
    const keys: PushSecretKey[] = ['ntfy.topic', 'pushover.token', 'pushover.user', 'webhook.url'];
    return keys.map((k) => this.deps.secrets.get(k)).filter((v): v is string => !!v);
  }

  private sendDeps(): { fetchImpl?: FetchLike; secrets: string[]; userAgent?: string } {
    return {
      ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {}),
      secrets: this.allSecrets(),
      ...(this.deps.userAgent ? { userAgent: this.deps.userAgent } : {}),
    };
  }

  /**
   * Send a push. `enforceSwitch` is false for the setup dialog's **Send test**:
   * that button is an explicit "do it now", and refusing it because the
   * automatic switch is off would be the app arguing with the user about what
   * they just clicked.
   */
  async sendPush(
    msg: { title: string; message: string; kind: string },
    enforceSwitch = true
  ): Promise<PushSendResult> {
    const prefs = this.deps.getPrefs();
    if (enforceSwitch && !prefs.push) return { ok: false, reason: 'not-configured' };
    if (!this.deps.secrets.available()) return { ok: false, reason: 'no-store' };
    if (prefs.service === 'pushover') {
      const token = this.deps.secrets.get('pushover.token');
      const user = this.deps.secrets.get('pushover.user');
      if (!token || !user) return { ok: false, reason: 'not-configured' };
      return sendPushover(
        {
          token,
          user,
          title: msg.title,
          message: msg.message,
          priority: pushoverPriority(msg.kind),
        },
        this.sendDeps()
      );
    }
    const topic = this.deps.secrets.get('ntfy.topic');
    if (!topic) return { ok: false, reason: 'not-configured' };
    return sendNtfy(
      {
        ...(prefs.ntfyServer ? { server: prefs.ntfyServer } : {}),
        topic,
        title: msg.title,
        message: msg.message,
        priority: ntfyPriority(msg.kind),
        tags: ntfyTags(msg.kind),
      },
      this.sendDeps()
    );
  }

  /** POST the documented body. Same switch rule as `sendPush`. */
  async sendWebhook(
    ctx: RuleActionContext,
    enforceSwitch = true,
    isTest = false
  ): Promise<PushSendResult> {
    const prefs = this.deps.getPrefs();
    if (enforceSwitch && !prefs.webhook) return { ok: false, reason: 'not-configured' };
    if (!this.deps.secrets.available()) return { ok: false, reason: 'no-store' };
    const url = this.deps.secrets.get('webhook.url');
    if (!url) return { ok: false, reason: 'not-configured' };
    const payload = buildWebhookPayload(ctx);
    return postWebhook(url, isTest ? { ...payload, test: true } : payload, this.sendDeps());
  }

  /** The `push` action, ready for `registry.register`. */
  get pushHandler(): RuleActionHandler {
    return async (_action, ctx) => {
      const result = await this.sendPush({
        title: ctx.title,
        message: ctx.body,
        kind: ctx.event.kind,
      });
      this.report('push', result, ctx);
    };
  }

  /** The `webhook` action, ready for `registry.register`. */
  get webhookHandler(): RuleActionHandler {
    return async (_action, ctx) => {
      const result = await this.sendWebhook(ctx);
      this.report('webhook', result, ctx);
    };
  }

  /**
   * The **Send test** button behind both channels. Bypasses the enable switch
   * (see `sendPush`) and always answers with a reason the dialog can show.
   */
  async test(channel: PushChannel, now: Date = new Date()): Promise<PushSendResult> {
    const result =
      channel === 'push'
        ? await this.sendPush(
            {
              title: 'switchboard.ai',
              message: 'Test notification — your phone is set up.',
              kind: 'done',
            },
            false
          )
        : await this.sendWebhook(
            {
              event: { id: 0, sessionId: 'test', kind: 'done', at: now.toISOString() },
              cardId: null,
              visibility: 'focused',
              rule: { id: 'test', event: 'done', actions: [] },
              title: 'switchboard.ai',
              body: 'test',
            },
            false,
            true // marks the payload `test: true` — see WebhookPayload
          );
    // A test is a thing the user is watching, so it is always worth a line —
    // and it resets the suppression counter, because the state of the world
    // has just been re-established.
    this.deps.log?.info('an outbound notification test was sent', {
      channel,
      ok: result.ok,
      ...(result.reason ? { reason: result.reason } : {}),
      ...(result.detail ? { detail: result.detail } : {}),
    });
    this.lastFailure.delete(channel);
    this.suppressed.delete(channel);
    return result;
  }

  /**
   * One line per NEW outcome.
   *
   * `not-configured` is silent: it is the resting state of a feature nobody
   * turned on, and every attention event would otherwise write a line saying
   * so. Everything else is logged once and then counted.
   */
  private report(channel: PushChannel, result: PushSendResult, ctx: RuleActionContext): void {
    const log = this.deps.log;
    if (!log) return;
    if (result.ok) {
      const missed = this.suppressed.get(channel) ?? 0;
      this.lastFailure.delete(channel);
      this.suppressed.delete(channel);
      log.info('an outbound notification was sent', {
        channel,
        kind: ctx.event.kind,
        cardId: ctx.cardId ?? '',
        ruleId: ctx.rule.id,
        ...(missed ? { afterFailures: missed } : {}),
      });
      return;
    }
    if (result.reason === 'not-configured') return;
    // The signature is the STABLE part of the failure — reason and HTTP status,
    // never `detail`. Pushover puts a fresh request id in every response body
    // and most webhook hosts put a request/ray id in theirs, so a
    // detail-keyed signature never repeated and the "one failure, one line"
    // promise quietly became one line per attention event. Caught in review;
    // `push-actions.test.ts` now drives it with a changing body.
    const signature = `${result.reason ?? '?'}:${result.status ?? ''}`;
    if (this.lastFailure.get(channel) === signature) {
      this.suppressed.set(channel, (this.suppressed.get(channel) ?? 0) + 1);
      return;
    }
    const repeats = this.suppressed.get(channel) ?? 0;
    this.lastFailure.set(channel, signature);
    this.suppressed.set(channel, 0);
    log.warn('an outbound notification did not get through', {
      channel,
      kind: ctx.event.kind,
      ruleId: ctx.rule.id,
      reason: result.reason ?? 'unknown',
      ...(result.detail ? { detail: result.detail } : {}),
      ...(repeats ? { previousFailuresNotLogged: repeats } : {}),
    });
  }
}
