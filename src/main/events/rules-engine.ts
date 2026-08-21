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
import type { SuppressedEvent } from '../../shared/suppressed';
import {
  MatchedAction,
  QuietWindow,
  Rule,
  RuleAction,
  RuleTrigger,
  WindowVisibility,
  plannedActions,
  splitQuiet,
  triggerIsQuiet,
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
      if (maybe && typeof maybe.catch === 'function') {
        void maybe.catch(failed);
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
  /**
   * The configured quiet window, or null (P2-E14-05b). Read per event like the
   * rules are, so changing it in the dialog takes effect on the next event.
   */
  getQuietWindow?: () => QuietWindow | null;
  /**
   * **The one clock in the notification stack.** Everything downstream —
   * `RuleTrigger.now`, `inQuietWindow`, the record's timestamp — reads the Date
   * this returns, so a test sets the time in one argument and the evaluator
   * stays a table. Defaults to the wall clock.
   */
  now?: () => Date;
  /**
   * Where a held event goes (P2-E14-05b). The engine builds the record and
   * hands it over; persisting it is the store's job (`recordSuppressed`), and
   * reading it is #483's.
   *
   * Optional and never awaited: a digest that cannot be written must not cost
   * the webhook that was going out anyway (P6).
   */
  onSuppressed?: (record: SuppressedEvent) => void;
  log?: Logger;
}

/** What a plan came to: what runs, what quiet hours held, and whether it is quiet. */
export interface RulePlan {
  trigger: RuleTrigger;
  /** actions that will run */
  actions: MatchedAction[];
  /** actions that matched and were held by quiet hours */
  held: MatchedAction[];
  quiet: boolean;
}

/**
 * Disambiguates two suppression records written in the same millisecond.
 *
 * MODULE level, not per engine: a second window, a test harness or any future
 * per-workspace engine would each start their own counter at zero and collide
 * on a shared millisecond, and `clearSuppressed` filters by id — a duplicate
 * would clear the wrong digest row. The store refuses a duplicate id as a
 * second line of defence, which is also what covers a clock stepped backwards.
 */
let suppressionSeq = 0;

export class RulesEngine {
  constructor(private readonly deps: RulesEngineDeps) {}

  /**
   * What WOULD run for this event, without running it — for tests and for
   * #422's preview.
   *
   * **`actions` means "will run", not "matched", since P2-E14-05b.** Anything
   * quiet hours held is in `held`, not in `actions`. A preview that renders
   * `actions` alone will show an empty plan at 3am and be telling the truth
   * about tonight while looking like a broken rule — render both.
   */
  plan(event: FeedEvent): RulePlan {
    const trigger: RuleTrigger = {
      kind: event.kind,
      cardId: this.deps.cardIdFor(event.sessionId),
      visibility: this.deps.getVisibility(),
      now: (this.deps.now ?? (() => new Date()))(),
      quiet: this.deps.getQuietWindow?.() ?? null,
    };
    const rules = [...this.deps.getDefaultRules(), ...this.deps.getRules()];
    const { run, held } = splitQuiet(plannedActions(rules, trigger), trigger);
    return { trigger, actions: run, held, quiet: triggerIsQuiet(trigger) };
  }

  /** Match and run. Returns how many actions actually ran (tests, logging). */
  handle(event: FeedEvent): number {
    let ran = 0;
    try {
      const { trigger, actions, held, quiet } = this.plan(event);
      if (actions.length === 0 && held.length === 0) return 0;
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
      // Held actions are written down BEFORE the log line, so a digest entry
      // and the line that explains it cannot disagree about what happened.
      if (held.length > 0) this.record(trigger, held, title, body);
      this.deps.log?.info('notification rules fired', {
        kind: event.kind,
        cardId: trigger.cardId ?? '',
        visibility: trigger.visibility,
        ran,
        rules: actions.map((a) => a.rule.id).join(','),
        // The two facts P2-E14-05b adds, and the pair the e2e reads: was the
        // window open, and which channels did it hold. `quiet=true` with an
        // empty `held` is the interesting case, not a contradiction — it is a
        // webhook going out at 3am exactly as designed.
        quiet,
        held: held.map((a) => a.action.type).join(','),
      });
    } catch (err) {
      // notifying is best-effort; never let it break the session flow
      this.deps.log?.warn('the notification rules engine threw', { error: String(err) });
    }
    return ran;
  }

  /**
   * Write down one held event (P2-E14-05b) — one record per EVENT, listing the
   * channels, because that is the shape a digest line has.
   *
   * Its own try/catch: `handle`'s already covers this, but a store that refuses
   * to grow must not be able to cost the log line below it — the line is the
   * only thing left saying anything happened at all.
   */
  private record(
    trigger: RuleTrigger,
    held: readonly MatchedAction[],
    title: string,
    body: string
  ): void {
    try {
      const at = (trigger.now ?? new Date()).getTime();
      this.deps.onSuppressed?.({
        id: `${at}-${++suppressionSeq}`,
        at,
        kind: trigger.kind,
        cardId: trigger.cardId,
        title,
        body,
        actions: [...new Set(held.map((h) => h.action.type))],
        ruleIds: [...new Set(held.map((h) => h.rule.id))],
        reason: 'quiet-hours',
      });
    } catch (err) {
      this.deps.log?.warn('a suppressed notification could not be recorded', {
        error: String(err),
      });
    }
  }
}
