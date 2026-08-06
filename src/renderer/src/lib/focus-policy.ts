// §5.8's FOCUS-STEALING POLICY (P2-E9-10; i3 `focus_on_window_activation`).
//
// E9-05 answered "does a session that needs a human come back on screen?".
// This module answers the question §5.8 deliberately kept separate from it:
// **may that session take the cursor out of whatever you are doing?**
//
// §5.8, verbatim: "a global setting with per-session override governing whether
// a session that finishes or needs attention may grab focus: `smart` (focus if
// its card is visible, else mark urgent — default) · `urgent` (never steal;
// lamp only) · `focus` (always) · `none`. Settles up front a question every
// notification system otherwise answers by accident."
//
// ── THE LADDER OF INTRUSION ─────────────────────────────────────────────────
//
// The four modes are ordered, loudest first, and each one is strictly quieter
// than the one above it. That ordering is the whole design: a user who does not
// like what one mode does knows exactly which way to move.
//
//   focus    reveal the card AND take focus, every time. The aggressive end —
//            "I am watching one thing and I want to be dragged to whatever
//            calls next."
//   smart    THE DEFAULT. A card that is already on screen takes focus; one
//            that is not is revealed (E9-05's contract, unchanged) but does NOT
//            take the cursor. This is i3's `smart`, and it is exactly today's
//            shipped behaviour plus the one thing that was missing: focusing
//            the card you can already see costs you nothing and saves a click.
//   urgent   never steal, and never rearrange the workspace either: the lamp
//            and the attention queue carry it, and nothing moves. "lamp only".
//   none     ignore the attention event entirely — no focus, no reveal, and no
//            place in the attention queue. The quiet room.
//
// ── WHAT `none` MEANS, since §5.8 does not say ──────────────────────────────
//
// §5.8 names `none` and glosses the other three. i3's own manual is the
// reference the bullet cites, and there `none` is "i3 will ignore the request
// (the window will neither be focused nor will the urgency hint be set)". That
// reading is also the only one that leaves `none` a job: if it still marked
// urgent it would be `urgent` under a second name.
//
// So: the ATTENTION REQUEST is ignored. Concretely a `none` session is dropped
// from the attention QUEUE — Ctrl+Space never stops there, and the Events
// panel's next-up highlight skips it.
//
// TWO THINGS IT DELIBERATELY DOES NOT TOUCH, both worth stating because the
// mode's name over-promises otherwise:
//
//   • The rail row, the urgency lamp and the strip's "N need you" count all
//     keep painting the session's real STATUS. That is not the urgency hint; it
//     is the session being LISTED, which i3 also keeps doing. Blanking it would
//     make a held permission invisible rather than quiet, and §4's fail-open
//     rule does not let a preference of ours make a session's true state
//     unknowable.
//   • Sound, the taskbar flash and OS toasts. Those are §5.9's notification
//     channels with their own global switch (the 🔔 chip) and their own future
//     rules engine; this setting is §5.8's, about the workspace. If the two
//     should ever be one control, that is a §5.9 item — and the user-facing
//     wording here says "keep it out of the queue" rather than "silence it"
//     precisely so nobody has to find that out by being beeped at.
//
// ── WHY `smart` STILL REVEALS ───────────────────────────────────────────────
//
// The item's done-when says "under `smart` a visible card focuses while a
// hidden one only marks urgent", which could be read as "smart suppresses the
// reveal". It does not, and must not: reveal-on-attention is its OWN §5.8
// bullet (E9-05, shipped and e2e-proven), this setting's own sentence is about
// whether a session "may grab FOCUS", and `smart` is the default — so reading
// it the other way would silently switch a shipped feature off for every user
// who never opens this setting. "Only marks urgent" is about the cursor.
//
// `urgent` and `none` DO suppress the reveal, because there is no honest way to
// read "never steal" or "ignore" as compatible with the workspace rearranging
// itself unasked. That is what makes them the quieter rungs.
//
// Pure by construction (no React, no dockview, no IPC): every rule below is a
// unit test rather than an e2e guess. The impure edges are the store (which
// holds the book) and lib/presentation-boot (which loads and saves it).

export type FocusPolicy = 'smart' | 'urgent' | 'focus' | 'none';

/** Loudest to quietest. The order the menus and the palette list in — see the
 *  ladder-of-intrusion note above; it is the reason there is an order at all. */
export const FOCUS_POLICY_ORDER: readonly FocusPolicy[] = ['focus', 'smart', 'urgent', 'none'];

/** §5.8 pins this: `smart` is the default. */
export const DEFAULT_FOCUS_POLICY: FocusPolicy = 'smart';

