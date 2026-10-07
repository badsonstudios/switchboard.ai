// The composer's "ask it to write the handoff" switch (#1126) — the two
// decisions that are about text and not about React.
//
// The switch appears only when the draft names ANOTHER session, because that is
// the only time there is somebody to ask. Which sessions a draft names is
// `findMentions`' answer — the same finder main resolves the draft with — over
// the same list the `@` popup offers, so the switch can never offer to ask a
// session the send would not have briefed.
//
// What it CANNOT know is whether main will refuse the name as ambiguous (two
// sessions sharing a title). It does not try: the switch names what was typed,
// the send is refused with `resolve`'s own reason exactly as it is today, and
// nothing is asked of anybody (main does a dry run first for that reason).
import type { SessionSummary } from '../../../shared/sessions';
import type { HandoffFallback, MentionHandoff } from '../../../shared/mention-prompt';
import { findMentions } from '../../../shared/mention-finder';

/**
 * The other sessions this draft names, by the name the list gives them — once
 * each, in the order they are first mentioned.
 *
 * A slash command names nobody: its arguments are not resolved at send either.
 */
export function namedOtherSessions(
  text: string,
  sessions: readonly SessionSummary[],
  ownSessionId: string
): string[] {
  if (text.startsWith('/')) return [];
  const others = sessions.filter((s) => s.id !== ownSessionId);
  if (others.length === 0) return [];
  const found = findMentions(text, [...others.map((s) => s.name), ...others.map((s) => s.id)]);
  const names: string[] = [];
  for (const m of found) {
    const hit = others.find((s) => s.id === m.name) ?? others.find((s) => s.name === m.name);
    if (hit && !names.includes(hit.name)) names.push(hit.name);
  }
  return names;
}

/**
 * A send that is out, waiting on other sessions to write.
 *
 * ── WHY THIS IS NOT COMPONENT STATE (found in review) ───────────────────────
 *
 * The guard that stops a second send (`beginSend` in `sibling-inbox.ts`) is
 * keyed by CARD and lives in a module, so it outlives the composer that set it.
 * The wait did not: a composer that remounted mid-wait came back showing the
 * switch, with no "Waiting…" line and no Cancel, while Enter was still being
 * swallowed for up to ninety seconds — and the old instance then sent anyway.
 * The two have to live in the same place for the same length of time.
 *
 * It also carries what the SEND was made with — the names it is waiting on and
 * the live session id it asked under — because both can change under a mounted
 * composer (the draft is editable, the card can be restarted), and Cancel has
 * to stop the wait that is actually out.
 */
export interface HandoffWait {
  /** the sessions being waited on, as the switch named them at send */
  readonly names: readonly string[];
  /** the live id the send was made under — what main keyed the wait on */
  readonly sessionId: string;
  /** Cancel was pressed: whatever comes back is not sent */
  cancelled: boolean;
}

const waits = new Map<string, HandoffWait>();
const waitListeners = new Set<() => void>();
const tell = (): void => waitListeners.forEach((l) => l());

export function subscribeHandoffWaits(listener: () => void): () => void {
  waitListeners.add(listener);
  return () => waitListeners.delete(listener);
}

/** The wait out for this card, if any. The SAME object until it ends — safe as a store snapshot. */
export function handoffWaitOf(cardKey: string): HandoffWait | undefined {
  return waits.get(cardKey);
}

export function beginHandoffWait(cardKey: string, sessionId: string, names: readonly string[]): HandoffWait {
  const wait: HandoffWait = { names: [...names], sessionId, cancelled: false };
  waits.set(cardKey, wait);
  tell();
  return wait;
}

/** End THIS wait — a later one for the same card is left alone. */
export function endHandoffWait(cardKey: string, wait: HandoffWait): void {
  if (waits.get(cardKey) !== wait) return;
  waits.delete(cardKey);
  tell();
}

/**
 * Mark the card's wait cancelled and hand it back, so the caller can tell main
 * under the id the wait was made with. Undefined when nothing is out.
 */
export function cancelHandoffWait(cardKey: string): HandoffWait | undefined {
  const wait = waits.get(cardKey);
  if (wait) wait.cancelled = true;
  return wait;
}

/** Test seam. */
export function resetHandoffWaitsForTests(): void {
  waits.clear();
  waitListeners.clear();
}

/**
 * Did this send get cancelled — by the button here, or as main reports it?
 *
 * BOTH, because they can disagree in the one direction that matters: a
 * composer that remounted has lost the click, and main still answers
 * `cancelled`. Either way the user said stop, and the prompt does not go.
 */
export function handoffWasCancelled(
  wait: HandoffWait | undefined,
  handoffs: readonly MentionHandoff[] | undefined
): boolean {
  return wait?.cancelled === true || (handoffs ?? []).some((h) => h.outcome === 'cancelled');
}

type Translate = (key: string, values?: Record<string, unknown>) => string;

/** the reasons that read the same to a person: there was nobody there to ask */
const GONE: ReadonlySet<HandoffFallback> = new Set<HandoffFallback>(['not-running', 'unreachable', 'ended']);

/**
 * What the line under the prompt box says once a send that asked for handoffs
 * has gone. One sentence per session, in the order they were named.
 *
 * `null` when nothing was asked — the caller keeps whatever notice it had.
 *
 * `cancelled` is not phrased here: a cancelled send does not go
 * (`handoffWasCancelled`), and the composer says that itself.
 */
export function handoffNotice(t: Translate, handoffs: readonly MentionHandoff[] | undefined): string | null {
  const said = (handoffs ?? []).filter((h) => h.outcome !== 'cancelled');
  if (said.length === 0) return null;
  const lines = said.map((h) => {
    const values = { name: h.name };
    if (h.outcome === 'written') return t('feedView.handoff.written', values);
    if (GONE.has(h.outcome)) return t('feedView.handoff.gone', values);
    return t(`feedView.handoff.${h.outcome}`, values);
  });
  return lines.join(' ');
}
