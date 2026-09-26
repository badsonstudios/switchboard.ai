// The dispatched session's FIRST TURN (P2-E13-03, §5.15).
//
// #947 answers "what does this policy hand over" and returns a document. #946
// answers "what is this session for" and returns a role prompt. This module is
// the one line between them: the two become ONE user message, which is the
// dispatched session's own opening prompt.
//
// ── WHY THE BRIEFING GOES FIRST AND THE ROLE PROMPT LAST ────────────────────
//
// Both orders read fine, so the order was decided on the one thing that is not a
// matter of taste: WHO CAN BREAK WHOSE MARKDOWN.
//
// The briefing's fences are balanced by construction — `clean-room.ts` sizes its
// diff fence to the longest backtick run in the final bytes, and #766's package
// does the same for its own blocks. The role prompt has no such guarantee: it is
// free text a user typed into a template, and a user who pastes an example with
// one code fence in it has written an UNCLOSED fence.
//
// Put the role prompt first and that unclosed fence swallows the top of the
// briefing — the heading, the preamble that tells the reader the reasoning was
// withheld on purpose, and the start of the diff — into a code block. Put it last
// and there is nothing after it to swallow. The failure becomes "the last
// paragraph renders as code", which is ugly and harmless.
//
// The secondary reason is that it is also the better prompt shape: the
// instruction lands after the material it applies to rather than several thousand
// characters before it.
//
// ── WHAT THIS MODULE DOES NOT DO ────────────────────────────────────────────
//
// It does not sanitise the briefing. That already happened, at the door, in the
// module that built it — and #947's own lesson is that a structural decision
// taken on bytes that are about to change is not a decision, so re-stripping a
// finished document here would invalidate the fence it was assembled with. The
// role prompt IS cleaned, because nothing has cleaned it: it arrives from
// `workspace.json`, which is a file a user edits by hand.
import { ROLE_PROMPT_CHAR_CAP, type RoleTemplate } from '../../shared/dispatch';
import { stripUnsafeControls } from '../../shared/sibling-message';
import { capText } from './context-package';
import type { DispatchContext } from './dispatch-context';

/**
 * The separator between the handed-over document and the instruction.
 *
 * A HEADING, not a blank line: the briefing ends with whatever its last section
 * was, and two documents run together with one newline between them are one
 * document to the reader. The briefing's own preamble promises that "your own
 * instructions arrive separately from this document" — this is the line that makes
 * that visibly true.
 *
 * `##` and not `#`, so it sits under the briefing's own `#` title rather than
 * competing with it.
 */
const INSTRUCTION_HEADING = '## Your instructions';

/**
 * What the turn says when the template carries no role prompt at all.
 *
 * An empty `rolePrompt` is LEGAL (`RoleTemplate.rolePrompt` — a half-written
 * template has to be storable), and #946 calls the result "legible rather than
 * broken". This is the legible part: without it the message would end on a
 * heading with nothing under it, which reads as text that failed to arrive
 * rather than as a template with nothing to say.
 */
export const NO_ROLE_PROMPT =
  '_This dispatch template carries no instructions. Read what you have been ' +
  'given and say what you make of it._';

/**
 * What a FORK is told, since it is handed no document (#947).
 *
 * A `full` dispatch adopts the author's conversation by forking it, so the
 * context is the transcript the CLI is already carrying — `DispatchFork` is "an
 * instruction, not a document", and there is no briefing text to put above the
 * role prompt.
 *
 * But it still needs a sentence, because from the model's point of view the
 * conversation it thinks it has been having has just been handed a role it was
 * never given. Without this line the role prompt reads as the same user changing
 * their mind mid-thread; with it, the handover is the fact and the role is the
 * instruction.
 */
export const FORKED_PREAMBLE = [
  'You have been handed this conversation as it stands: everything above is the',
  'work another session did, and you are continuing it from here under new',
  'instructions. Nothing has been summarised or withheld — it is the conversation',
  'itself.',
].join('\n');

/**
 * The dispatched session's opening user message.
 *
 * Pure: same context and same template in, same text out. `dispatchId` is
 * deliberately not a parameter — nothing in the message identifies the dispatch,
 * because the dispatched session has no use for our bookkeeping and #950's
 * round-trip reads the transcript, not a marker we planted in it.
 *
 * Both context shapes are handled HERE rather than at the call site, so the
 * caller submits one string and cannot forget that a fork has no document.
 */
export function buildDispatchPrompt(context: DispatchContext, template: RoleTemplate): string {
  // CAPPED AND CLEANED, in that order relative to each other only: the cap
  // counts characters the reader actually receives, which is `clean-room.ts`'s
  // rule for the same pair of calls. `ROLE_PROMPT_CHAR_CAP` is the store's own
  // bound, reused rather than re-chosen — a template that came through
  // `isSaneRoleTemplate` is already under it, and one that came from a built-in
  // is far under it, so this only ever bites a hand-mangled file that somehow
  // reached here.
  // `capText` answers `{ text, truncated }` and appends its own in-band
  // `…[truncated]` marker — the same convention #766's package and #947's bundle
  // use, so a reader that has learned what that marker means anywhere in this app
  // has learned it here. The FLAG is deliberately not surfaced: a template over
  // 20,000 characters is a hand-mangled workspace file, not somebody's reviewer,
  // and the marker inside the text is already the honest report of it.
  const role = capText(stripUnsafeControls(template.rolePrompt).trim(), ROLE_PROMPT_CHAR_CAP).text;
  const instruction = role === '' ? NO_ROLE_PROMPT : role;
  // A FORK'S HISTORY IS ALREADY IN THE SESSION, so the preamble goes first and
  // there is nothing to put a fence around — the "briefing last" rule above is
  // about a document this message carries, and this message carries none.
  const given = context.source === 'fork-adoption' ? FORKED_PREAMBLE : context.text.trimEnd();
  return [given, '', INSTRUCTION_HEADING, '', instruction, ''].join('\n');
}
