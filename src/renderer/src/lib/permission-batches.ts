// Batch permission handling (P2-E9-11, DESIGN §5.8 — the octomux pattern).
//
// WHAT THIS IS FOR
// ----------------
// A fleet doing the same work asks the same question N times. Seven sessions
// on seven worktrees all reach `npm test` and all of them park, one at a time,
// each behind its own card. §5.8's line is one sentence: "similar pending
// permission prompts across sessions can be grouped and answered once."
//
// This module is the RULE half — which requests are the same question, which
// group is on screen, and who the members are. `components/BatchApprovalBar`
// paints it and `App` owns the ledger it reads from. Rules here rather than in
// the component for `held-permissions`' reason: a grouping rule with no test is
// a rule nothing stops from drifting, and this particular rule decides how many
// sessions one click answers for.
//
// THE KEY IS EXACT, AND THAT IS THE WHOLE DESIGN
// ----------------------------------------------
// The two failure directions are not symmetric. Grouping too little is an
// inconvenience: the user answers two cards instead of one, exactly as they do
// today. Grouping too much is a user clicking one Allow and authorising
// something they never read — `rm -rf build` and `rm -rf /` are the same tool
// with the same argument SHAPE. So the key is not a shape at all: it is the
// tool plus a canonical serialisation of the whole argument object, and two
// requests group only when they are byte-for-byte the same question.
//
// `reason` is in the key too. It is not an argument — it is the CLI's own prose
// for WHY it is asking (P2-E18-07) — but the grouped card RENDERS it, once, for
// every member. A card cannot honestly show one reason on behalf of two
// requests that gave different ones. The rule the key follows is therefore
// "cover exactly what the card shows", which is also what keeps the key honest
// when the card grows a field: whatever it renders goes in here.
//
// A group needs TWO DISTINCT SESSIONS. Two identical requests from one session
// are that card's own queue (E10-04's `+N more waiting`) and grouping them
// would move a question off the card that raised it for no gain.
import type { PermissionRequestDto } from '../../../shared/ipc/permissions';
import { ASK_USER_QUESTION_TOOL } from '../../../shared/ask-user-question';
import { asDisplayString } from '../../../shared/display-string';
import type { RailSession } from '../model/types';

/** One request inside a group. */
export interface BatchMember {
  requestId: string;
  /** the LIVE session that asked — what `decidePermission` is keyed against */
  sessionId: string;
  /** the card that owns it, as main resolved it; absent = no card owns it */
  cardId?: string;
}

/** The one question several sessions are asking, and everyone asking it. */
export interface PermissionBatch {
  /** the grouping key — stable across recomputes, so the card can be sticky */
  key: string;
  tool: string;
  input: Record<string, unknown>;
  /** the CLI's prose, shared by every member (it is part of the key) */
  reason?: string;
  /** every held request in the group, in arrival order */
  members: readonly BatchMember[];
  /** how many DISTINCT sessions are asking — what the card counts */
  sessionCount: number;
}

/**
 * The separator and the tag prefix inside a key.
 *
 * A control character, not a space or a colon: the key concatenates a tool
 * name, a serialised object and a free-text reason, and any character legal
 * inside those is one an attacker — or a merely unlucky tool description — can
 * use to make two different questions serialise identically. NUL is the one
 * byte that cannot survive `JSON.stringify` — it comes back as the six
 * printable characters of its escape — so once every component of the key has
 * been through `canonical`, no component can contain the separator and the
 * concatenation is injective. That is why the TOOL goes through it too, rather
 * than being trusted: tool names arrive from MCP servers, and "no tool name
 * carries a NUL" would be an assumption about other people's strings.
 */
const NUL = String.fromCharCode(0);

/**
 * A value written the same way every time, whatever order its keys arrived in.
 *
 * `JSON.stringify` is not enough on its own: it preserves insertion order, and
 * two CLIs building `{file_path, old_string}` and `{old_string, file_path}`
 * would be the same question with two different keys. Sorting the keys makes
 * the serialisation a function of the VALUE.
 *
 * Types stay distinguishable because JSON already distinguishes them —
 * `"1"` serialises as `"1"` and `1` as `1` — with one exception this fixes:
 * `NaN` and `Infinity` both stringify as `null`, which would merge a nonsense
 * argument with an absent one.
 *
 * Throws on a cycle rather than looping. IPC payloads are JSON, so this cannot
 * happen from the CLI; `batchKey` catches it anyway, because a throw inside a
 * render is a blank window and this runs during one.
 */
