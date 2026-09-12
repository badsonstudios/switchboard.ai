// A message one session sends another (P2-E11-05, §5.4 `send_to_session`).
//
// Shared because BOTH ends of the delivery read it: main builds the push and
// reads the acknowledgement, the renderer holds the message and — when the user
// presses Enter — wraps it in the header below. Two copies of that header would
// be two answers to "how does a forwarded message read to the agent that gets
// it", and the automatic path and the reviewed path would drift apart.
//
// ── THE SAFETY PROPERTY LIVES IN THIS FILE'S SHAPE ──────────────────────────
//
// §5.4's rule is that a sibling's message NEVER executes in the target without
// a human keypress, unless the user deliberately turned that off. The way this
// codebase keeps that rule is that `SiblingMessage` — the only thing main ever
// sends the window about a sibling's message — HAS NO FIELD THAT MEANS "SEND
// IT". The renderer can hold a message and show it; it cannot be told to
// submit one, because there is no way to say so. Auto-accept is decided in main
// (`sessions/delivery.ts`) and never crosses this wire.
//
// `delivery.test.ts` pins the payload's key set, so adding a `submit` here is a
// red test and a conversation rather than a quiet convenience.

/**
 * The longest message one session may send another, in characters.
 *
 * The same order as the read tools' caps (`OUTPUT_CHAR_CAP`) and for the same
 * reason pointed the other way: whatever is sent lands in the TARGET's context
 * window. Past it the send is REFUSED rather than cut — a truncated instruction
 * still reads as a complete one, and the sending agent can shorten its own text
 * far better than we can.
 */
export const SIBLING_MESSAGE_CHAR_CAP = 20_000;

/**
 * How many messages may wait in one card's composer at once.
 *
 * The bound on a sibling that sends in a loop to a session nobody is looking
 * at. Past it the send is refused with a reason — "ten messages are already
 * waiting for the user" is something an agent can act on, while an eleventh
 * block the user will scroll past is not.
 */
export const SIBLING_INBOX_CAP = 10;

/**
 * …and how many CHARACTERS may wait in one card, across all of them (#765
 * review). Ten messages at the full 20k is 200k characters of one card's
 * entry in the workspace `ui` blob, which is structure-cloned to main on every
 * push and re-serialized on every save — every OTHER preference pays for it.
 * The same ceiling `composer-draft.ts` puts on a draft, for the same reason.
 */
export const SIBLING_INBOX_CHAR_CAP = 100_000;

/**
 * `a-b` as a regex character-class range, built from code points.
 * `fromCodePoint`, not `fromCharCode`, so the astral ranges below (the tag
 * characters live above U+FFFF) are one character each under the `u` flag.
 */
function span(from: number, to: number): string {
  return `${String.fromCodePoint(from)}-${String.fromCodePoint(to)}`;
}

/**
 * Characters a sibling's message may NOT contain (#765 review, Blocker).
 *
 * The C0 and C1 controls other than tab and newline, DEL, and the Unicode
 * bidirectional overrides and isolates. Two separate reasons, one list:
 *
 *  - A TERMINAL-mode session receives the user's Enter as a bracketed paste
 *    (`renderer/lib/composer.ts`). A message carrying `ESC [201~` ends the
 *    paste early, and whatever follows arrives as KEYSTROKES — a carriage
 *    return that submits, a Shift+Tab that cycles the permission mode. The
 *    user pressed Enter once, on text that showed none of it.
 *  - The bidi controls reorder what is DISPLAYED without changing what is
 *    SENT, so the block the user reviews can say something different from the
 *    prompt the receiving agent reads.
 *
 * Either one makes the human keypress §5.4 relies on a keypress on something
 * the human could not see. REFUSED, not stripped: silently editing another
 * agent's words is its own small lie, and "send plain text" is an instruction
 * an agent can follow.
 *
 * Carriage returns ARE on the list, but `normalizeNewlines` runs first and
 * turns them into line feeds — a model writing `\r\n` is ordinary and
 * harmless, so it must not be refused. The list catches a CR that reached a
 * surface WITHOUT going through the normaliser, which is the case a second
 * lock exists for.
 *
 * ── AND THE INVISIBLE ONES (#765 review, round 2) ──────────────────────────
 *
 * A third family has the same shape: characters a PERSON cannot see and a
 * MODEL reads. Unicode tag characters (U+E0000–E007F) spell out ASCII
 * invisibly — "ASCII smuggling" — and the zero-width space, the direction
 * marks, the word joiner and invisible operators, the BOM, and the
 * supplementary variation selectors (U+E0100–E01EF) are all used to hide text
 * or data inside text. Refused for the reason above: the block the user
 * reviews must be the prompt the agent reads.
 *
 * DELIBERATELY STILL ALLOWED, because ordinary model output is full of them:
 * the zero-width JOINER and NON-JOINER (U+200D, U+200C — emoji sequences like
 * 👩‍💻, and Persian and Indic scripts) and the basic variation selectors
 * (U+FE00–FE0F — the U+FE0F in ❤️). Refusing those would refuse emoji.
 *
 * BUILT FROM CODE POINTS, the rule `renderer/lib/composer.ts` states for its
 * escape bytes: no control character may appear in a source file, and
 * `check:nul` fails the lint if one does.
 */
