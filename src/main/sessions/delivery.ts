// `send_to_session`'s delivery policy (P2-E11-05, §5.4 "Delivery policy").
//
// The one tool in E11 that WRITES into another session, and so the only one
// that can start a loop: A tells B something, B's agent answers A, A's agent
// answers B, and two sessions burn a subscription talking to each other with
// nobody watching. §5.4's answer is the rule this module exists to keep:
//
//   A SIBLING'S MESSAGE NEVER EXECUTES IN THE TARGET WITHOUT A HUMAN KEYPRESS,
//   unless the user deliberately switched that session to accept them.
//
// ── HOW THE RULE IS KEPT: MAIN DECIDES, THE WINDOW ONLY HOLDS ───────────────
//
// There are exactly two things a delivery can do, and they go through two
// different doors:
//
//   * HOLD — push the message to the window (`deps.push`), which files it in
//     the card's composer as an attributed block. Only the user's Enter sends
//     it. The payload (`shared/sibling-message.ts`) has no field that means
//     "send", so no renderer bug can promote a hold into a send.
//   * SUBMIT — `deps.submit`, i.e. `SessionManager.submitPrompt`. Called from
//     ONE place below, behind `autoSubmitVerdict`, which is false unless the
//     card's own auto-accept flag is on.
//
// So "toggle off ⇒ never submitted" is a property of which function is called,
// and `delivery.test.ts` asserts it by counting calls to `submit` rather than
// by inspecting the text that arrived — a test that only checked the message
// landed would pass on a version that auto-sends.
//
// ── NEVER SILENTLY DROPPED ─────────────────────────────────────────────────
//
// Every path ends in one of: submitted; held (with whether it is on screen, and
// why it was held if the user had asked for automatic); refused with a reason;
// or — the one honest hedge — "handed to the window and not confirmed". The
// sending agent can always tell "delivered" from "went nowhere", which is the
// done-when this item was filed with.
//
// TRANSPORT-FREE like `queries.ts`: no Electron, no IPC, no MCP. The window and
// the manager arrive as functions, so every branch here is unit-testable and
// `check:bus` can drive the real class through the real bus child.
import crypto from 'crypto';
import type { Logger } from '../log/logger';
import type { SessionStatus } from '../../shared/sessions';
import {
  AUTO_ACCEPT_LIMIT,
  AUTO_ACCEPT_WINDOW_MS,
  SIBLING_MESSAGE_CHAR_CAP,
  cleanSenderName,
  formatSiblingPrompt,
  hasUnsafeControl,
  isSiblingAck,
  markerRef,
  normalizeNewlines,
  type SiblingAck,
  type SiblingMessage,
  type SiblingSender,
} from '../../shared/sibling-message';
import type { QueryResult, SessionSummary } from './queries';

/**
 * How long the window has to confirm it is holding the message.
 *
 * An IPC round trip is milliseconds; this is sized for a renderer that is
 * janking (#742's long-history freeze was seconds), not for the normal case.
 *
 * ── THE CASCADE, WHICH IS THE WHOLE POINT ──────────────────────────────────
 *
 *   this (8 s) < host answer deadline (12 s) < child slow tool (15 s)
 *
 * If the host's own deadline fired first, the agent would be told "switchboard
 * took too long and gave up" — a flat claim that nothing happened, about a
 * message the window may by then be showing. This one fires first and says the
 * true thing: handed over, not confirmed. `delivery.test.ts` pins the order.
 */
export const DELIVERY_ACK_TIMEOUT_MS = 8_000;

// The loop breaker's numbers live in `shared/sibling-message.ts` — the card
// menu quotes them to the user, and a hint that disagrees with the limit it
// describes is its own small lie. Re-exported so this module reads whole.
export { AUTO_ACCEPT_LIMIT, AUTO_ACCEPT_WINDOW_MS };

/**
 * States in which an automatic send may go straight in.
 *
 * `working` is included because the Direct transport QUEUES a message written
 * mid-turn (S-11 watched one picked up 144 s after it was written) — the
 * sibling's message is read when the current turn ends, which is what a
 * pipeline wants. `needs-input` and `needs-permission` are NOT: the session is
 * waiting on the user for something specific, and a sibling's message arriving
 * as the next user turn is the wrong answer to a question it did not ask.
 * `starting` is not either — there is no conversation yet to queue into.
 */
const AUTO_SUBMIT_STATUSES: ReadonlySet<SessionStatus> = new Set<SessionStatus>(['idle', 'done', 'working']);

/** Why a message the user had asked to take automatically was held instead. */
export type HeldReason =
  /** Terminal mode — see `autoSubmitVerdict` */
  | 'terminal'
  /** waiting on the user, or not started — see `AUTO_SUBMIT_STATUSES` */
  | 'not-ready'
  /** the loop breaker — see `AUTO_ACCEPT_LIMIT` */
  | 'limit';

