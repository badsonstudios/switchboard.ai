// Notification rules — the pure core (P2-E14-03, §5.9).
//
// One sentence: **when [event] in [session | any], and the window is in one of
// [visibilities], do [actions]** — and, since P2-E14-05b, **unless the clock
// says the user asked for quiet**. Everything in this file is data and pure
// functions — no electron, no I/O, and **no clock of its own**: the time comes
// in on the trigger (`RuleTrigger.now`), injected from the one place that owns
// it (`RulesEngineDeps.now`), so every case below is a table test rather than a
// wait. The engine that runs the actions is `rules-engine.ts`; the wiring is
// `main/index.ts`.
//
// Why a rules engine at all, for what is currently one checkbox: because §5.9
// is a LIST of channels (toast, sound, TTS, taskbar flash, phone push,
// webhook) crossed with a list of events, and every one of them has the same
// three questions in front of it — which event, which session, and is the user
// even looking. Writing that crossing as `if` statements is how the third
// question ends up answered three different ways. E14-04/05/06 add ACTIONS to
// the registry (`rules-engine.ts`) and nothing else.
//
// **Scope is a CARD id, never a live session id.** A rule outlives the process
// it fires for — the card is the durable unit (`workspace/store.ts`), a live
// session is minted fresh on every resume — so a rule scoped to a live id
// would stop matching the moment the user restarted the session, which is
// exactly the population the "notify when done" checkbox exists for.
import type { FeedKind } from './feed';

/** Which feed event a rule listens for; `any` matches every attention event. */
export type RuleEventMatch = FeedKind | 'any';

/**
 * How much of the app the user can see right now.
 *
 * Three states, not a boolean, because §5.9's `when_hidden` condition and the
 * calm default are different questions: "don't pop a toast over the window the
 * user is already reading" (not `focused`) is not the same rule as "the app is
 * minimized, this is the only way they'll hear about it" (`hidden`).
 *
 * - `focused` — the window has OS focus. The user is looking at switchboard.
 * - `visible` — on screen, but focused elsewhere. They might not be looking.
 * - `hidden`  — minimized, hidden, or no window at all.
 */
export type WindowVisibility = 'focused' | 'visible' | 'hidden';

export const ALL_VISIBILITIES: readonly WindowVisibility[] = ['focused', 'visible', 'hidden'];

/**
 * "Only when the user isn't looking at us" — the calm default (§5.9), and the
 * shipped no-toast-while-focused behavior expressed as a CONDITION rather than
 * a special case in the notifier.
 */
export const WHEN_AWAY: readonly WindowVisibility[] = ['visible', 'hidden'];

/**
 * A thing to do when a rule fires.
 *
 * Deliberately open (`type` + payload) rather than a closed union: E14-04
 * (`os-toast` with Allow/Deny), E14-05 (`sound`, `speak`) and E14-06 (`push`,
 * `webhook`) each add one, and none of them should have to edit this type or
 * the matcher below. An action whose `type` nothing has registered is logged
 * and skipped (`rules-engine.ts`) — which is also what makes a workspace file
 * written by a NEWER build safe to load in an older one.
 */
export interface RuleAction {
  readonly type: string;
  readonly [key: string]: unknown;
}

/** The `os-toast` action's payload, the only built-in action in v1. */
export const ACTION_OS_TOAST = 'os-toast';

/**
 * The two actions that leave the machine (P2-E14-06, §5.9): a notification on
 * the user's phone, and one POST to an endpoint they own.
 *
 * **Both carry an empty payload, deliberately.** The destination — an ntfy
 * topic, a Pushover token, a webhook URL — is a credential, and a credential in
 * an action payload is a credential in the workspace file (§5.29 forbids
 * exactly that). The handler reads it from the OS credential store when it
 * fires: `events/push-actions.ts`.
 */
export const ACTION_PUSH = 'push';
export const ACTION_WEBHOOK = 'webhook';

/**
 * The two audio channels (P2-E14-05a, §5.9): a per-session cue, and a spoken
 * announcement of what wants you.
 *
 * **Both carry an empty payload, and for the same reason `push` does** — the
 * destination is not the rule's business. Which cue a card rings is a property
 * of the CARD (§5.11 files it with the identity kit, beside the title and the
 * accent), so the handler resolves it from the workspace when it fires. Putting
 * the cue name in the action would mean every rule scoped to a session carried
 * a copy of that session's sound, and changing the sound would mean rewriting
 * rules — the same trap, one aisle over.
 *
 * It also keeps the DEDUP key right (`plannedActions`): two rules that both ask
 * for "the sound" are one sound, which is what a person hearing it expects.
 */