const UNSAFE_CLASS =
  span(0x00, 0x08) + // everything below tab
  span(0x0b, 0x1f) + // everything above newline, CR included
  span(0x7f, 0x9f) + // DEL and the C1 controls
  String.fromCodePoint(0x200b) + // zero-width space
  span(0x200e, 0x200f) + // left-to-right / right-to-left marks
  span(0x202a, 0x202e) + // bidi embeddings and overrides
  span(0x2060, 0x2064) + // word joiner, invisible operators
  span(0x2066, 0x2069) + // bidi isolates
  String.fromCodePoint(0xfeff) + // BOM / zero-width no-break space
  span(0xe0000, 0xe007f) + // tag characters — invisible ASCII
  span(0xe0100, 0xe01ef); // supplementary variation selectors
const UNSAFE = new RegExp(`[${UNSAFE_CLASS}]`, 'u');
const UNSAFE_ALL = new RegExp(`[${UNSAFE_CLASS}]`, 'gu');

/** `\r\n` and a lone `\r` become `\n` — see `UNSAFE`. */
export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

/** Does this text contain anything on the `UNSAFE` list? Run after `normalizeNewlines`. */
export function hasUnsafeControl(text: string): boolean {
  return UNSAFE.test(text);
}

/**
 * The loop breaker for sessions that accept siblings' messages automatically.
 *
 * §5.4 names the default-off toggle as the thing that stops runaway loops, and
 * it does — for everyone who leaves it off. A user who turns it on for BOTH
 * sessions of a pair has built exactly the loop it guards against, usually
 * without meaning to. So even with it on, a session takes at most this many
 * automatic sends in `AUTO_ACCEPT_WINDOW_MS`; past that a message waits in the
 * composer for a person, and the sender is told why.
 *
 * Sized for a deliberate pipeline, where a step takes minutes, and against a
 * loop, where two agents trade messages every few seconds. A limit that bites
 * falls back to the SAFE behaviour — the one every session has by default — so
 * erring low costs one Enter press, and erring high costs tokens.
 *
 * Here rather than in `main/sessions/delivery.ts`, which enforces it, because
 * the card menu's hint QUOTES it to the user.
 */
export const AUTO_ACCEPT_LIMIT = 5;
export const AUTO_ACCEPT_WINDOW_MS = 10 * 60_000;

/** Who sent it, as the target's user and agent will see it. */
export interface SiblingSender {
  /** the sender's LIVE session id — what a reply would have to address */
  id: string;
  /** the sender's card title, the name `list_sessions` reports */
  name: string;
}

/**
 * main → renderer: hold this message in a card's composer.
 *
 * ⚠️ READ THE HEADER BEFORE ADDING A FIELD. Everything here is something to
 * SHOW. Nothing here may mean "send it".
 */
export interface SiblingMessage {
  /** correlates the renderer's acknowledgement with the waiting tool call */
  deliveryId: string;
  /** the CARD, because that is what the composer and its draft are keyed by */
  cardId: string;
  from: SiblingSender;
  text: string;
  /** ISO timestamp of the send */
  at: string;
}

/**
 * renderer → main: what became of it.
 *
 * `shown` is whether a composer for that card is on screen right now. It is
 * reported to the SENDING agent, because "it is waiting in a box the user is
 * looking at" and "it is waiting in a card that is collapsed" are different
 * facts about how soon anyone will read it.
 *
 * The two refusals are different facts too, and the sender is told which
 * (#774). `full` is "that card is holding all it can, try later"; `gone` is
 * "there is no such card any more" — a retry to the same session is pointless
 * and the message needs to go somewhere else, or nowhere.
 */