/**
 * What became of a send. Rendered for the sending agent by `bus-tools.ts`.
 *
 * `unconfirmed` is not a refusal: the window was handed the message and did not
 * answer in time, so it may be showing it. Saying "not delivered" there would
 * be the confident wrong answer this whole bus is built to avoid, in the other
 * direction.
 */
export type DeliveryReceipt =
  | { session: SessionSummary; outcome: 'submitted' }
  | {
      session: SessionSummary;
      outcome: 'held';
      /** a composer for that card is on screen */
      shown: boolean;
      /** set only when the card accepts automatically and this one was held anyway */
      held?: HeldReason;
      /** the breaker's numbers, when `held` is 'limit' */
      limit?: { count: number; minutes: number };
    }
  | { session: SessionSummary; outcome: 'unconfirmed' };

export interface DeliveryDeps {
  /** `SessionQueries.resolve` — id first, refuses an ambiguous name */
  resolve(ref: string): QueryResult<SessionSummary>;
  /** live session id → the card it belongs to */
  cardIdFor(liveId: string): string | null;
  /** the card's own "accept messages from other sessions automatically" flag */
  acceptsSiblings(cardId: string): boolean;
  /**
   * Send a prompt on the session's own typed-message transport.
   *
   * `SessionManager.submitPrompt`: FALSE for a Terminal-mode session, and this
   * module does not fall back to typing into the PTY — see `autoSubmitVerdict`.
   */
  submit(liveId: string, text: string): boolean;
  /** Hand the message to the window. FALSE when there is no window to hold it. */
  push(message: SiblingMessage): boolean;
  log: Logger;
  /** Absent = `DELIVERY_ACK_TIMEOUT_MS`. A test seam. */
  ackTimeoutMs?: number;
  /** Absent = `Date.now`. A test seam for the breaker's window. */
  now?: () => number;
}

type Handover = { kind: 'ack'; ack: SiblingAck } | { kind: 'timeout' } | { kind: 'no-window' };

/** The subset `BusHost` calls — a `Pick`, so a rename is a compile error there. */
export type BusDelivery = Pick<SiblingDelivery, 'send'>;

export class SiblingDelivery {
  /** deliveryId → the waiting send's resolver */
  private readonly pending = new Map<string, (h: Handover) => void>();
  /**
   * target cardId → timestamps of its automatic sends, oldest first.
   *
   * IN MEMORY, so an app restart forgets it. Deliberate: a restart ends every
   * session, and a loop needs both ends running to continue — so the only
   * thing a restart can "reset" is a limit on sessions that are no longer
   * talking. Keyed by CARD rather than live id so restarting one SESSION does
   * not reset its count.
   */
  private readonly autoAccepted = new Map<string, number[]>();

  constructor(private readonly deps: DeliveryDeps) {}

