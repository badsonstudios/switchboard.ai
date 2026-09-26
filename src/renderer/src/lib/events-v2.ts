// Events v2 (P2-E14-02, DESIGN §5.12): the filters, and the join that lets a
// row answer the question its session is blocked on.
//
// Pure (no React, no DOM, no IPC), for `lib/queue`'s reason: every rule below
// is a unit test rather than an e2e guess.
//
// THE JOIN, AND WHY IT IS THE LEDGER
// ----------------------------------
// An Events row is one SESSION's latest state (§5.12's one-item-per-session),
// keyed by the live id. The requests that session is blocked on already live
// in the renderer — `sessionStore`'s whole-fleet ledger, which E9-11 built for
// the grouped card from the same three primitives every card uses (the live
// push, the resolution, the mount replay) plus the live-retired drop. So the
// row does not need main to enrich its event: it asks the ledger what that live
// id is holding. One ledger means the Events row, the grouped card and the
// card's own bar can never disagree about whether a question is still open —
// they all clear on the same `permissionResolved`.
import type { PermissionRequestDto } from '../../../shared/ipc/permissions';
import {
  ASK_USER_QUESTION_TOOL,
  AskQuestion,
  parseAskUserQuestion,
} from '../../../shared/ask-user-question';
import { AttentionEvent, panelOrder, queueable } from './queue';
import { argumentDetail } from './permission-batches';

/** The three views §5.12 names (from the main-window-v1 mockup). */
export type EventsFilter = 'all' | 'needed' | 'by-session';

export const EVENTS_FILTERS: readonly EventsFilter[] = ['all', 'needed', 'by-session'];

/**
 * The rows to show, in the order to show them.
 *
 * - `all` is today's panel exactly: `panelOrder`, the queue then the reviewed
 *   tail.
 * - `needed` is the queue, which is `queueable`: the same predicate the
 *   "N need you" counters and Ctrl+Space use. PLUS any row whose session is
 *   still holding a request (`holding`), whatever its kind. A row the user
 *   acknowledged while its question was still open has working buttons on it,
 *   and a filter called Needed that hid the one thing you can still answer
 *   would be hiding exactly what it is named for. That is the only way it can
 *   list more than the hotkey walks.
 * - `by-session` is every row, in RAIL order. The feed is already one item per
 *   session, so grouping by session can only mean putting the rows where you
 *   would look for that session: the order the rail paints (pins first, group
 *   members together). A session the rail does not know (a closed one) sorts
 *   last, in panel order, rather than vanishing.
 *
 * `railIndex` maps a LIVE session id to its rail position; the caller builds it
 * because only the caller knows both ids for a row.
 */
export function visibleEvents<T extends AttentionEvent>(
  events: readonly T[],
  filter: EventsFilter,
  railIndex: (sessionId: string) => number | undefined,
  holding: (sessionId: string) => boolean
): T[] {
  // `panelOrder` is generic since P2-E13-05, so the row type survives the sort
  // and the cast this line used to need is gone.
  const ordered = panelOrder(events);
  if (filter === 'needed') return ordered.filter((e) => queueable(e) || holding(e.sessionId));
  if (filter === 'by-session') {
    const pos = new Map(ordered.map((e, i) => [e.id, i]));
    return ordered.slice().sort((a, b) => {
      const ra = railIndex(a.sessionId) ?? Number.POSITIVE_INFINITY;
      const rb = railIndex(b.sessionId) ?? Number.POSITIVE_INFINITY;
      if (ra !== rb) return ra < rb ? -1 : 1;
      // stable against the panel order, so two unknown sessions keep theirs
      return (pos.get(a.id) ?? 0) - (pos.get(b.id) ?? 0);
    });
  }
  return ordered;
}

/** How much of a path a row has room for at the drawer's 300px, in characters. */
const PATH_ROOM = 42;

/**
 * The one line a row prints for what the tool wants to touch.
 *
 * `argumentDetail`, not the per-card bar's bare summary: like the grouped card,
 * this row is answered with the conversation out of sight, so a tool name alone
 * is not enough to say yes to.
 *
 * A long PATH is cut from the FRONT. An absolute path in a temp or project
 * folder spends all 300px on `C:\Users\…\AppData\…`, and a tail-end ellipsis
 * then hides the only part a person decides on, the file's name. A command or
 * URL keeps its head, because that is where its meaning is.
 */
export function rowArgument(input: Record<string, unknown>): string {
  const detail = argumentDetail(input);
  if (typeof input.file_path !== 'string' || detail.length <= PATH_ROOM) return detail;
  const tail = detail.slice(-(PATH_ROOM - 1));
  // start the tail at a separator, so it never opens mid-folder-name
  const cut = tail.search(/[\\/]/);
  return '…' + (cut > 0 && cut < tail.length - 1 ? tail.slice(cut) : tail);
}

/** What one session is holding, as an Events row wants it. */
export interface HeldForSession {
  /**
   * The permission the row's buttons answer: the OLDEST held non-question
   * request, so that answering from here works through them in the order the
   * CLI asked. Null when the session is holding none.
   */
  permission: PermissionRequestDto | null;
  /** every held non-question request's id, `permission` first */
  permissionIds: readonly string[];
  /** the questions of every held `AskUserQuestion`, in the order asked */
  questions: readonly AskQuestion[];
}

const NOTHING: HeldForSession = { permission: null, permissionIds: [], questions: [] };

/**
 * Join the ledger to one session.
 *
 * Questions and permissions are separated because they are answered in
 * different places. A permission is a yes or no, and a yes or no is safe to
 * give blind. A question is not: an allow that carries no `answers` comes back
 * from the CLI as "The user did not answer the questions" (measured, #563), so
 * a button here would throw the question away rather than answer it. The row
 * LISTS questions and sends you to the card to answer them.
 *
 * An `AskUserQuestion` whose input does not parse contributes nothing, and the
 * row falls back to its plain open gesture. That is the card's panel's rule too.
 */
export function heldFor(
  ledger: readonly PermissionRequestDto[],
  liveSessionId: string
): HeldForSession {
  let permission: PermissionRequestDto | null = null;
  const permissionIds: string[] = [];
  const questions: AskQuestion[] = [];
  for (const r of ledger) {
    if (r.sessionId !== liveSessionId) continue;
    if (r.tool === ASK_USER_QUESTION_TOOL) {
      questions.push(...(parseAskUserQuestion(r.input) ?? []));
      continue;
    }
    // the ledger is in arrival order, so the first one found is the oldest
    permission ??= r;
    permissionIds.push(r.requestId);
  }
  if (!permission && questions.length === 0) return NOTHING;
  return { permission, permissionIds, questions };
}
