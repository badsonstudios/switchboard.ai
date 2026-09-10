// Messages other sessions have sent a card, waiting for the user (P2-E11-05).
//
// `send_to_session` never sends on its own (§5.4): main pushes the message
// here and the card's composer shows it as an attributed block the user can
// send with Enter or dismiss. This module is the "waiting" — nothing in it can
// submit anything, and nothing it is handed can ask it to.
//
// SHAPED LIKE THE DRAFT, deliberately (`composer-draft.ts` has the long
// version of every argument below):
//   * KEYED BY CARD, because the live session id churns on a resume and a
//     message filed under it would be orphaned by the very restart it has to
//     survive.
//   * A MODULE-LEVEL STORE, not component state — the composer unmounts on a
//     view-tab switch or a collapse, and a message must not live and die with
//     it. That is also what lets a message land on a card whose conversation is
//     not on screen: it waits here and appears when the composer mounts.
//   * PERSISTED in the workspace `ui` blob, and PRUNED with every other
//     card-keyed key at the boot sweep in `SessionGrid.tsx`.
//
// One difference from the draft: this writes with `uiSet`, not `uiSetSoon`.
// The SENDING agent is told "it is waiting in that session's message box" the
// moment `receiveSiblingMessage` returns, so the write it describes should not
// be riding a 400 ms timer a quit can outrun. These writes are rare; the
// debounce exists for keystrokes.
import { useSyncExternalStore } from 'react';
import { uiAll, uiDelete, uiGet, uiSet } from './ui-state';
import {
  SIBLING_INBOX_CAP,
  SIBLING_INBOX_CHAR_CAP,
  SIBLING_MESSAGE_CHAR_CAP,
  formatSiblingPrompt,
  hasUnsafeControl,
  markerRef,
  type SiblingAck,
  type SiblingSender,
} from '../../../shared/sibling-message';

/**
 * How long a message must have been ON SCREEN before an Enter sends it
 * (#765 review).
 *
 * Enter sends every waiting message along with the draft, under a header that
 * tells the receiving agent "the user reviewed it". A message that appeared a
 * split second before an Enter the user was already pressing for THEIR OWN
 * prompt was not reviewed by anyone, and forwarding it would make that header
 * false. So a message younger than this stays held for the next Enter. A
 * second is well past the gap between a message appearing and a keypress that
 * was already on its way, and well short of the time anyone reads one.
 *
 * ⚠️ MEASURED FROM WHEN THE COMPOSER FIRST SHOWED IT, NOT FROM ARRIVAL (round
 * 2). The first version stamped arrival, so a message that landed while the
 * card was on its Terminal tab — or that was restored after a relaunch — was
 * already "settled" the instant the user came back, and the first Enter sent
 * it unseen. Only the composer knows when it painted a block, so the clock
 * lives there and this module only does the arithmetic.
 */
export const SIBLING_SETTLE_MS = 1_000;

const PREFIX = 'siblingInbox.';

/** One message, as it waits in a card. `id` is the delivery id main minted. */
export interface HeldMessage {
  id: string;
  from: SiblingSender;
  text: string;
  /** ISO timestamp of the send */
  at: string;
}

export function inboxKey(cardId: string): string {
  return `${PREFIX}${cardId}`;
}

const EMPTY: readonly HeldMessage[] = Object.freeze([]);

/**
 * The last array handed out per card.
 *
 * `useSyncExternalStore` compares snapshots by identity, so handing back a
 * fresh array on every read would re-render every composer on every render —
 * or, worse, loop. The cache is invalidated only by writes through this module.
 */
const snapshots = new Map<string, readonly HeldMessage[]>();
/** cardId → the composers currently mounted for it — what makes a card "shown" */
const listeners = new Map<string, Set<() => void>>();
/**
 * cardId → surfaces that only COUNT what is waiting (the card's tab badge).
 * Kept apart from `listeners` on purpose: the card chrome is mounted whether
 * or not the conversation is, and counting it would report every card as
 * "shown" to the sender.
 */
