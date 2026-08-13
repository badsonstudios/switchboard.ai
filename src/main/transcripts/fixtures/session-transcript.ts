// A REAL Claude Code transcript, captured for P2-E17-01's tests.
//
// WHY A REAL ONE. E17's whole premise is a measurement — a long session derives
// far more blocks than the Feed keeps, so a find has to read the file. A
// synthetic fixture would be our own idea of what that file looks like, and the
// numbers the item is judged against are properties of a real conversation's
// shape: how many content items an assistant message carries, how often a tool
// call is answered, how much of the bytes are tool output nobody renders. Every
// one of those was checked against this file rather than assumed. Same argument
// E7-06's `ai-title` capture makes, one size up.
//
// AND CHECKING THEM MOVED ONE. §5.31's table records this transcript as
// "3,356 derived blocks"; running the derivation over it gives **1,579**. Both
// numbers are real and the difference is what is being counted: 3,356 is the
// number of `message.content` ITEMS in the file, and a content item is not a
// block — 1,235 of them are `tool_result`s, which attach their output to a tool
// block that already exists rather than adding one, and the rest are lost to
// `isMeta` lines, `<local-command-*>` plumbing and empty text. The conclusion
// the table was drawn for is untouched and is what this fixture proves: 1,579
// blocks against a `BLOCK_CAP` of 1,000 means ~37% of this session is already
// out of the renderer's reach, so a find that searched the view would lie about
// it. (Reported for the doc to be corrected; the code counts what it counts.)
//
// PROVENANCE. `~/.claude/projects/c--Projects-Switchboard-ai/
// ff322375-5bbb-4620-ad84-ca9868c1247a.jsonl`, read-only, on 2026-08-11 — the
// first row of §5.31's table, i.e. the exact transcript the epic measured. It is
// a switchboard.ai working session: the conversation is about this repository,
// and the tool calls read and write files that are in it.
//
// WHAT WAS CHANGED, because "trim it and say so" is the rule and a fixture
// nobody can account for is a guess:
//
//   * All 4,697 lines are present, in order, byte-for-byte in every field the
//     Feed derivation or the watcher reads.
//   * FOUR top-level keys are removed: `toolUseResult`, `snapshot`,
//     `attachment`, `backup`. Nothing in `feed/blocks.ts`, `watcher.ts` or this
//     engine reads any of them — `toolUseResult` is the CLI's own structured
//     echo of a tool run, which the transcript ALSO carries as the
//     `tool_result` content item that we do read. Dropping them took the file
//     from 12.5 MB to 7.7 MB with no effect on a single derived block.
//   * Nothing else. No truncation, no redaction, no reordering. In particular
//     the long tool outputs are intact, because "does find see past
//     `DETAIL_CAP`" is one of the things under test.
//
// TO REFRESH IT, or to capture another: read a transcript from
// `~/.claude/projects/`, drop those four keys, write the rest one JSON object
// per line. Never write into `~/.claude/` — that directory is the user's, and
// the CLI is the only thing allowed to change it.
import fs from 'fs';
import path from 'path';

/** The captured transcript's path on disk. */
export const SESSION_TRANSCRIPT = path.join(__dirname, 'session-transcript.jsonl');

/**
 * What the real file measures, asserted by the tests rather than trusted.
 *
 * `blocks` is what `deriveIntents` produces for the whole file, and the reason
 * this fixture exists: it is 1.6x `BLOCK_CAP`, so a search of it necessarily
 * finds text in blocks no renderer is holding. `contentItems` is the 3,356 of
 * §5.31's table, kept here so the discrepancy above stays checkable rather than
 * becoming folklore.
 */
export const SESSION_TRANSCRIPT_FACTS = {
  lines: 4697,
  blocks: 1579,
  toolResults: 1235,
  contentItems: 3356,
} as const;

/** The raw lines, for a test that needs to build a variant of the file. */
export function transcriptLines(): string[] {
  return fs.readFileSync(SESSION_TRANSCRIPT, 'utf8').split('\n').filter((l) => l.trim().length > 0);
}