  /**
   * Deliver `message` from `callerId` to the session `ref` names.
   *
   * Never throws and never rejects: every failure is a refusal with a reason
   * the SENDING AGENT reads, because it arrives as tool content.
   */
  async send(callerId: string, ref: unknown, raw: unknown): Promise<QueryResult<DeliveryReceipt>> {
    // The message is JSON a model composed, so its type is a claim, not a fact.
    if (typeof raw !== 'string') return { ok: false, reason: 'the message must be text' };
    const message = normalizeNewlines(raw);
    if (message.trim() === '') return { ok: false, reason: 'the message is empty' };
    // CONTROL CHARACTERS ARE REFUSED (#765 review, Blocker) — see `UNSAFE` in
    // `shared/sibling-message.ts`. A terminal escape in here would turn the
    // user's one reviewed Enter into keystrokes they never saw.
    if (hasUnsafeControl(message)) {
      return {
        ok: false,
        reason:
          'the message contains control characters (terminal escape codes or invisible ' +
          'text-direction marks), which could act on the other session without the user seeing ' +
          'them — send it again as plain text',
      };
    }
    if (message.length > SIBLING_MESSAGE_CHAR_CAP) {
      return {
        ok: false,
        reason:
          `the message is ${message.length.toLocaleString('en-US')} characters, and the limit is ` +
          `${SIBLING_MESSAGE_CHAR_CAP.toLocaleString('en-US')} — shorten it and send again`,
      };
    }

    // `resolve` type-guards `ref` and refuses a non-string with a reason, so the
    // cast is over a check that exists — the same one `BusHost.answer` relies on.
    const found = this.deps.resolve(ref as string);
    if (!found.ok) return found;
    const target = found.value;

    // SELF FIRST, before liveness: "you cannot message yourself" is the answer
    // whether or not you happen to be alive, and it is the shortest loop there is.
    if (target.id === callerId) {
      return { ok: false, reason: 'that is this session — a session cannot send a message to itself' };
    }
    // `exited`, NOT `status` and NOT membership. `list()` keeps an exited
    // session's record until the reap (#187) so its output stays readable, and
    // a clean exit is `status: 'done'` — the same word as a finished turn. See
    // `SessionSummary.exited`. `crashed` is checked too because it is terminal
    // by construction, and a belt costs nothing here.
    if (target.exited || target.status === 'crashed') {
      return {
        ok: false,
        reason:
          `${label(target)} has exited, so it cannot receive messages. Its earlier output can ` +
          'still be read with get_session_output; the user would have to restart it first.',
      };
    }
    const cardId = this.deps.cardIdFor(target.id);
    if (!cardId) {
      // Not reachable through the UI — every live session is bound to a card
      // before it can be listed. Refused rather than guessed, because the card
      // is what the composer is keyed by and there is nowhere else to put it.
      this.deps.log.warn('send_to_session: a live session with no card', { sessionId: target.id });
      return { ok: false, reason: `${label(target)} has no message box switchboard can reach` };
    }

    const from = this.sender(callerId);

    // ── The ONE call to `submit` in this module. ──
    const verdict = this.autoSubmitVerdict(cardId, target);
    if (verdict.go) {
      let took = false;
      try {
        // A FRESH ref, never returned to the sender — see `formatSiblingPrompt`.
        const unseen = markerRef(crypto.randomUUID());
        took = this.deps.submit(target.id, formatSiblingPrompt(from, message, 'automatic', unseen));
      } catch (err) {
        this.deps.log.error('send_to_session: automatic submit threw', {
          sessionId: target.id,
          error: String(err),
        });
      }
      if (took) {
        this.recordAutoAccept(cardId);
        this.deps.log.info('sibling message submitted automatically', {
          from: callerId,
          to: target.id,
          chars: message.length,
        });
        return { ok: true, value: { session: target, outcome: 'submitted' } };
      }
      // `submit` said no — the session is on a transport that does not take
      // typed messages after all. Held, never dropped; reported as Terminal
      // mode because that is the only thing `submitPrompt` refuses for.
      return this.hold(target, cardId, from, message, { held: 'terminal' });
    }
    // Picked field by field: spreading the verdict itself would carry `go`
    // into the receipt the agent is shown.
    const why = verdict.held ? { held: verdict.held, ...(verdict.limit ? { limit: verdict.limit } : {}) } : {};
    return this.hold(target, cardId, from, message, why);
  }

  /**
   * The window's answer about a pushed message. TRUE if it was waited for.
   *
   * A late or unknown id is ignored rather than refused loudly: the send it
   * belonged to has already answered its agent ("not confirmed"), and there is
   * nobody left to tell.
   */
  ack(deliveryId: unknown, raw: unknown): boolean {
    if (typeof deliveryId !== 'string') return false;
    const settle = this.pending.get(deliveryId);
    if (!settle) {
      this.deps.log.debug('sibling message ack with nobody waiting', { deliveryId });
      return false;
    }
    if (!isSiblingAck(raw)) {
      // A malformed answer is not a placement. Treated as no answer at all —
      // the hedged outcome — rather than as success.
      this.deps.log.warn('sibling message ack malformed', { deliveryId });
      settle({ kind: 'timeout' });
      return false;
    }
    settle({ kind: 'ack', ack: raw });
    return true;
  }

  /**
   * Should this one go straight in?
   *
   * DIRECT TRANSPORT ONLY, and that is a judgment rather than a limitation of
   * the plumbing: main CAN type into a PTY (`mcp:reconnect` does), but typing a
   * multi-line message plus Enter into a terminal the user may be looking at —
   * with a permission dialog possibly on screen, which our `status` only knows
   * about from a debounced notification — can answer that dialog. A Terminal
   * session still RECEIVES; its message waits in the composer like everyone
   * else's, and the sender is told why.
   *
   * The transport is not asked here; `submit` answering false is how it is
   * learned. That keeps this module from carrying a second copy of "which
   * transports take typed messages", which `submitPrompt` already owns.
   */
  private autoSubmitVerdict(
    cardId: string,
    target: SessionSummary
  ): { go: true } | { go: false; held?: HeldReason; limit?: { count: number; minutes: number } } {
    let accepts = false;
    try {
      accepts = this.deps.acceptsSiblings(cardId) === true;
    } catch (err) {
      // An unreadable preference is OFF. Fail-safe here outranks fail-open:
      // the cost of wrongly holding is one keypress.
      this.deps.log.warn('send_to_session: could not read auto-accept', { cardId, error: String(err) });
    }
    if (!accepts) return { go: false };
    if (!AUTO_SUBMIT_STATUSES.has(target.status)) return { go: false, held: 'not-ready' };
    const recent = this.recentAutoAccepts(cardId);
    if (recent.length >= AUTO_ACCEPT_LIMIT) {
      return {
        go: false,
        held: 'limit',
        limit: { count: AUTO_ACCEPT_LIMIT, minutes: Math.round(AUTO_ACCEPT_WINDOW_MS / 60_000) },
      };
    }
    return { go: true };
  }