export const ACTION_SOUND = 'sound';
export const ACTION_SPEAK = 'speak';

/**
 * Who an action is aimed at (P2-E14-05b) — the one fact quiet hours turn on.
 *
 * - `person` — it reaches a human through their senses: a popup on the screen,
 *   a cue from the speakers, a voice, a phone buzzing on a nightstand.
 * - `machine` — it reaches a program: one POST to an endpoint the user owns.
 *
 * Classified per ACTION rather than per rule on purpose. "Do not wake me" is a
 * statement about channels, not about which rule happened to ask: a rule that
 * toasts AND webhooks at 3am should do exactly one of those, and a per-rule
 * flag could not express that. It also means a new channel picks its side once,
 * here, beside its own constant — instead of every rule the user ever wrote
 * needing an edit when E14 adds one.
 */
export type ActionAudience = 'person' | 'machine';

/**
 * The table. Every built-in action, and which side it is on.
 *
 * `push` is `person` and that is the whole point of it: a phone buzzing in a
 * dark bedroom is the single most person-facing channel this app has. `webhook`
 * is the only `machine` one — see `quietHolds` for why that matters.
 */
export const ACTION_AUDIENCE: Readonly<Record<string, ActionAudience>> = {
  [ACTION_OS_TOAST]: 'person',
  [ACTION_SOUND]: 'person',
  [ACTION_SPEAK]: 'person',
  [ACTION_PUSH]: 'person',
  [ACTION_WEBHOOK]: 'machine',
};

/**
 * An action type this build does not know is treated as `person`.
 *
 * Not fail-open, deliberately, and this is the one place in the notification
 * stack where that is right: quiet hours are an explicit instruction from the
 * user for a window of time they are asleep in, and the cost of the two errors
 * is not symmetric — wrongly holding an unknown channel loses one line in the
 * digest, wrongly firing it wakes someone up. An unknown type has no registered
 * handler anyway (`rules-engine.ts` logs and skips it), so in practice this
 * decides the digest entry and nothing else.
 */
export function audienceOf(type: string): ActionAudience {
  return ACTION_AUDIENCE[type] ?? 'person';
}

/**
 * A quiet-hours window: local wall-clock, `"HH:MM"` 24h, end exclusive.
 *
 * **Wall clock, not instants** (§5.9). "22:00–07:00" means those numbers on the
 * clock on the wall, whatever the calendar is doing underneath — so it needs no
 * timezone field, follows the machine if the user flies somewhere, and resolves
 * across a DST boundary by the same rule a person would use reading a clock:
 * the hour that repeats in autumn is quiet twice, and the hour that does not
 * exist in spring is simply never inside the window. That is the honest reading
 * of what the user typed, and it is the only one that needs no explanation in
 * the manual.
 *
 * `start === end` is not a 24-hour window — it is an empty one, and the pref
 * writer refuses it, because a user cannot tell those two apart by looking.
 */
export interface QuietWindow {
  /** "HH:MM" 24h local */
  start: string;
  end: string;
}

/** Minutes since local midnight, or null if it is not an `"HH:MM"` at all. */
function minutesOfDay(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h >= 0 && h < 24 && min >= 0 && min < 60 ? h * 60 + min : null;
}

/**
 * Is this a wall-clock time a quiet window can use? `"22:00"`, not `"10pm"`.
 *
 * Exported because the pref WRITER has to refuse what the evaluator cannot
 * read: a `quietStart` of `"night"` that survived into the workspace file would
 * show as configured in the dialog and silence nothing at all, which is the
 * worst of the three possible outcomes.
 */
export function isQuietTime(s: unknown): s is string {
  return typeof s === 'string' && minutesOfDay(s) !== null;
}

/** Is `now` (a LOCAL Date) inside the window? Windows crossing midnight work. */
export function inQuietWindow(win: QuietWindow | null | undefined, now: Date): boolean {
  if (!win) return false;
  const start = minutesOfDay(win.start);
  const end = minutesOfDay(win.end);
  if (start === null || end === null || start === end) return false;
  // `getHours`/`getMinutes` are local by definition — the wall clock, which is
  // exactly what was configured. Never `getUTCHours`.
  const cur = now.getHours() * 60 + now.getMinutes();
  return start < end ? cur >= start && cur < end : cur >= start || cur < end;
}