/**
 * The whole setting: one global default plus ONE override table.
 *
 * Two levels, not three. §5.8's presentation policy says "global default +
 * per-group and per-session overrides"; this bullet says "a global setting with
 * per-session override" and stops there. A group level is not implied by the
 * shape of its neighbour, and an unused level would still have to be persisted,
 * pruned, surfaced and explained.
 *
 * Cards are keyed by their DURABLE card id — never a live session id, which
 * churns on every resume and would silently drop the user's override the first
 * time a session restarted.
 */
export interface FocusBook {
  readonly global: FocusPolicy;
  /** card id -> policy */
  readonly cards: Readonly<Record<string, FocusPolicy>>;
}

/** Frozen and shared: the store's initial value must be one stable object, or
 *  every useSyncExternalStore snapshot over it re-renders forever. */
export const DEFAULT_FOCUS_BOOK: FocusBook = Object.freeze({
  global: DEFAULT_FOCUS_POLICY,
  cards: Object.freeze({}),
});

export const FOCUS_POLICY_KEY = 'focusPolicy';

function isFocusPolicy(v: unknown): v is FocusPolicy {
  return typeof v === 'string' && (FOCUS_POLICY_ORDER as readonly string[]).includes(v);
}

/**
 * Which policy governs this card. Session beats global; there is nothing else.
 *
 * One function so the rail menu's tick, the palette and the thing that actually
 * happens when a session calls are all reading the same answer.
 */
export function resolveFocusPolicy(book: FocusBook, cardId: string | undefined): FocusPolicy {
  const own = cardId ? book.cards[cardId] : undefined;
  if (isFocusPolicy(own)) return own;
  return isFocusPolicy(book.global) ? book.global : DEFAULT_FOCUS_POLICY;
}

/** The card's OWN override, if it has one — what the menu ticks, as opposed to
 *  what `resolveFocusPolicy` computes. "Follow the default" is its absence. */
export function focusOverride(book: FocusBook, cardId: string): FocusPolicy | undefined {
  const v = book.cards[cardId];
  return isFocusPolicy(v) ? v : undefined;
}

// ── the rule ────────────────────────────────────────────────────────────────

/**
 * What an attention event is allowed to do to the workspace.
 *
 * Four responses rather than two booleans, because the combinations that don't
 * exist should not be representable: "focus but don't reveal" is not a thing
 * (you cannot focus a card that has no panel), and "reveal but ignore" is a
 * contradiction. A closed set also makes the switch in the effect exhaustive.
 *
 *   focus    reveal the card into its slot AND focus it
 *   reveal   put the card back where it was; leave the cursor alone (E9-05)
 *   mark     touch nothing: the lamp and the attention queue carry it
 *   ignore   as `mark`, and drop it from the attention queue too
 */
export type AttentionResponse = 'focus' | 'reveal' | 'mark' | 'ignore';

/**
 * THE RULE. One table, four rows, and the only input besides the policy is
 * whether the session's card is visible.
 *
 * VISIBLE MEANS THE USER CAN SEE IT — dockview's `isVisible`, which is false
 * for the unselected tabs of a group. Deliberately not "is on the `expanded`
 * rung": by default every new card lands in ONE dockview group, so a rung test
 * would call three stacked sessions visible when two of them show nothing but a
 * tab label, and `smart` would flip the tab out from under whatever you were
 * typing in. That is the exact failure this setting exists to prevent, so
 * getting it wrong here would make the default mode the loudest one.
 *
 * The caller passes the answer rather than the panel, so this module stays free
 * of dockview and the one question lives at the one call site.
 *
 * i3's `smart` is "focus if the window is on an ACTIVE WORKSPACE, else set the
 * urgency hint". A dockview group's selected tab is our active workspace.
 */
export function attentionResponse(
  policy: FocusPolicy,
  opts: { visible: boolean }
): AttentionResponse {
  switch (policy) {
    case 'focus':
      return 'focus';
    case 'urgent':
      return 'mark';
    case 'none':
      return 'ignore';
    case 'smart':
    default:
      // an unknown value read from an old blob lands here too, and landing on
      // the DEFAULT is the fail-open answer (§4): our blind spot must never be
      // the reason a session grabs the screen.
      return opts.visible ? 'focus' : 'reveal';
  }
}

/** Does this response move the cursor? */
export function takesFocus(r: AttentionResponse): boolean {
  return r === 'focus';
}

/** Does this response put the card back on screen? `focus` implies it — you
 *  cannot focus a panel that is not there. */
export function revealsCard(r: AttentionResponse): boolean {
  return r === 'focus' || r === 'reveal';
}