function canonical(v: unknown, seen: Set<object>): string {
  if (v === undefined) return NUL + 'undefined';
  if (typeof v === 'number' && !Number.isFinite(v)) return NUL + 'num:' + String(v);
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? NUL + 'undefined';
  if (seen.has(v)) throw new Error('cyclic permission input');
  seen.add(v);
  try {
    if (Array.isArray(v)) return '[' + v.map((x) => canonical(x, seen)).join(',') + ']';
    const rec = v as Record<string, unknown>;
    return (
      '{' +
      Object.keys(rec)
        .sort()
        .map((k) => JSON.stringify(k) + ':' + canonical(rec[k], seen))
        .join(',') +
      '}'
    );
  } finally {
    seen.delete(v);
  }
}

/**
 * The grouping key for one request — see the header for why it is exact.
 *
 * An input that cannot be serialised gets a key nothing else can equal, so it
 * groups with nobody and falls back to its own card's bar. Ungroupable must
 * mean "asked separately", never "asked nowhere".
 */
export function batchKey(r: Pick<PermissionRequestDto, 'requestId' | 'tool' | 'input' | 'reason'>): string {
  try {
    // every component through `canonical`, including the tool — see NUL
    return [r.tool, r.input, r.reason].map((v) => canonical(v, new Set())).join(NUL);
  } catch {
    return NUL + 'ungroupable:' + r.requestId;
  }
}

/**
 * Which group is on screen, given everything currently held.
 *
 * ONE AT A TIME. A stack of grouped cards above the workspace would move the
 * buttons under the user's cursor every time a session parked, and the whole
 * point of the surface is that it is answered with a click. Groups that are not
 * chosen are not lost: their members stay on their own cards' bars, exactly as
 * they are today, and the next recompute after this one clears will pick one up.
 *
 * STICKY. `currentKey` — the key of the group already showing — wins as long as
 * it still has two sessions in it. Without that, a second group forming could
 * silently swap the card's contents between the read and the click.
 *
 * Otherwise the oldest group wins: `Map` preserves insertion order, and a key's
 * insertion is its earliest member, so iteration is "in the order these
 * questions were first asked". That is also the order the attention queue uses.
 */
export function chooseBatch(
  pending: readonly PermissionRequestDto[],
  currentKey: string | null
): PermissionBatch | null {
  const byKey = new Map<string, PermissionRequestDto[]>();
  for (const r of pending) {
    // A QUESTION NEVER GROUPS (#563). Two sessions asking a byte-identical
    // `AskUserQuestion` would satisfy the key — the key is exact, and a fleet
    // running the same prompt could genuinely produce one — but this card's
    // Allow sends the input back with NO answers, and the CLI reads that as
    // "The user did not answer the questions." So grouping a question would
    // offer one click that answers N sessions with nothing, which is the exact
    // failure the exact-key rule exists to prevent, arriving through the door
    // the key cannot see. It stays on its own card, where the panel is.
    if (r.tool === ASK_USER_QUESTION_TOOL) continue;
    const k = batchKey(r);
    const list = byKey.get(k);
    if (list) list.push(r);
    else byKey.set(k, [r]);
  }
  const build = (key: string, list: readonly PermissionRequestDto[]): PermissionBatch | null => {
    const sessions = new Set(list.map((r) => r.sessionId));
    if (sessions.size < 2) return null;
    return {
      key,
      tool: list[0].tool,
      input: list[0].input,
      reason: list[0].reason,
      members: list.map((r) => ({ requestId: r.requestId, sessionId: r.sessionId, cardId: r.cardId })),
      sessionCount: sessions.size,
    };
  };
  if (currentKey !== null) {
    const held = byKey.get(currentKey);
    const sticky = held ? build(currentKey, held) : null;
    if (sticky) return sticky;
  }
  for (const [key, list] of byKey) {
    const batch = build(key, list);
    if (batch) return batch;
  }
  return null;
}