export interface Rule {
  id: string;
  /** which event fires it */
  event: RuleEventMatch;
  /** a CARD id to scope to; absent = any session */
  session?: string;
  /** visibility states the rule may fire in; absent or empty = any */
  visibility?: WindowVisibility[];
  actions: RuleAction[];
  /** absent = enabled. An explicit `false` keeps the rule but silences it. */
  enabled?: boolean;
  /**
   * What quiet hours do to THIS rule (P2-E14-05b). Absent = whatever each of
   * its actions' audience says (`quietHolds`), which is the answer for nearly
   * every rule; this field exists for the two rules that are exceptions.
   *
   * - `'obey'` — held during quiet hours even if it only does machine-facing
   *   work. For the user whose webhook drives a light in the bedroom.
   * - `'ignore'` — fires during quiet hours even if it is person-facing. For
   *   the one session whose crash is worth waking up for.
   *
   * A statement about the RULE, so it covers every action in it: a rule is one
   * intent ("tell me about this, this way"), and quiet hours are a question
   * about that intent. Anyone needing the two halves treated differently writes
   * two rules, which is also what makes the digest readable.
   */
  quietHours?: QuietHoursMode;
  /**
   * Where the rule came from, so a UI can tell a rule it OWNS from one the
   * user wrote: `notify-when-done` is the per-session checkbox, `default:*`
   * are the built-ins synthesized from the notification prefs.
   */
  source?: string;
}

/** The per-rule quiet-hours override (`Rule.quietHours`). */
export type QuietHoursMode = 'obey' | 'ignore';

export const QUIET_HOURS_MODES: readonly QuietHoursMode[] = ['obey', 'ignore'];

/** What just happened, resolved into the things a rule asks about. */
export interface RuleTrigger {
  kind: FeedKind;
  /** the CARD the event belongs to; null when it could not be resolved */
  cardId: string | null;
  visibility: WindowVisibility;
  /**
   * The local wall-clock at the moment of the event (P2-E14-05b).
   *
   * The clock is a CONDITION now, so it has to be part of the trigger — but it
   * is handed in, never read here, and there is exactly one `new Date()` behind
   * it in the whole stack (`RulesEngineDeps.now`). That is what keeps the
   * evaluator a table test: "at 03:00, this is held" is an argument, not a
   * fake timer and not a sleep.
   *
   * Optional so a caller that does not care about quiet hours (a preview, an
   * older test) still type-checks; absent means "no time known", and
   * `quietHolds` then holds nothing.
   */
  now?: Date;
  /** the configured quiet window, or null when the user has not set one */
  quiet?: QuietWindow | null;
}

/** The `source` tag on the rules the per-session checkbox creates. */
export const NOTIFY_WHEN_DONE = 'notify-when-done';

/**
 * The rule the "notify when done" checkbox writes (§5.9, owner request
 * 2026-07-22).
 *
 * `done` in THIS card, only while the user is not looking at us. Its id is
 * derived from the card id so ticking the box twice cannot leave two rules
 * behind, and so removing it needs nothing but the card id.
 */
export function notifyWhenDoneRule(cardId: string): Rule {
  return {
    id: `${NOTIFY_WHEN_DONE}:${cardId}`,
    event: 'done',
    session: cardId,
    visibility: [...WHEN_AWAY],
    actions: [{ type: ACTION_OS_TOAST }],
    source: NOTIFY_WHEN_DONE,
  };
}

/** Is this card's "notify when done" box ticked? */
export function notifyWhenDoneFor(rules: readonly Rule[], cardId: string): boolean {
  return rules.some(
    (r) => r.source === NOTIFY_WHEN_DONE && r.session === cardId && r.enabled !== false
  );
}

/**
 * The built-in rules, synthesized from the global notification prefs — never
 * persisted, so flipping a pref changes behavior without rewriting user data.
 *
 * Two decisions are encoded here as conditions rather than branches. Both come
 * from §5.9; neither was actually in the code before this item, where the toast
 * fired for every attention event whenever `osToasts` was on:
 *
 * - **No toast while the window is focused.** A popup over the window the user
 *   is already reading is noise; the Events panel and the sound already told
 *   them (§5.9 signal model).
 * - **Crashes are excepted.** A session that DIED is not an attention event
 *   competing for the user's evening — it is a thing that is not coming back
 *   on its own, and it is worth a popup even if they are looking at another
 *   card in the same window.
 *
 * `done` is deliberately absent from the TOASTS: since this item it is
 * per-session opt-in via the checkbox, because a toast for every short turn is
 * noise (§5.9). That is a REDUCTION for anyone who had `osToasts` on — it is
 * called out in the manual and the changelog rather than left to be discovered.
 *
 * P2-E14-06 adds two more channels on the same terms — each with its own
 * switch, each synthesized here rather than persisted, and each independent of
 * the toasts: a user can have their phone buzz with desktop popups off, which
 * is the same "a control that silently did nothing because of another one
 * elsewhere would be a lie" decision the per-session checkbox is built on.
 */