const observers = new Map<string, Set<() => void>>();

function isHeldMessage(v: unknown): v is HeldMessage {
  if (!v || typeof v !== 'object') return false;
  const m = v as Record<string, unknown>;
  const from = m.from as Record<string, unknown> | null | undefined;
  return (
    typeof m.id === 'string' &&
    m.id !== '' &&
    typeof m.text === 'string' &&
    typeof m.at === 'string' &&
    !!from &&
    typeof from === 'object' &&
    typeof from.id === 'string' &&
    typeof from.name === 'string'
  );
}

/**
 * What is waiting on this card, oldest first.
 *
 * Tolerant of anything in the blob that is not a well-formed message — a
 * hand-edited workspace file, or a key a later build wrote — for the draft's
 * reason: a composer that throws on mount is a card you cannot use.
 */
export function heldMessages(cardId: string | undefined): readonly HeldMessage[] {
  if (!cardId) return EMPTY;
  const cached = snapshots.get(cardId);
  if (cached) return cached;
  const raw = uiGet<unknown>(inboxKey(cardId), undefined);
  const list = Array.isArray(raw) ? Object.freeze(raw.filter(isHeldMessage)) : EMPTY;
  snapshots.set(cardId, list);
  return list;
}

function write(cardId: string, next: readonly HeldMessage[]): void {
  snapshots.set(cardId, next.length === 0 ? EMPTY : Object.freeze([...next]));
  if (next.length === 0) uiDelete([inboxKey(cardId)]);
  else uiSet(inboxKey(cardId), next);
  for (const l of listeners.get(cardId) ?? []) l();
  for (const l of observers.get(cardId) ?? []) l();
}

/**
 * File a message main pushed, and say what became of it.
 *
 * Answers `null` for a payload that is not a message at all — not an ack, so
 * main's own deadline reports it as unconfirmed rather than this end claiming
 * something about a message it could not read. Unreachable from first-party
 * main; the guard is because this is a boundary.
 *
 * `shown` is whether a composer for the card is mounted right now — the fact
 * the SENDER is owed about how soon anyone will read it.
 */
export function receiveSiblingMessage(raw: unknown): SiblingAck | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  const cardId = m.cardId;
  if (typeof cardId !== 'string' || cardId === '') return null;
  const held = { id: m.deliveryId, from: m.from, text: m.text, at: m.at };
  if (!isHeldMessage(held)) return null;
  // Main refuses past this; a renderer that took more would be holding a
  // message whose sender was told it was too long.
  if (held.text.length > SIBLING_MESSAGE_CHAR_CAP) return null;
  // …and the same for control characters (#765 review, Blocker). Main
  // refuses them first; this is the second lock on the door that matters
  // most, because this text is what the user's Enter will send.
  if (hasUnsafeControl(held.text) || hasUnsafeControl(held.from.name)) return null;

  const now = heldMessages(cardId);
  // The same delivery twice is one message. Not reachable over one IPC push,
  // and cheap to make true rather than hoped for.
  if (now.some((h) => h.id === held.id)) return { placed: true, shown: isShown(cardId) };
  if (now.length >= SIBLING_INBOX_CAP) return { placed: false, reason: 'full' };
  const waitingChars = now.reduce((n, h) => n + h.text.length, 0);
  if (waitingChars + held.text.length > SIBLING_INBOX_CHAR_CAP) return { placed: false, reason: 'full' };
  write(cardId, [
    ...now,
    { id: held.id, from: { id: held.from.id, name: held.from.name }, text: held.text, at: held.at },
  ]);
  return { placed: true, shown: isShown(cardId) };
}

/**
 * The waiting messages an Enter pressed NOW may send — those the composer has
 * been SHOWING for at least `SIBLING_SETTLE_MS`. See that constant.
 *
 * `seenAt` is the composer's own record of when it first painted each block.
 * A message it has no record of has not been seen, and is not sent — the safe
 * direction, since the cost is one more Enter.
 */