/** May this session take a place in the attention queue? Everything except
 *  `ignore` does; see the `none` note in the header. */
export function marksUrgent(r: AttentionResponse): boolean {
  return r !== 'ignore';
}

/**
 * The events the attention queue is allowed to see.
 *
 * The one place `none` is enforced. Applied to the RAW feed before lib/queue
 * orders it, so every reader of the queue — Ctrl+Space, the "N waiting" count
 * that enables it, the Events panel's next-up highlight — is silenced by one
 * filter rather than three. The Events panel still LISTS a silenced session's
 * events: §5.12 draws the line at "the feed is the log, the queue is the to-do
 * list", and `none` takes a session off the to-do list, not out of the log.
 *
 * Returns the SAME ARRAY when nothing is silenced — the common case by a mile,
 * and the store publishes derived values by identity.
 */
export function attentionEvents<T extends { sessionId: string }>(
  events: readonly T[],
  policyOf: (sessionId: string) => FocusPolicy
): readonly T[] {
  // Through the RULE, not through a second `=== 'none'` test. Whether a mode
  // marks urgent is `attentionResponse`'s to say, and a fifth quiet mode added
  // there must not need a matching edit here to take effect. `visible` is false
  // because it cannot matter: no mode's urgency answer depends on it, and the
  // queue is a list of sessions, not of screens.
  const silent = (sessionId: string): boolean =>
    !marksUrgent(attentionResponse(policyOf(sessionId), { visible: false }));
  let silenced = false;
  for (const e of events) {
    if (silent(e.sessionId)) {
      silenced = true;
      break;
    }
  }
  if (!silenced) return events;
  return events.filter((e) => !silent(e.sessionId));
}

// ── immutable edits ─────────────────────────────────────────────────────────
// The store publishes by identity, so every edit returns a NEW book. Passing
// `undefined` removes an override rather than storing a fifth value: "follow
// the default" must be the absence of a record, or a later change to the global
// would not reach the sessions that never overrode it.

export function withFocusGlobal(book: FocusBook, policy: FocusPolicy): FocusBook {
  if (book.global === policy) return book;
  return Object.freeze({ ...book, global: policy });
}

export function withFocusCard(
  book: FocusBook,
  cardId: string,
  policy: FocusPolicy | undefined
): FocusBook {
  if (!cardId) return book;
  const cur = book.cards[cardId];
  if (isFocusPolicy(policy) ? cur === policy : cur === undefined) return book;
  const next = { ...book.cards };
  if (isFocusPolicy(policy)) next[cardId] = policy;
  else delete next[cardId];
  return Object.freeze({ ...book, cards: Object.freeze(next) });
}

/**
 * Drop overrides for cards that no longer exist.
 *
 * Returns null when there is nothing to drop, so the caller can skip a pointless
 * write and re-render — the same contract `prunePolicies` uses, and for the same
 * reason: a workspace must not accrete a record per session it ever opened.
 */
export function pruneFocusPolicies(
  book: FocusBook,
  knownCardIds: Iterable<string>
): FocusBook | null {
  const known = new Set(knownCardIds);
  const stale = Object.keys(book.cards).filter((id) => !known.has(id));
  if (stale.length === 0) return null;
  const cards = { ...book.cards };
  for (const id of stale) delete cards[id];
  return Object.freeze({ global: book.global, cards: Object.freeze(cards) });
}

// ── persistence ─────────────────────────────────────────────────────────────

/** One ui-blob record -> a full book. Anything unrecognised falls back to the
 *  default rather than throwing: a blob outlives the code that wrote it, and a
 *  stale value must never cost the user their workspace. */
export function loadFocusBook(raw: unknown): FocusBook {
  if (!raw || typeof raw !== 'object') return DEFAULT_FOCUS_BOOK;
  const r = raw as Record<string, unknown>;
  const out: Record<string, FocusPolicy> = {};
  if (r.cards && typeof r.cards === 'object') {
    for (const [key, value] of Object.entries(r.cards as Record<string, unknown>)) {
      if (key && isFocusPolicy(value)) out[key] = value;
    }
  }
  return Object.freeze({
    global: isFocusPolicy(r.global) ? r.global : DEFAULT_FOCUS_POLICY,
    cards: Object.freeze(out),
  });
}

/** The book, reduced to what goes in the blob. A book that says nothing the
 *  default doesn't already say writes nothing at all. */
export function persistableFocusPolicies(book: FocusBook): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  if (book.global !== DEFAULT_FOCUS_POLICY) out.global = book.global;
  if (Object.keys(book.cards).length > 0) out.cards = { ...book.cards };
  return Object.keys(out).length > 0 ? out : null;
}
