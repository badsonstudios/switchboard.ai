// The unsent prompt's ATTACHMENTS, kept (#546) — and the one thing about them
// that is deliberately not kept.
//
// #485 made typed-but-unsent composer TEXT outlive its component, because the
// component dies far more often than the user's intent does. It stopped at the
// text: the chips a paste (#475) or a drop (#476) produced stayed bare React
// state, so a card holding nothing but a pasted screenshot lost the whole
// prompt on a view-tab switch — the same class of loss, on a payload that is
// harder to recreate than words are.
//
// THE DECISION, AND THE THREE OPTIONS IT WAS MADE FROM
// ---------------------------------------------------
// **Bytes live in this module's memory for the life of the app run. The
// workspace `ui` blob holds only NAMES. Nothing is ever written to disk.** A
// remount keeps the chips; a relaunch drops them and SAYS SO, naming them.
//
//   1. *Bytes in the `ui` blob* — rejected on size, as #546 itself says. Eight
//      attachments of 5 MB each is a 40 MB string structure-cloned to main on
//      every push and re-serialized on every save, paid by every other
//      preference in the same blob.
//
//   2. *Bytes in the session `stateDir`, with references in the blob* — the
//      route #546 floats, and it does not fit, for a reason that is only
//      visible once you read #290's machinery (`main/sessions/session-state.ts`)
//      rather than assuming it. That directory is `<userData>/sessions/<SESSION
//      id>/`: it is named for the live session id, which `SessionManager.create`
//      mints fresh on every spawn, resume and restart, and `removeSessionStateDir`
//      deletes it at the session's death (its `onExit` and its `remove()`).
//      A draft is CARD-keyed precisely because the session id churns — that is
//      #485's whole argument for `cardId` — so putting one in there files it
//      under an id the next launch does not have, in a directory the sweep is
//      built to delete. Making it work means a NEW card-keyed store with a new
//      lifetime, a new sweep and a new IPC surface: not "reuse #290", and a
//      different-sized item.
//
//      And it would break a promise the manual has already made, in writing,
//      about these exact bytes: "Nothing is uploaded anywhere and no copy is
//      left on disk — the file's contents travel with your prompt and nowhere
//      else." A pasted screenshot silently persisted under the user data
//      directory until some future sweep decides otherwise is the definition of
//      writing user content somewhere surprising (local-first, DESIGN's hard
//      constraints).
//
//   3. *Text-only, announced* — the honest floor, and half of what shipped.
//
// WHY MEMORY IS ENOUGH FOR MOST OF IT. The three ways a draft gets lost are not
// equal, and only one of them needs disk:
//
//   * switching the card's view tab unmounts the Session panel (only
//     `panel-terminal` is `keepMounted`) — same run, same renderer realm;
//   * the stranded-popout rescue (#292) rebuilds the card from its record —
//     same run, same realm;
//   * quitting and relaunching — a new process.
//
// A pop-out is a fourth candidate and turns out not to be one at all: #545's
// e2e MEASURED that dockview MOVES the group's DOM and its React tree into the
// child window rather than rebuilding it, and a same-origin popout shares the
// opener's JS realm regardless — so this module's Map is the same Map there.
//
// So a module-level, card-keyed stash covers every same-run route completely,
// at zero disk cost, holding bytes that were already in this heap a moment ago.
// Only the relaunch loses them, it is the rarest of the three, and re-pasting a
// screenshot costs a keystroke where retyping three paragraphs costs a minute.
//
// WHAT THE BLOB HOLDS, AND WHY IT HOLDS ANYTHING. One key per card,
// `composerDraftAtt.<cardId>`, carrying the chips' NAMES and nothing else. It
// exists so the loss can be ANNOUNCED rather than silent: on the next launch
// the bytes are gone but the names are not, so the composer can say which files
// to attach again. Names are labels — smaller than the draft text already
// sitting beside them — and they are the whole of what reaches disk.
//
// THE INVARIANT THAT MAKES THE NOTICE WORK: names in the blob with no bytes in
// memory means "these were lost". It is true for both causes — a relaunch, and
// the retention cap below evicting an idle card — which is why the message
// names the files and states the rule instead of guessing at the reason.
import { uiAll, uiDelete, uiGet, uiSetSoon } from './ui-state';
import { MAX_ATTACHMENTS, type Attachment } from './composer-attachments';

const PREFIX = 'composerDraftAtt.';

/** One key per card, namespaced beside `composerDraft.<cardId>` (#485). */
export function attachmentDraftKey(cardId: string): string {
  return `${PREFIX}${cardId}`;
}

/**
 * A ceiling on the bytes this module will hold across ALL cards, counted in
 * payload characters (base64 for an image or a PDF, the decoded text for a
 * text file).
 *
 * Retention is the new cost. Today an unmounted composer's attachments are
 * garbage; once they are stashed they are not, and a user who pastes a
 * screenshot into each of twenty cards would keep every one of them alive for
 * the session. 48 MB of payload is ~10-40 real drafts and is never smaller
 * than ONE maxed-out card (8 × 5 MB = 40 MB), so the card being stashed is
 * always admitted — eviction only ever reaches cards nobody has touched since.
 *
 * Note a base64 string costs roughly twice this in heap (UTF-16), which is the
 * number to think with if this is ever raised.
 */
export const MAX_RETAINED_PAYLOAD_CHARS = 48 * 1024 * 1024;

/** A name is a label on a chip; anything longer did not come from `File.name`. */
const MAX_NAME_CHARS = 120;

interface Retained {
  attachments: Attachment[];
  chars: number;
}