export type SiblingAck =
  | { placed: true; shown: boolean }
  | { placed: false; reason: 'full' | 'gone' };

/** Guard for the acknowledgement, which crosses from the renderer untyped. */
export function isSiblingAck(v: unknown): v is SiblingAck {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const a = v as Record<string, unknown>;
  if (a.placed === true) return typeof a.shown === 'boolean';
  return a.placed === false && (a.reason === 'full' || a.reason === 'gone');
}

/**
 * Who let the message through — the fact the receiving agent is owed.
 *
 * `user`: it sat in the composer and a person pressed Enter on it.
 * `automatic`: the user switched this session to accept siblings' messages
 * without review, and nobody looked at this one.
 */
export type ForwardedBy = 'user' | 'automatic';

/**
 * A name fit to sit inside one line of the header, whatever the card is called.
 *
 * EXPORTED so main applies it to the sender's name BEFORE the push (#765
 * review, round 2): the renderer refuses a name containing an `UNSAFE`
 * character as its second lock, so main sending one raw would make every
 * message from a session with, say, a direction mark in its title fail as
 * "unconfirmed" — every time, and for a reason nobody would guess.
 */
export function cleanSenderName(s: string): string {
  return oneLine(s);
}

function oneLine(s: string): string {
  // Controls go too (#765 review): a card title is the user's, but it lands
  // inside a header another agent reads, and an ESC in it would be the same
  // hazard `UNSAFE` refuses in the message body.
  const flat = s.replace(UNSAFE_ALL, '').replace(/\s+/g, ' ').trim();
  return flat === '' ? '(unnamed)' : flat;
}

/**
 * The text the receiving agent actually gets.
 *
 * DELIMITED AND ATTRIBUTED, and deliberately NOT labelled "data, not
 * instructions" the way the read tools fence a sibling's transcript
 * (`bus-tools.ts` → `quoted`). Those tools return content nobody asked the
 * reader to act on; this is a message whose whole purpose is usually to ask for
 * something, and a label telling the recipient to ignore it would make the
 * feature pointless. What the recipient IS owed is where it came from and
 * whether a human let it through — so it can weigh "another agent asked for
 * this and nobody reviewed it" accordingly.
 *
 * ── THE MARKERS CARRY A REFERENCE THE SENDER NEVER SEES (#765 review) ──────
 *
 * Without it, a message could contain its own `[End of message …]` line
 * followed by a forged header claiming "the user reviewed it" — and on the
 * automatic path nobody reads the text first, so the receiving agent would be
 * handed a false answer to the ONE question this header exists to answer.
 * `ref` is a random token minted per delivery that the sending agent is never
 * told, so a forged end marker cannot match the real one. Still a labelling
 * convention, not a cryptographic guarantee — but no longer one a message can
 * impersonate by guessing.
 */
export function formatSiblingPrompt(
  from: SiblingSender,
  text: string,
  how: ForwardedBy,
  ref: string
): string {
  const name = oneLine(from.name);
  const who =
    how === 'user'
      ? 'The user reviewed it and sent it on to you.'
      : 'It was delivered automatically — the user lets this session accept messages from ' +
        'other sessions without reviewing them.';
  // "…ends at the matching line" (round 2): a forged header carries a ref of
  // its own invention and would otherwise look exactly like a real one — the
  // recipient has to be told WHICH ref counts, and the real header says so first.
  return (
    `[Message ${ref} from another switchboard session, "${name}" (session id ${from.id}). ${who} ` +
    `It ends at the matching "End of message ${ref}" line.]\n` +
    `${text}\n` +
    `[End of message ${ref} from "${name}".]`
  );
}

/**
 * The marker reference for a delivery — the first stretch of an id the sender
 * was never told (`deliveryId` in the renderer, a fresh UUID on main's
 * automatic path). Eight hex characters: unguessable for this purpose, short
 * enough not to cost a reader anything.
 */
export function markerRef(unseenId: string): string {
  const hex = unseenId.replace(/[^0-9a-f]/gi, '');
  return hex.slice(0, 8) || 'ref';
}
