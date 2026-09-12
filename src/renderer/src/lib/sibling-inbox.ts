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
import { useCallback, useMemo, useRef, useSyncExternalStore } from 'react';
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

/**
 * Bumped on every write, so a surface watching MANY cards can tell whether the
 * map it built last render is still true (#774, `useHeldCounts`).
 *
 * `useSyncExternalStore` compares snapshots by identity, and a multi-card
 * snapshot has to be a fresh object — so without a cheap "has anything
 * changed at all" it would either allocate a new Map on every read (which is
 * an infinite render loop, not a slow one) or have to diff every card's
 * length. One counter, incremented in the one place that mutates.
 */
let version = 0;

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

/** Wake every surface watching this card — both registries, always. */
function notify(cardId: string): void {
  for (const l of listeners.get(cardId) ?? []) l();
  for (const l of observers.get(cardId) ?? []) l();
}

function write(cardId: string, next: readonly HeldMessage[]): void {
  version++;
  snapshots.set(cardId, next.length === 0 ? EMPTY : Object.freeze([...next]));
  if (next.length === 0) uiDelete([inboxKey(cardId)]);
  else uiSet(inboxKey(cardId), next);
  notify(cardId);
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
 *
 * `knownCard` is how this module learns that the card is still there (#774).
 * Main resolved the target and then sent the message over IPC; a card closed
 * in that window would otherwise be filed under, acked `placed: true`, and
 * swept away at the next boot — with the sender told all along that it was
 * waiting for someone. INJECTED rather than imported so this module keeps
 * having no idea what a card is; it holds messages, and the shell knows which
 * cards exist.
 *
 * Absent, every card is known — the honest reading of "nobody told me
 * otherwise", and what a caller that has no card list should get.
 */
export function receiveSiblingMessage(
  raw: unknown,
  knownCard?: (cardId: string) => boolean
): SiblingAck | null {
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

  // THE CARD HAS TO STILL BE THERE (#774). Ahead of the caps because a closed
  // card's inbox contents are beside the point — "it is full" would be a
  // reason about a box nobody owns.
  //
  // A PREDICATE THAT THROWS MEANS "KNOWN", not "gone": the cost of wrongly
  // holding is a message that waits in a card the user can still open, and the
  // cost of wrongly refusing is telling an agent its message went nowhere when
  // it is sitting in the composer. Those are not the same size, so the doubt
  // resolves toward the behaviour this had before the predicate existed.
  // (Note this is the opposite lean from `autoSubmitVerdict`'s unreadable
  // preference, and for the same underlying rule: fall toward the outcome that
  // needs a human keypress, never away from one.)
  let known = true;
  try {
    if (knownCard) known = knownCard(cardId) === true;
  } catch {
    known = true;
  }
  if (!known) return { placed: false, reason: 'gone' };

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

/**
 * Cards with a prompt submitted and not yet answered (#774, and its review).
 *
 * ⚠️ MODULE-LEVEL, KEYED BY CARD, FOR THE REASON EVERYTHING ELSE IN THIS FILE
 * IS. The guard began as a `useRef` inside the composer and the review found it
 * one tab-switch from useless: the composer unmounts on a view-tab switch or a
 * collapse, while BOTH things the guard protects outlive it — the attachments
 * are restored from their own module-level stash, and the held messages live
 * here. A remount therefore came back with a fresh `false`, the same
 * attachments on screen and the same messages still waiting, and the next Enter
 * sent all of it a second time. That is precisely the duplicate this item was
 * filed to stop, reached through the fix for it.
 *
 * So the flag lives beside the resource it protects, and outlives the component
 * exactly as far as that resource does.
 */
const sending = new Set<string>();

/** Is a prompt from this card already out and unanswered? */
export function isSendInFlight(cardId: string | undefined): boolean {
  return !!cardId && sending.has(cardId);
}

/**
 * Mark a send as out, and hand back the release.
 *
 * The release is idempotent and must be called on EVERY settlement, refusals
 * and rejections included: a guard that can stay stuck shut is worse than the
 * duplicate it prevents, because the user cannot clear it without closing the
 * card.
 */
export function beginSend(cardId: string | undefined): () => void {
  // `!cardId`, like every other entry point here — an empty string is not a
  // card, and the guard and the subscription must agree about that or one
  // would engage while the other never woke.
  if (!cardId) return () => {};
  sending.add(cardId);
  notify(cardId);
  return () => {
    if (!sending.delete(cardId)) return;
    notify(cardId);
  };
}

/**
 * Is a send out for this card, as a subscription?
 *
 * The composer greys its Send button on this. It has to be OBSERVED rather than
 * read once, because the component that started the send may not be the one
 * showing the button when it settles: a view-tab switch unmounts the composer
 * mid-flight, and the remount has to come back greyed and then un-grey itself
 * when the release lands in a closure belonging to a component that is gone.
 *
 * An observer subscription, like `useHeldCounts` — greying a button is not
 * reading a message, and must not tell the sending agent that anyone has.
 */
export function useSendInFlight(cardId: string | undefined): boolean {
  return useSyncExternalStore(
    (cb) => (cardId ? subscribe(observers, cardId, cb) : () => {}),
    () => isSendInFlight(cardId)
  );
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
    // `registry.get(cardId) === set` because this closure captures the Set it
    // joined, and a cleanup run after that Set was dropped and a NEW one made
    // would otherwise unregister the new one — deafening every current
    // subscriber for the card. Harmless while each card had one subscriber;
    // `useHeldCounts` now churns N of these whenever the rail's id list moves.
    if (set.size === 0 && registry.get(cardId) === set) registry.delete(cardId);
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
 * How many messages are waiting on EACH of these cards — for a surface that
 * shows many cards at once (the sessions rail, #774).
 *
 * An OBSERVER subscription per card, exactly like `useHeldCount`, so a rail
 * listing fifty cards does not report all fifty as "shown" to every sender.
 * That is the one property this hook exists to preserve and the one a
 * well-meaning `useHeldMessages` loop would destroy.
 *
 * ONE HOOK FOR THE WHOLE LIST rather than a `<Mark cardId>` child per row,
 * because the count has to reach the row BUTTON's accessible name, and that is
 * built in the parent. A child component could light the pixels and would
 * leave a screen-reader user with nothing — the rail's own idiom is that the
 * glyph is `aria-hidden` decoration and the fact lives in the button's label.
 */
export function useHeldCounts(cardIds: readonly string[]): ReadonlyMap<string, number> {
  // The ids as ONE value, so the callbacks below are stable while the rail
  // re-renders with an equal-but-new array — which it does on every status
  // tick. Card ids are opaque `crypto.randomUUID` strings, so the separator
  // only has to be something they cannot contain; SORTED, because a pure
  // reorder (a drag, a pin) changes nothing this hook reports and should not
  // resubscribe every row.
  const key = [...cardIds].sort().join(' ');

  // ⚠️ DERIVED BACK FROM `key`, rather than kept in a ref (#774 review).
  // Both callbacks below are memoised on `key`, so anything else they read has
  // to be a function of `key` too — a ref assigned during render can hold a
  // list from a render that was prepared and then abandoned (Suspense, a
  // transition), and if that list were shorter the cache would store a map
  // missing a card that IS on screen, and keep serving it until `version` next
  // moved. A mark that vanishes and stays vanished. `key` is a lossless
  // encoding of the set, so this round-trip is total.
  const ids = useMemo(() => (key === '' ? [] : key.split(' ')), [key]);
  const cache = useRef<{ version: number; key: string; map: ReadonlyMap<string, number> } | null>(
    null
  );

  const subscribeAll = useCallback(
    (cb: () => void) => {
      const offs = ids.map((id) => subscribe(observers, id, cb));
      return () => {
        for (const off of offs) off();
      };
    },
    [ids]
  );

  const snapshot = useCallback((): ReadonlyMap<string, number> => {
    const c = cache.current;
    // Both halves matter: `version` catches a message arriving or leaving, and
    // `key` catches a card being opened or closed with nothing else changing.
    if (c && c.version === version && c.key === key) return c.map;
    const map = new Map<string, number>();
    for (const id of ids) map.set(id, heldMessages(id).length);
    cache.current = { version, key, map };
    return map;
  }, [ids, key]);

  return useSyncExternalStore(subscribeAll, snapshot);
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
  // ...and any send still marked in-flight for a card that is gone (#774
  // review). `done()` rides the promise rather than the component, so a card
  // closed mid-send releases normally — but a `submitPrompt` that never
  // settles would otherwise leave a permanent entry, and nothing but this
  // sweep could ever clear it.
  if (known.size > 0) for (const id of sending) if (!known.has(id)) sending.delete(id);
  const stale = staleInboxKeys(uiAll(), known);
  if (stale.length === 0) return;
  // The counts a multi-card surface cached are about to be wrong, and this
  // path does not go through `write` (#774).
  version++;
  for (const k of stale) snapshots.delete(k.slice(PREFIX.length));
  uiDelete(stale);
}

/**
 * Tests only: forget the cached snapshots, as a fresh renderer would.
 *
 * Takes the in-flight sends with it — a held send left over from one test
 * would silently make the next one's first Enter a no-op, which is a failure
 * that reads like a bug in the code under test. One reset rather than two, so a
 * test file cannot adopt half of it.
 *
 * Note it CLEARS the registries rather than invoking the unsubscribes; nothing
 * is subscribed by the time a test tears down, and a stale callback here would
 * belong to an unmounted tree.
 */
export function resetInboxCacheForTests(): void {
  version++;
  snapshots.clear();
  listeners.clear();
  observers.clear();
  sending.clear();
}