export function defaultRules(prefs: {
  osToasts?: boolean;
  /** phone push is configured AND switched on (P2-E14-06) */
  push?: boolean;
  /** the generic webhook is configured AND switched on (P2-E14-06) */
  webhook?: boolean;
  /** per-session cues instead of the plain beep (P2-E14-05a) */
  sounds?: boolean;
  /** spoken announcements (P2-E14-05a) */
  speak?: boolean;
}): Rule[] {
  const rule = (
    channel: string,
    action: string,
    kind: FeedKind,
    visibility: readonly WindowVisibility[]
  ): Rule => ({
    id: `default:${channel}${kind}`,
    event: kind,
    visibility: [...visibility],
    actions: [{ type: action }],
    source: `default:${channel}${kind}`,
  });
  const out: Rule[] = [];
  if (prefs.osToasts) {
    const toast = (kind: FeedKind, vis: readonly WindowVisibility[]): Rule =>
      rule('', ACTION_OS_TOAST, kind, vis);
    out.push(
      toast('needs-input', WHEN_AWAY),
      toast('needs-permission', WHEN_AWAY),
      toast('crashed', ALL_VISIBILITIES)
    );
  }
  // Per-session sounds (P2-E14-05a). EVERY visibility, on purpose: this cue
  // REPLACES the unconditional beep in `notifier.ts` rather than joining it
  // (two sounds for one event is a bug, not a feature), so it has to fire
  // everywhere the beep did — including while the window is focused, where the
  // sound is the thing that tells you WHICH of eight cards just moved without
  // you looking away from the one you are reading.
  if (prefs.sounds)
    for (const kind of ['needs-input', 'needs-permission', 'crashed', 'done'] as const)
      out.push(rule('sound:', ACTION_SOUND, kind, ALL_VISIBILITIES));
  // Spoken announcements (P2-E14-05a) — WHEN AWAY, like the toast and unlike
  // the sound. A voice reading "Add markdown preview needs your input" at
  // someone who is looking straight at that card is telling them something they
  // can already see, in the slowest possible medium. The cue above is for the
  // desk; this one is for the other side of the room.
  if (prefs.speak)
    for (const kind of ['needs-input', 'needs-permission', 'crashed', 'done'] as const)
      out.push(rule('speak:', ACTION_SPEAK, kind, WHEN_AWAY));
  // Phone push (P2-E14-06). The same three events the toasts cover, and only
  // WHEN AWAY — including `crashed`, which the toast excepts. The exception is
  // right for a popup on the screen you are already looking at and wrong for a
  // phone in your pocket: if you are at the desk, you can see the card died.
  if (prefs.push)
    for (const kind of ['needs-input', 'needs-permission', 'crashed'] as const)
      out.push(rule('push:', ACTION_PUSH, kind, WHEN_AWAY));
  // The webhook is NOT a notification and is not conditioned like one: it goes
  // to a program, so it fires whatever the window is doing, and it includes
  // `done` — a consumer building a dashboard or a log wants the whole attention
  // stream, not the half of it the user happened to miss.
  if (prefs.webhook)
    for (const kind of ['needs-input', 'needs-permission', 'crashed', 'done'] as const)
      out.push(rule('webhook:', ACTION_WEBHOOK, kind, ALL_VISIBILITIES));
  return out;
}

/** Does this rule fire for this trigger? Event AND scope AND visibility. */
export function ruleMatches(rule: Rule, trigger: RuleTrigger): boolean {
  if (rule.enabled === false) return false;
  if (rule.event !== 'any' && rule.event !== trigger.kind) return false;
  // A session-scoped rule needs a card to compare against. An event whose card
  // could not be resolved is NOT "every card" — matching it would turn one
  // session's checkbox into a global one at exactly the moment we are least
  // sure what happened.
  if (rule.session !== undefined && rule.session !== trigger.cardId) return false;
  const vis = rule.visibility;
  if (vis && vis.length > 0 && !vis.includes(trigger.visibility)) return false;
  return rule.actions.length > 0;
}

