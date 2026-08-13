// The rules runner (P2-E14-03, §5.9): turns a feed event into the actions the
// matching rules asked for, and runs them.
//
// Split from `rules.ts` on purpose — that file is pure data and matching, this
// one owns the two impure things: the action REGISTRY and the log. Neither
// imports electron; the `os-toast` handler is registered by `main/index.ts`,
// which is the only place that gets to touch `Notification`.
//
// **The seam E14-04/05/06 extend.** Each of those items registers one or more
// action types and writes rules that use them — nothing in `rules.ts` or this
// class changes:
//
//   registry.register('sound',   (a, ctx) => play(a.file));            // E14-05
//   registry.register('speak',   (a, ctx) => tts(ctx.body));           // E14-05
//   registry.register('push',    (a, ctx) => ntfy(a.topic, ctx));      // E14-06
//   registry.register('webhook', (a, ctx) => post(a.url, ctx));        // E14-06
//
// E14-04's Allow/Deny toast is the same `os-toast` type carrying buttons: the
// handler reads `action.buttons`, and a rule that doesn't set them behaves
// exactly as it does today.
import type { Logger } from '../log/logger';
import type { FeedEvent } from './feed';
import {
  MatchedAction,
  Rule,
  RuleAction,
  RuleTrigger,
  WindowVisibility,
  plannedActions,
} from './rules';

/** What a handler is told, beyond its own action payload. */
export interface RuleActionContext {
  /** the feed event that fired the rule (session id here is the LIVE one) */
  event: FeedEvent;
  /** the durable card the event belongs to, if it could be resolved */
  cardId: string | null;
  visibility: WindowVisibility;
  /** the rule that asked for this action — its id is the log's breadcrumb */
  rule: Rule;
  /** human strings, resolved once per event so every channel says the same thing */
  title: string;
  body: string;
}

/**
 * May be async, and #424's will be: a push or a webhook is an HTTP round trip.
 * A handler that returns a promise gets the same fail-open treatment as one
 * that throws synchronously — see `run` — rather than leaving the main process
 * with an unhandled rejection the first time a phone is unreachable.
 */
export type RuleActionHandler = (
  action: RuleAction,
  ctx: RuleActionContext
) => void | Promise<void>;

/**
 * Action type -> handler.
 *
 * Two rules, both fail-open (P6): an UNKNOWN type is logged once and skipped
 * (a rule from a newer build, or a typo in a hand-edited workspace file), and a
 * handler that THROWS costs its own action and nothing else — a broken sound
 * device must not swallow the toast queued behind it.
 */
export class RuleActionRegistry {
  private readonly handlers = new Map<string, RuleActionHandler>();

  constructor(private readonly log?: Logger) {}

  register(type: string, handler: RuleActionHandler): void {
    this.handlers.set(type, handler);
  }

  has(type: string): boolean {
    return this.handlers.has(type);
  }

  run(action: RuleAction, ctx: RuleActionContext): boolean {
    const handler = this.handlers.get(action.type);
    if (!handler) {
      this.log?.warn('notification rule asked for an action this build has no handler for', {
        action: action.type,
        ruleId: ctx.rule.id,
      });
      return false;
    }
    const failed = (err: unknown): void => {
      this.log?.warn('a notification action failed', {
        action: action.type,
        ruleId: ctx.rule.id,
        error: String(err),
      });
    };
    try {
      // An async handler is dispatched, not awaited: the engine sits on the
      // event path and must not hold it open for a network round trip. `true`
      // therefore means DISPATCHED, and a later rejection is logged where a
      // synchronous throw would have been.
      const maybe = handler(action, ctx);
      if (maybe && typeof (maybe as Promise<void>).catch === 'function') {
        void (maybe as Promise<void>).catch(failed);
      }
      return true;
    } catch (err) {
      failed(err);
      return false;
    }
  }
}

export interface RulesEngineDeps {
  /** the persisted user rules, read fresh per event so an edit takes effect at once */
  getRules: () => Rule[];
  /** the built-ins for the current prefs (`defaultRules`) */
  getDefaultRules: () => Rule[];
  /** live session id -> durable card id; null when the binding is unknown */
  cardIdFor: (liveSessionId: string) => string | null;
  getVisibility: () => WindowVisibility;
  titleFor: (event: FeedEvent, cardId: string | null) => string;
  bodyFor: (event: FeedEvent) => string;
  registry: RuleActionRegistry;
  log?: Logger;
}

export class RulesEngine {
  constructor(private readonly deps: RulesEngineDeps) {}

  /** What WOULD run for this event — exposed for tests and for #422's preview. */
  plan(event: FeedEvent): { trigger: RuleTrigger; actions: MatchedAction[] } {
    const trigger: RuleTrigger = {
      kind: event.kind,
      cardId: this.deps.cardIdFor(event.sessionId),
      visibility: this.deps.getVisibility(),
    };
    const rules = [...this.deps.getDefaultRules(), ...this.deps.getRules()];
    return { trigger, actions: plannedActions(rules, trigger) };
  }

  /** Match and run. Returns how many actions actually ran (tests, logging). */
  handle(event: FeedEvent): number {
    let ran = 0;
    try {
      const { trigger, actions } = this.plan(event);
      if (actions.length === 0) return 0;
      const title = this.deps.titleFor(event, trigger.cardId);
      const body = this.deps.bodyFor(event);
      for (const { rule, action } of actions) {
        const ctx: RuleActionContext = {
          event,
          cardId: trigger.cardId,
          visibility: trigger.visibility,
          rule,
          title,
          body,
        };
        if (this.deps.registry.run(action, ctx)) ran++;
      }
      this.deps.log?.info('notification rules fired', {
        kind: event.kind,
        cardId: trigger.cardId ?? '',
        visibility: trigger.visibility,
        ran,
        rules: actions.map((a) => a.rule.id).join(','),
      });
    } catch (err) {
      // notifying is best-effort; never let it break the session flow
      this.deps.log?.warn('the notification rules engine threw', { error: String(err) });
    }
    return ran;
  }
}