/**
 * Do these two describe the same card?
 *
 * The store derives the batch on every mutation and hands the result to
 * `useSyncExternalStore`, which compares snapshots by IDENTITY. A fresh object
 * per recompute would re-render the whole shell on every unrelated permission
 * event — and, worse, would replace the card mid-click. Members are compared by
 * request id in order because that is what the card renders and what its
 * buttons close over.
 */
export function sameBatch(a: PermissionBatch | null, b: PermissionBatch | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.key !== b.key || a.members.length !== b.members.length) return false;
  // `cardId` as well as the id: a request pushed before main had bound the card
  // arrives with none, and the `pendingPermissions` replay carries the binding.
  // Comparing ids alone would call that the same batch and leave the row
  // reading "an unnamed session" for the rest of the run.
  return a.members.every(
    (m, i) => m.requestId === b.members[i].requestId && m.cardId === b.members[i].cardId
  );
}

/** A member with the identity kit resolved (§5.11). */
export interface BatchMemberView extends BatchMember {
  /** the session's NAME, absent when nothing knows it yet */
  title?: string;
  /** its identity accent, for the chip's dot */
  accent?: string;
}

/**
 * Name the members (§5.11).
 *
 * By NAME and accent, never by folder: §5.11's identity kit is what the rail,
 * the lamps and the card header all use, and a grouped card that listed paths
 * would be the one surface naming sessions differently from every other. A
 * session whose title has not arrived yet is left `undefined` on purpose — the
 * component says an honest generic rather than announcing a path.
 *
 * Keyed on `cardId`, which is the durable id `RailSession` is listed under;
 * `sessionId` is the live id and churns on resume.
 */
export function memberViews(
  batch: PermissionBatch,
  sessions: readonly RailSession[]
): BatchMemberView[] {
  const byCard = new Map(sessions.map((s) => [s.id, s]));
  return batch.members.map((m) => {
    const s = m.cardId === undefined ? undefined : byCard.get(m.cardId);
    return { ...m, title: s?.title, accent: s?.accent };
  });
}

/**
 * The one line that says what a request wants to touch.
 *
 * Shared with the per-card `ApprovalBar` deliberately: the grouped card and the
 * card's own bar are two placements of ONE question (§5.16), and a user who
 * read the summary on one and then sees a different one on the other has been
 * shown two things and told they are the same.
 */
export function argumentSummary(input: Record<string, unknown>): string {
  // `input` is a tool_use block off the CLI, so every field here is `unknown`
  // and `String()` would render a malformed one as the literal `[object
  // Object]` on the approval card — T1's finding, and the reason
  // `asDisplayString` exists (#255). Same fail-open behaviour, same result for
  // every primitive; a non-primitive now comes back EMPTY, which routes into
  // `argumentDetail`'s existing "no summary" path (the JSON dump) instead of
  // onto the card as punctuation.
  return asDisplayString(input.file_path ?? input.command ?? input.url);
}

/**
 * What the GROUPED card shows when the summary comes back empty.
 *
 * Every tool gated under `ask` today carries a `file_path`, a `command` or a
 * `url`, so this is for the ones that come later — an MCP tool, or a wider
 * autonomy mode. The per-card bar can afford to say only the tool name: its
 * card is right there, with the session's whole conversation above it. This
 * card cannot. It answers for N sessions at once, so "what am I agreeing to"
 * has to be answerable from the card itself, and a tool name is not an answer.
 *
 * Truncated hard rather than scrolled: this is a fallback, and a band above the
 * workspace is not the place to read a large object.
 */
export function argumentDetail(input: Record<string, unknown>): string {
  const summary = argumentSummary(input);
  if (summary) return summary;
  const entries = Object.entries(input);
  if (entries.length === 0) return '';
  const line = entries.map(([k, v]) => `${k}=${JSON.stringify(v) ?? 'undefined'}`).join('  ');
  return line.length > 300 ? line.slice(0, 300) + '…' : line;
}