export function settledMessages(
  messages: readonly HeldMessage[],
  seenAt: ReadonlyMap<string, number>,
  now: number = Date.now()
): HeldMessage[] {
  return messages.filter((m) => {
    const t = seenAt.get(m.id);
    return t !== undefined && now - t >= SIBLING_SETTLE_MS;
  });
}

/**
 * The prompt the user's Enter actually sends: each waiting message in its
 * attribution header, oldest first, then whatever the user typed.
 *
 * FORWARDED TEXT FIRST, the user's own last — the user's words are usually
 * about the message ("do this", "ignore the second part"), and read after it
 * they need no pointer back. The header itself is `formatSiblingPrompt`'s,
 * shared with main's automatic path, so a reviewed message and an automatic one
 * differ only in the sentence that says which they were.
 */
export function withForwarded(messages: readonly HeldMessage[], typed: string): string {
  // `m.id` is the delivery id main minted and NEVER returned to the sender, so
  // its first stretch is a marker ref the sender cannot forge.
  const parts = messages.map((m) => formatSiblingPrompt(m.from, m.text, 'user', markerRef(m.id)));
  if (typed !== '') parts.push(typed);
  return parts.join('\n\n');
}

/** Take these messages off the card — sent with the prompt, or dismissed. */
export function removeHeldMessages(cardId: string | undefined, ids: readonly string[]): void {
  if (!cardId || ids.length === 0) return;
  const drop = new Set(ids);
  const now = heldMessages(cardId);
  const next = now.filter((h) => !drop.has(h.id));
  if (next.length !== now.length) write(cardId, next);
}

function isShown(cardId: string): boolean {
  return (listeners.get(cardId)?.size ?? 0) > 0;
}

function subscribe(
  registry: Map<string, Set<() => void>>,
  cardId: string,
  cb: () => void
): () => void {
  let set = registry.get(cardId);
  if (!set) {
    set = new Set();
    registry.set(cardId, set);
  }
  set.add(cb);
  return () => {
    set.delete(cb);
    if (set.size === 0) registry.delete(cardId);
  };
}

/**
 * How many messages are waiting on a card — for chrome that is mounted
 * whether or not the conversation is (the Session tab's badge). Subscribes as
 * an OBSERVER, so it never makes a card count as shown.
 */
export function useHeldCount(cardId: string | undefined): number {
  return useSyncExternalStore(
    (cb) => (cardId ? subscribe(observers, cardId, cb) : () => {}),
    () => heldMessages(cardId).length
  );
}

/**
 * The composer's view of its card's inbox.
 *
 * SUBSCRIBING IS WHAT MAKES A CARD "SHOWN" — `isShown` counts mounted
 * composers, not visible pixels. A composer inside a background dockview tab
 * is still mounted (dockview detaches, it does not unmount), so a message to
 * it reports shown while the user is looking at a sibling tab. That is the
 * honest reading of what this can know, and it errs toward "the user will see
 * it soon" only for a card that is one click away.
 */
export function useHeldMessages(cardId: string | undefined): readonly HeldMessage[] {
  return useSyncExternalStore(
    (cb) => (cardId ? subscribe(listeners, cardId, cb) : () => {}),
    () => heldMessages(cardId)
  );
}

/** The inbox keys whose card is gone. Same shape and same empty-set rule as `staleDraftKeys`. */
export function staleInboxKeys(
  blob: Readonly<Record<string, unknown>>,
  known: ReadonlySet<string>
): string[] {
  if (known.size === 0) return [];
  return Object.keys(blob).filter((k) => k.startsWith(PREFIX) && !known.has(k.slice(PREFIX.length)));
}

/** Retire the inboxes of cards that no longer exist. */
export function pruneInboxes(known: ReadonlySet<string>): void {
  const stale = staleInboxKeys(uiAll(), known);
  for (const k of stale) snapshots.delete(k.slice(PREFIX.length));
  uiDelete(stale);
}

/** Tests only: forget the cached snapshots, as a fresh renderer would. */
export function resetInboxCacheForTests(): void {
  snapshots.clear();
  listeners.clear();
  observers.clear();
}
