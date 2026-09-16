// What the session-history picker shows (P2-E20-01, §5.33) — the wire shape,
// shared so main and the renderer cannot describe a row differently.
//
// Lives in `shared/` for the reason `SessionSummary` (#797) and `MentionPrompt`
// (#798) do: the preload bridge is typed off main's answer, and a type declared
// on only one side is a promise the wire does not keep.

/**
 * One past conversation, as a row in the picker.
 *
 * The DESCRIPTION is the whole point of this type — `listConversations` already
 * answers ids and mtimes, and an id is not something a person recognises.
 */
export interface ConversationRow {
  /** the conversation id — what `--resume` is given, and what identifies a row */
  nativeId: string;
  /**
   * The project folder this conversation belongs to.
   *
   * Read from the transcript's OWN `cwd` rather than reversed out of the
   * directory name: the directory is `slugForCwd`'s output, which replaces
   * every one of `\ / : . ` ` with `-` and is therefore not invertible — a
   * folder cannot be recovered from it, only compared against it. Reading the
   * file's own `cwd` is also what makes a conversation started outside
   * switchboard listable at all.
   */
  folder: string;
  /**
   * What the row SAYS — the CLI's own `ai-title` when the conversation has one,
   * else its first user prompt, else empty.
   *
   * MEASURED across the 200 most recently written transcripts on the owner's
   * machine (2026-09-16, `spike/findings/e20-836-transcript-head.md`):
   * `ai-title` present **192/200 within the window this actually reads**
   * (195/200 counting three that sit past it), a first user prompt 200/200, and
   * `summary` **0/200**. The in-window number is the one quoted here because it
   * is the one the behaviour rests on — the issue's 196/200 was a different
   * sample answering "anywhere in the file". Nothing may be built on `summary`:
   * it would render blank for every conversation on this machine.
   */
  description: string;
  /**
   * Which of those two the description came from, or `none`.
   *
   * Carried to the renderer rather than inferred there because the row is
   * styled by it: a first prompt is the user's own words and is shown as a
   * quotation, while a title is the CLI's summary of them. `none` is a real
   * state — a conversation whose head window held neither — and the row says so
   * in words instead of rendering an empty line.
   */
  descriptionFrom: 'title' | 'prompt' | 'none';
  /** transcript mtime: when this conversation was last written to */
  lastActiveMs: number;
  /**
   * A CARD ALREADY HOLDS THIS CONVERSATION, so picking it must not open a
   * second one into the same file.
   *
   * Measured 2026-08-15 and recorded in the Claude adapter: plain `--resume`
   * APPENDS to the transcript rather than forking it. Two cards resumed into
   * one conversation therefore both write to one file. Every existing guard
   * against that (#484's `claimed` list, #539's ceded ids) protects the
   * automatic repair path; a user-driven picker is a new door into the same
   * failure, so the row carries the answer and main refuses the pick as well.
   */
  claimed: boolean;
}

/**
 * The picker's answer for one scope.
 *
 * `unknown` rather than an empty list when a directory could not be read or is
 * past `MAX_LISTED_CONVERSATIONS` — §5.33's rule, and `listConversations`' own:
 * a list that quietly omits the conversation you want is worse than one that
 * admits its limit. The renderer says which it was.
 */
export type ConversationHistory =
  | {
      status: 'ok';
      rows: ConversationRow[];
      /**
       * More conversations exist than were returned.
       *
       * Distinct from the `unknown` refusal above: that one declined to look,
       * this one looked and is handing back the newest `limit` of what it
       * found. EITHER scope can set it — a folder holding more conversations
       * than the limit truncates too, which `history.test.ts` pins.
       */
      truncated: boolean;
    }
  | { status: 'unknown'; reason: string };

/** What the renderer asks for. `folder` is required for the `folder` scope and
 *  ignored for `all`. */
export interface ConversationHistoryRequest {
  scope: 'folder' | 'all';
  folder?: string;
  limit?: number;
}

/**
 * The most rows a single answer carries.
 *
 * The all-projects scope crosses ~3,000 transcripts on the owner's machine and
 * every row costs a bounded head read, so the scan is capped at what a person
 * can plausibly search rather than at what the disk holds. Type-to-search
 * filters within the answer; it does not re-scan.
 */
export const MAX_HISTORY_ROWS = 300;