/**
 * The bytes, per card. INSERTION-ORDERED, and that is load-bearing: every
 * stash deletes before it sets, so the iteration order is least-recently-
 * stashed first and eviction is a walk from the front.
 */
const retained = new Map<string, Retained>();

/** What one attachment actually costs to hold. */
function payloadChars(a: Attachment): number {
  return a.kind === 'text' ? a.text.length : a.data.length;
}

/** Drop the oldest OTHER cards until the total is back under the ceiling. */
function evictDownTo(keep: string): void {
  let total = 0;
  for (const entry of retained.values()) total += entry.chars;
  if (total <= MAX_RETAINED_PAYLOAD_CHARS) return;
  for (const [cardId, entry] of retained) {
    if (cardId === keep) continue;
    retained.delete(cardId);
    total -= entry.chars;
    // The names key is LEFT BEHIND on purpose: it is the record that says
    // something was here, and it is what turns this eviction into a notice on
    // that card's next mount instead of chips that quietly stopped existing.
    if (total <= MAX_RETAINED_PAYLOAD_CHARS) return;
  }
}

/**
 * Remember this card's attachments — bytes here, names in the blob.
 *
 * Called from an effect on every change to the strip, so it is cheap when
 * nothing changed: an identical array reference is the mount case (the state
 * was seeded from this very store) and returns without touching anything.
 *
 * An EMPTY strip DELETES both halves, and the blob half goes IMMEDIATELY
 * (`uiDelete`) rather than on `uiSetSoon`'s timer — the same asymmetry
 * `clearDraft` argues for. A send that cleared the chips but left their names
 * on a 400 ms fuse could be followed by a quit inside that window, and the next
 * launch would announce the loss of attachments the user successfully sent.
 */
export function stashAttachments(
  cardId: string | undefined,
  attachments: readonly Attachment[]
): void {
  if (!cardId) return; // no durable name to file it under — same rule as the text
  const key = attachmentDraftKey(cardId);
  const current = retained.get(cardId);
  if (current?.attachments === attachments) return;

  if (attachments.length === 0) {
    const had = retained.delete(cardId);
    if (had || uiAll()[key] !== undefined) uiDelete([key]);
    return;
  }

  let chars = 0;
  for (const a of attachments) chars += payloadChars(a);
  retained.delete(cardId); // re-inserted at the end: most recently stashed
  retained.set(cardId, { attachments: [...attachments], chars });
  evictDownTo(cardId);
  uiSetSoon(
    key,
    attachments.slice(0, MAX_ATTACHMENTS).map((a) => a.name.slice(0, MAX_NAME_CHARS))
  );
}

/**
 * The attachments this card had, or `[]`.
 *
 * Returns the STORED array, so a composer that mounts and immediately stashes
 * what it read back is a no-op rather than a push. Nothing mutates an
 * `Attachment[]` in place — the composer always replaces the array — so
 * handing the live one out is safe, and a copy would only defeat that check.
 */
export function loadStashedAttachments(cardId: string | undefined): Attachment[] {
  if (!cardId) return [];
  return retained.get(cardId)?.attachments ?? [];
}

/**
 * The names of attachments this card is recorded as having but whose bytes are
 * gone — a relaunch, or an eviction. `[]` when there is nothing to announce.
 *
 * PURE, deliberately: it is read from a `useState` initializer, which React
 * runs twice under StrictMode and may discard. The key is cleared by the
 * ordinary `stashAttachments([])` that the composer's own effect performs on
 * mount, so the notice is shown once without this function having a side
 * effect to double-fire.
 *
 * Tolerant of anything that is not an array of strings, for `loadDraft`'s
 * reason: a composer that throws on mount is a card you cannot use.
 */
export function lostAttachmentNames(cardId: string | undefined): string[] {
  if (!cardId) return [];
  if (retained.has(cardId)) return []; // the bytes are right here; nothing was lost
  const raw = uiGet<unknown>(attachmentDraftKey(cardId), undefined);
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((n): n is string => typeof n === 'string' && n.length > 0)
    .slice(0, MAX_ATTACHMENTS)
    .map((n) => n.slice(0, MAX_NAME_CHARS));
}

/**
 * The attachment-draft keys in `blob` whose card is gone. Same shape and same
 * empty-set rule as `staleDraftKeys`: "the card list failed to load" and "you
 * have no cards" are the same value, and only one of them makes deleting safe.
 */
export function staleAttachmentDraftKeys(
  blob: Readonly<Record<string, unknown>>,
  known: ReadonlySet<string>
): string[] {
  if (known.size === 0) return [];
  return Object.keys(blob).filter((k) => k.startsWith(PREFIX) && !known.has(k.slice(PREFIX.length)));
}

/**
 * Retire the attachment drafts of cards that no longer exist — the blob's names
 * AND the memory they refer to. Runs at the boot sweep beside `pruneDrafts`.
 */
export function pruneAttachmentDrafts(known: ReadonlySet<string>): void {
  const stale = staleAttachmentDraftKeys(uiAll(), known);
  uiDelete(stale);
  if (known.size === 0) return;
  for (const cardId of [...retained.keys()]) {
    if (!known.has(cardId)) retained.delete(cardId);
  }
}

/**
 * Forget every retained byte.
 *
 * The app has no reason to call this — the store dies with the process — but
 * the tests do: this Map outlives a React root the way it is meant to, so a
 * suite that mounts the same `cardId` twice would otherwise carry one test's
 * screenshot into the next one.
 */
export function resetAttachmentDrafts(): void {
  retained.clear();
}