  /** Push to the window and wait for it to say what it did. */
  private async hold(
    target: SessionSummary,
    cardId: string,
    from: SiblingSender,
    text: string,
    why: { held?: HeldReason; limit?: { count: number; minutes: number } }
  ): Promise<QueryResult<DeliveryReceipt>> {
    const deliveryId = crypto.randomUUID();
    const now = this.deps.now?.() ?? Date.now();
    const message: SiblingMessage = { deliveryId, cardId, from, text, at: new Date(now).toISOString() };

    const handover = await new Promise<Handover>((resolve) => {
      let done = false;
      const settle = (h: Handover): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.pending.delete(deliveryId);
        resolve(h);
      };
      const timer = setTimeout(
        () => settle({ kind: 'timeout' }),
        this.deps.ackTimeoutMs ?? DELIVERY_ACK_TIMEOUT_MS
      );
      timer.unref?.();
      // REGISTERED BEFORE THE PUSH. Over real IPC the ack cannot come back in
      // the same tick, but "cannot today" is a property of the transport, and a
      // window that answered synchronously would otherwise find nobody waiting
      // and leave this send to time out on a message it had placed.
      this.pending.set(deliveryId, settle);
      let pushed = false;
      try {
        pushed = this.deps.push(message);
      } catch (err) {
        this.deps.log.error('send_to_session: push threw', { cardId, error: String(err) });
      }
      if (!pushed) settle({ kind: 'no-window' });
    });

    switch (handover.kind) {
      case 'no-window':
        return {
          ok: false,
          reason: `no switchboard window is open to show it to the user, so ${label(target)} did not get it`,
        };
      case 'timeout':
        this.deps.log.warn('sibling message not confirmed by the window', { cardId, deliveryId });
        return { ok: true, value: { session: target, outcome: 'unconfirmed' } };
      case 'ack': {
        const ack = handover.ack;
        if (!ack.placed) {
          // Two different refusals, and the agent is told which (#774): one is
          // "come back later", the other is "there is nothing to come back to".
          // Collapsing them would send a polite retry loop at a card that has
          // been closed.
          if (ack.reason === 'gone') {
            this.deps.log.info('sibling message arrived after the card closed', { cardId, deliveryId });
            return {
              ok: false,
              reason:
                `${label(target)} was closed while your message was on its way, so nobody has it. ` +
                'Sending it again will not help until that session is open.',
            };
          }
          return {
            ok: false,
            reason:
              `${label(target)} already has messages waiting for the user to read, and cannot hold ` +
              'more. Wait until the user has dealt with those before sending again.',
          };
        }
        this.deps.log.info('sibling message held for the user', {
          from: from.id,
          to: target.id,
          shown: ack.shown,
          held: why.held ?? '',
        });
        return {
          ok: true,
          value: { session: target, outcome: 'held', shown: ack.shown, ...why },
        };
      }
    }
  }

  /**
   * The sender as the target will see it. Never fails — a nameless sender is
   * still a sender.
   *
   * ID-ONLY (#765 review). `resolve` falls back to matching by NAME when no id
   * matches, so a caller missing from the list — exiting, say — whose live id
   * happened to equal some card's title would be credited with that card's
   * name. Attribution is the one thing here that must not be approximate.
   */
  private sender(callerId: string): SiblingSender {
    const me = this.deps.resolve(callerId);
    // CLEANED HERE, by the rule the header uses (round 2): the renderer
    // refuses a name carrying an invisible or control character, so a raw one
    // would fail every message this session sends as "unconfirmed".
    const name = me.ok && me.value.id === callerId ? cleanSenderName(me.value.name) : '(unknown session)';
    return { id: callerId, name };
  }

  private recentAutoAccepts(cardId: string): number[] {
    const now = this.deps.now?.() ?? Date.now();
    const kept = (this.autoAccepted.get(cardId) ?? []).filter((t) => now - t < AUTO_ACCEPT_WINDOW_MS);
    if (kept.length === 0) this.autoAccepted.delete(cardId);
    else this.autoAccepted.set(cardId, kept);
    return kept;
  }

  private recordAutoAccept(cardId: string): void {
    const now = this.deps.now?.() ?? Date.now();
    this.autoAccepted.set(cardId, [...this.recentAutoAccepts(cardId), now]);
  }
}

/** `Name [id …]`, the form the read tools use, so an agent sees one convention. */
function label(s: SessionSummary): string {
  return `${s.name} [id ${s.id}]`;
}