export interface MatchedAction {
  rule: Rule;
  action: RuleAction;
}

/**
 * Every action the matching rules ask for, in rule order, **deduplicated**.
 *
 * Two rules asking for the identical action (the built-in `crashed` toast and
 * a user rule that also toasts on crash) must produce ONE toast, not two. The
 * key is the whole action payload, not just its type: two `push` actions
 * aimed at different phones are two different asks and both must go.
 *
 * **Which rule the survivor carries matters since P2-E14-05b**, because the
 * rule is what `quietHolds` reads the override off. Ties go to the first
 * matching rule — EXCEPT that a rule with an explicit `quietHours` beats one
 * without. The built-ins are evaluated first (`RulesEngine.plan` prepends
 * them), so without that exception a user who hand-wrote `quietHours: 'ignore'`
 * on a session-scoped toast rule would find the unscoped built-in toast rule
 * had already claimed the payload and their instruction silently did nothing.
 * An explicit setting beating a default is the only reading of "explicit" that
 * is worth anything.
 *
 * Two rules with CONFLICTING explicit overrides is a contradiction the user
 * wrote; the first one still wins, and nothing here tries to be clever about
 * which of the two they meant.
 */
export function plannedActions(rules: readonly Rule[], trigger: RuleTrigger): MatchedAction[] {
  const out: MatchedAction[] = [];
  const byKey = new Map<string, number>();
  for (const rule of rules) {
    if (!ruleMatches(rule, trigger)) continue;
    for (const action of rule.actions) {
      if (!action || typeof action.type !== 'string' || !action.type) continue;
      const key = actionKey(action);
      const at = byKey.get(key);
      if (at !== undefined) {
        // Same action, already planned. Adopt this rule only if it says
        // something about quiet hours that the incumbent does not.
        if (rule.quietHours !== undefined && out[at].rule.quietHours === undefined)
          out[at] = { rule, action };
        continue;
      }
      byKey.set(key, out.length);
      out.push({ rule, action });
    }
  }
  return out;
}

/**
 * Is it quiet hours right now, for this trigger? One question, one place.
 *
 * Separate from `quietHolds` below because the answer is also a fact the UI
 * wants ("quiet hours are on right now") and the engine logs.
 */
export function triggerIsQuiet(trigger: RuleTrigger): boolean {
  return !!trigger.now && inQuietWindow(trigger.quiet, trigger.now);
}

/**
 * Does quiet hours hold this action back? The heart of P2-E14-05b.
 *
 * **Suppression is not matching, and this function is deliberately not part of
 * `ruleMatches`.** The rule DID match — the event happened, the session was the
 * right one, the user was away. We are choosing not to make the noise. Keeping
 * the two separate is what lets the digest (#483) say the true thing, "your
 * rule fired and we held it until morning", rather than the rule silently
 * evaporating; and it keeps `ruleMatches` answering only the questions the user
 * wrote into the rule.
 *
 * The decision, in order:
 *
 * 1. Not inside the window (or no window configured) → nothing is ever held.
 * 2. `rule.quietHours` set → it wins, both ways. An explicit instruction beats
 *    a default, which is the only reason to have written it.
 * 3. Otherwise the ACTION's audience decides: `person` is held, `machine` is
 *    not.
 *
 * **Why the webhook goes out at 3am (the decision this item was asked to
 * make).** Quiet hours are a fact about a human being asleep. A webhook has no
 * ears: it reaches a program the user pointed at this app precisely so that
 * something would be watching while they are not. A log or a dashboard with a
 * hole in it every night from 22:00 to 07:00 is a broken log — and worse, it is
 * broken in a way whose cause is a *notification* setting three screens away,
 * which is the kind of coupling nobody debugs successfully at 9am. So the
 * default is: the phone, the speakers, the voice and the popup stop; the POST
 * goes. Anyone whose webhook really is a person-facing channel — it flashes a
 * lamp, it pages them — writes `quietHours: 'obey'` on that rule and gets the
 * old behavior back on the one rule that wanted it.
 *
 * Note this is a CHANGE from the shipped behavior, where quiet hours were a
 * global gate in `notifier.ts` above the whole engine and silenced everything
 * including the webhook. Called out in the manual and the changelog rather than
 * left to be discovered.
 */
