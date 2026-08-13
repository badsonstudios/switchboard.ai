// Notification rules — the pure core (P2-E14-03, §5.9).
//
// One sentence: **when [event] in [session | any], and the window is in one of
// [visibilities], do [actions]**. Everything in this file is data and pure
// functions — no electron, no I/O, no clock. The engine that runs the actions
// is `rules-engine.ts`; the wiring is `main/index.ts`.
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
   * Where the rule came from, so a UI can tell a rule it OWNS from one the
   * user wrote: `notify-when-done` is the per-session checkbox, `default:*`
   * are the built-ins synthesized from the notification prefs.
   */
  source?: string;
}

/** What just happened, resolved into the three things a rule asks about. */
export interface RuleTrigger {
  kind: FeedKind;
  /** the CARD the event belongs to; null when it could not be resolved */
  cardId: string | null;
  visibility: WindowVisibility;
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
 * `done` is deliberately absent: since this item it is per-session opt-in via
 * the checkbox, because a toast for every short turn is noise (§5.9). That is a
 * REDUCTION for anyone who had `osToasts` on — it is called out in the manual
 * and the changelog rather than left to be discovered.
 */
export function defaultRules(prefs: { osToasts?: boolean }): Rule[] {
  if (!prefs.osToasts) return [];
  const toast = (kind: FeedKind, visibility: readonly WindowVisibility[]): Rule => ({
    id: `default:${kind}`,
    event: kind,
    visibility: [...visibility],
    actions: [{ type: ACTION_OS_TOAST }],
    source: `default:${kind}`,
  });
  return [
    toast('needs-input', WHEN_AWAY),
    toast('needs-permission', WHEN_AWAY),
    toast('crashed', ALL_VISIBILITIES),
  ];
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
 */
export function plannedActions(rules: readonly Rule[], trigger: RuleTrigger): MatchedAction[] {
  const out: MatchedAction[] = [];
  const seen = new Set<string>();
  for (const rule of rules) {
    if (!ruleMatches(rule, trigger)) continue;
    for (const action of rule.actions) {
      if (!action || typeof action.type !== 'string' || !action.type) continue;
      const key = actionKey(action);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ rule, action });
    }
  }
  return out;
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
  if (!Array.isArray(x.actions)) return false;
  // An action with no `type` can never be dispatched, so a rule carrying one is
  // dropped rather than kept as a half-working rule. An EMPTY action list is
  // allowed through — it is storable and simply never matches (`ruleMatches`),
  // which is what a rules editor needs while a half-written rule is on screen.
  return x.actions.every(
    (a) => !!a && typeof a === 'object' && typeof (a as RuleAction).type === 'string'
  );
}