export function quietHolds(rule: Rule, action: RuleAction, trigger: RuleTrigger): boolean {
  if (!triggerIsQuiet(trigger)) return false;
  if (rule.quietHours === 'ignore') return false;
  if (rule.quietHours === 'obey') return true;
  return audienceOf(action.type) === 'person';
}

/** Matched actions, split into the ones that run and the ones quiet hours held. */
export interface QuietSplit {
  run: MatchedAction[];
  held: MatchedAction[];
}

/**
 * Apply quiet hours to an already-matched plan.
 *
 * A second pass rather than a filter inside `plannedActions` so that BOTH lists
 * survive: the caller runs `run` and records `held`, and neither half can be
 * dropped by accident.
 */
export function splitQuiet(matched: readonly MatchedAction[], trigger: RuleTrigger): QuietSplit {
  const run: MatchedAction[] = [];
  const held: MatchedAction[] = [];
  for (const m of matched) (quietHolds(m.rule, m.action, trigger) ? held : run).push(m);
  return { run, held };
}

/** Stable identity for an action payload (key order must not matter). */
function actionKey(action: RuleAction): string {
  return JSON.stringify(
    Object.keys(action)
      .sort()
      .map((k) => [k, action[k]])
  );
}

/** The window facts `visibilityOf` needs — a BrowserWindow satisfies it. */
export interface VisibilityProbe {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  isVisible(): boolean;
  isFocused(): boolean;
}

/**
 * Read the window's visibility, defensively: any window that is gone, dead,
 * minimized or off-screen counts as `hidden`, which is the state that lets the
 * MOST channels through. Fail-open (P6) — if we cannot tell whether the user
 * can see the app, telling them twice beats not telling them at all.
 */
export function visibilityOf(win: VisibilityProbe | null | undefined): WindowVisibility {
  try {
    if (!win || win.isDestroyed()) return 'hidden';
    if (win.isMinimized() || !win.isVisible()) return 'hidden';
    return win.isFocused() ? 'focused' : 'visible';
  } catch {
    return 'hidden';
  }
}

/**
 * The visibility of the APP, not of one window (§5.9).
 *
 * A card popped out into its own window (E8) is the case that makes this more
 * than a rename: with the main window minimized and a popout focused, asking
 * only the main window returns `hidden` — and the rule then pops a toast for a
 * session the user is looking straight at, which is the exact thing the manual
 * promises it will not do. The inverse is just as wrong: a focused main window
 * would suppress the toast for a popped-out card hidden behind it.
 *
 * Most-visible wins, because every condition here is a question about the USER
 * ("can they see us?"), not about a particular frame. No windows at all is
 * `hidden`, same as a single dead one.
 */
export function visibilityAcross(
  wins: readonly (VisibilityProbe | null | undefined)[]
): WindowVisibility {
  let best: WindowVisibility = 'hidden';
  for (const w of wins) {
    const v = visibilityOf(w);
    if (v === 'focused') return 'focused';
    if (v === 'visible') best = 'visible';
  }
  return best;
}

/** Keep only rules this build can actually use (store + IPC input). */
export function isSaneRule(r: unknown): r is Rule {
  const x = r as Partial<Rule> | null;
  if (!x || typeof x !== 'object' || Array.isArray(x)) return false;
  if (typeof x.id !== 'string' || !x.id) return false;
  if (typeof x.event !== 'string') return false;
  if (x.session !== undefined && typeof x.session !== 'string') return false;
  if (x.visibility !== undefined) {
    if (!Array.isArray(x.visibility)) return false;
    if (!x.visibility.every((v) => ALL_VISIBILITIES.includes(v as WindowVisibility))) return false;
  }
  // An override this build cannot read is the difference between "held all
  // night" and "rang at 3am", so a rule carrying a bad one is dropped rather
  // than silently defaulted (P2-E14-05b).
  if (x.quietHours !== undefined && !QUIET_HOURS_MODES.includes(x.quietHours as QuietHoursMode))
    return false;
  if (!Array.isArray(x.actions)) return false;
  // An action with no `type` can never be dispatched, so a rule carrying one is
  // dropped rather than kept as a half-working rule. An EMPTY action list is
  // allowed through — it is storable and simply never matches (`ruleMatches`),
  // which is what a rules editor needs while a half-written rule is on screen.
  return x.actions.every(
    (a) => !!a && typeof a === 'object' && typeof (a as RuleAction).type === 'string'
  );
}
