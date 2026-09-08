// The questions one session asks ABOUT ANOTHER (P2-E11-01, §5.4).
//
// WHY THIS IS ITS OWN MODULE, BELOW EVERY TRANSPORT
// -------------------------------------------------
// Two consumers want the same three answers, and they arrive months apart:
// the Session Bus MCP server (#764, over stdio, in a child process) and the
// composer's `@session` references (#768-era, in the renderer, over IPC).
// Whichever ships first would otherwise own the answer, and the second would
// reimplement it — which is how one question grows two answers that drift.
//
// So this module is deliberately TRANSPORT-FREE: it imports no MCP, no IPC, no
// Electron. `queries.test.ts` asserts that against the source text rather than
// trusting the comment, because the value here is not that it is true today but
// that it stays true after everyone stops looking.
//
// It also adds NO SOURCE OF TRUTH. Sessions come from the manager, output from
// the transcript on disk, diffs from `GitService`. Every call is computed fresh;
// there is no cache to invalidate and no state to disagree with the app's.
//
// ── WHY THE TRANSCRIPT AND NOT A LIVE FEED BUFFER ───────────────────────────
//
// There are TWO `FeedBuffer` owners — `StreamFeed` for Direct sessions and
// `TranscriptWatcher` for PTY ones — and no registry over them. Reading the
// file works uniformly for both transports, is already fail-open, and is what
// §5.4 specifies ("recent transcript tail of a sibling"). Two costs, named
// rather than hidden: a Direct session's newest tokens may not be flushed yet,
// so a sibling asked mid-sentence can answer a beat behind; and we read exactly
// the ONE path `transcriptFor` returns, where the Feed also follows subagent
// files. A subagent's own transcript is therefore not visible here — only the
// sidechain lines the CLI writes into the main file.
//
// ── FAIL-OPEN, EVERYWHERE (P6) ──────────────────────────────────────────────
//
// A sibling with no transcript, or one sitting in a folder that is not a repo,
// are NORMAL STATES, not errors. They answer empty. So does a dependency that
// throws: this module's never-throw guarantee is about THIS file, and it cannot
// be honoured by trusting three implementations it does not own.
//
// What does NOT answer empty is a bad session REFERENCE: one that names no
// session, names two, or is not even a string. Those refuse with a reason,
// because an agent told "no such session" or "ambiguous: 2 matches" retries
// usefully, while one handed `[]` concludes its sibling did nothing and moves
// on believing it.
import {
  BlockIntent,
  DerivationCaps,
  DISPLAY_CAPS,
  FeedBlock,
  deriveIntents,
} from '../feed/blocks';
import { HISTORY_MAX_LINES, readTranscriptTail } from '../feed/history';
import type { SessionStatus } from '../../shared/sessions';

/**
 * How much rendered output one query may return, in characters.
 *
 * THE CAP IS THE POINT, and it lives here rather than at either call site so
 * both get it. §5.5's whole argument for summaries over raw transcripts is that
 * a full conversation runs 100k+ tokens and would consume the ASKING session's
 * context window — so a bus tool that faithfully returns everything is a bus
 * tool that costs its caller the ability to act on the answer.
 */
export const OUTPUT_CHAR_CAP = 20_000;

/** How much unified diff one query may return, in characters. Same argument. */
export const DIFF_CHAR_CAP = 20_000;

/** Blocks returned when the caller does not say. */
export const DEFAULT_LAST_N = 20;

/** The most blocks any single call may ask for, whatever it passes. */
export const MAX_LAST_N = 200;

/** Marks output cut at the front, so a model knows it holds a fragment. */
export const TRIM_MARKER = '…[earlier output trimmed]';

/** One session, as a sibling sees it (§5.4 `list_sessions`). */
export interface SessionSummary {
  id: string;
  /**
   * The display title — what `@name` resolves against.
   *
   * This is the app's `identity.title` under a different name, because the
   * surface it serves is `@name` rather than a window caption. The mapping
   * lives wherever `SessionQueryDeps.list` is wired and nowhere else.
   */
  name: string;
  folder: string;
  providerId: string;
  status: SessionStatus;
}

/**
 * Every answer is this or a refusal — never a bare value and never a throw.
 *
 * A discriminated union rather than exceptions because BOTH consumers cross a
 * boundary where a throw becomes something unhelpful: over MCP it is a protocol
 * error the agent cannot read, over IPC it is a rejected promise the renderer
 * turns into a toast. A refusal carries a reason the caller can act on.
 */
export type QueryResult<T> = { ok: true; value: T } | { ok: false; reason: string };

export interface SessionOutput {
  session: SessionSummary;
  /** rendered text, oldest first, capped */
  text: string;
  /** how many blocks actually contributed text */
  blocks: number;
  /**
   * Something was dropped — `lastN`, the character cap, or the transcript
   * reader's own line budget.
   *
   * ⚠️ NOT a promise that everything else is whole. `DISPLAY_CAPS` bounds each
   * prose block at 20k chars and each tool result at 4k INSIDE the derivation,
   * and those cuts are invisible here. A 200 KB test failure arrives as its
   * first 4k characters with `truncated` unset by that fact alone. #764 must
   * not promise a model more than this says.
   */
  truncated: boolean;
}

export interface SessionDiff {
  session: SessionSummary;
  isRepo: boolean;
  /** unified diff text, capped; empty when the tree is clean or not a repo */
  diff: string;
  truncated: boolean;
}

/** Just enough of `GitService` to be callable with a test double. */
export interface DiffSource {
  diff(folder: string): Promise<{ isRepo: boolean; text: string }>;
}

/**
 * What this module needs, injected.
 *
 * `list` MUST answer for every session a sibling could name. If it is wired to
 * live records only, an unstarted card is invisible and `resolve` refuses it as
 * unknown — which is a defensible answer, but it is a DIFFERENT one from "it
 * exists and has produced nothing", and the consumer's error text depends on
 * which. Wire it deliberately.
 *
 * `transcriptFor` is the HOST's answer, not one derived here — the same rule
 * #432 established for `resume`: the adapter says where conversations live, the
 * host resolves the path, and deriving a second one in here would make one
 * contract into two independent declarations that can disagree. `null` means
 * "this session has no transcript we can read", which is a normal state.
 */
export interface SessionQueryDeps {
  list(): readonly SessionSummary[];
  transcriptFor(sessionId: string): string | null;
  git: DiffSource;
}

/** Prose blocks read as themselves; a tool row reads as one labelled line. */
function renderBlock(block: FeedBlock): string {
  // A subagent's turn is NOT the main conversation, and handing it to another
  // agent unmarked is a misattribution it cannot detect. Labelled rather than
  // dropped: a sibling's subagent work is often the most interesting thing in
  // the window, and silently removing it would leave an unexplained gap.
  const tag = block.sidechain ? '[subagent] ' : '';
  if (block.kind === 'tool' && block.tool) {
    const head = `${tag}[${block.tool.name}] ${block.tool.summary}`;
    return block.tool.out ? `${head}\n  -> ${block.tool.out}` : head;
  }
  if (block.kind === 'todos' && block.todos) {
    return tag + block.todos.map((t) => `- [${t.status}] ${t.content}`).join('\n');
  }
  const text = block.text ?? '';
  if (!text) return '';
  const label = block.kind === 'user' ? 'User' : block.kind === 'thinking' ? 'Thinking' : 'Claude';
  return `${tag}${label}: ${text}`;
}

/**
 * Fold derivation intents into blocks, attaching tool results to their calls.
 *
 * A miniature of what `FeedBuffer` does. Not reusing `FeedBuffer` itself
 * because it is a live view — it emits through a callback, evicts at
 * `BLOCK_CAP`, and owns `seq` numbering shared with the renderer. None of that
 * belongs in a synchronous read of a file, and constructing one per query to
 * throw it away would couple this to the Feed's eviction policy for nothing.
 *
 * TWO DELIBERATE DIVERGENCES FROM `FeedBuffer`, both toward being more correct
 * for one call rather than for a live view:
 *  - `awaiting` is unbounded where `FeedBuffer.remember` caps at 200, so past
 *    200 unresolved calls the Feed forgets a result and this still attaches it.
 *    The map dies with the call and `readTranscriptTail` bounds entries at
 *    5,000, so there is nothing to leak.
 *  - `seq` here is a local ordinal starting at 0; `FeedBuffer`'s starts at 1
 *    and is shared with the renderer. **Never surface this one** — it is not
 *    the Feed's `seq` and cannot be used to address a block on screen.
 */
function blocksFrom(
  entries: readonly Record<string, unknown>[],
  caps: DerivationCaps
): FeedBlock[] {
  const blocks: FeedBlock[] = [];
  const awaiting = new Map<string, FeedBlock>();
  let seq = 0;
  for (const entry of entries) {
    // The watcher's other half of this (`full !== boundFile`) is N/A — we read
    // exactly one file — but a sidechain line lands IN that file and must not
    // be presented as the main conversation. `renderBlock` marks it.
    const sidechain = entry.isSidechain === true;
    let intents: BlockIntent[];
    try {
      // Belt-and-braces, not a known path: `deriveIntents` is tolerant by
      // construction and nothing `JSON.parse` produces can make it throw. Kept
      // so one malformed entry could never cost the whole tail, and flagged as
      // untested because it is untestable from outside.
      intents = deriveIntents(entry, caps);
    } catch {
      continue;
    }
    for (const intent of intents) {
      if (intent.t === 'tool-result') {
        const target = awaiting.get(intent.toolUseId);
        if (target?.tool) target.tool.out = intent.out;
        awaiting.delete(intent.toolUseId);
        continue;
      }
      const block: FeedBlock = { ...intent.block, seq: seq++, sidechain };
      if (intent.toolUseId) awaiting.set(intent.toolUseId, block);
      blocks.push(block);
    }
  }
  return blocks;
}

/** Run an injected dependency, treating a throw as its empty answer (P6). */
function attempt<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

export class SessionQueries {
  constructor(private readonly deps: SessionQueryDeps) {}

  /** Every session a sibling could address (§5.4 `list_sessions`). */
  listSessions(): QueryResult<SessionSummary[]> {
    // A union like every other answer, so a consumer has ONE handling shape
    // rather than a discriminant check for two methods and a try/catch for the
    // third.
    const list = attempt(() => this.deps.list(), null);
    if (!list) return { ok: false, reason: 'the session list is unavailable' };
    return { ok: true, value: [...list] };
  }

  /**
   * Resolve `@name` — or an id — to exactly one session.
   *
   * REFUSES AN AMBIGUOUS NAME rather than picking. Two cards can carry the same
   * title (two checkouts of one repo is the ordinary way to get there), and
   * silently handing back the wrong sibling's transcript is a wrong answer
   * delivered with total confidence. Ids are matched first and exactly, so an
   * unambiguous caller always has a way through.
   */
  resolve(ref: string): QueryResult<SessionSummary> {
    // A TYPE GUARD, not a formality. Both consumers cross a boundary where
    // types are not enforced — MCP tool arguments are JSON a model wrote, IPC
    // arguments come from the renderer — so `ref` really can be a number, null,
    // or an object, and `.trim()` on one throws straight out of the module past
    // the never-throw contract three lines of header promise.
    if (typeof ref !== 'string') {
      return { ok: false, reason: 'session reference must be a string' };
    }
    const needle = ref.trim().replace(/^@/, '').trim();
    if (!needle) return { ok: false, reason: 'no session named' };
    const all = attempt(() => this.deps.list(), null);
    if (!all) return { ok: false, reason: 'the session list is unavailable' };

    const byId = all.find((s) => s.id === needle);
    if (byId) return { ok: true, value: byId };

    const exact = all.filter((s) => s.name === needle);
    const matches =
      exact.length > 0
        ? exact
        : all.filter((s) => s.name.toLowerCase() === needle.toLowerCase());

    if (matches.length === 1) return { ok: true, value: matches[0] };
    if (matches.length === 0) {
      const known = all.map((s) => s.name).join(', ');
      return {
        ok: false,
        reason: known
          ? `no session named "${needle}" — running sessions: ${known}`
          : `no session named "${needle}" — no sessions are running`,
      };
    }
    return {
      ok: false,
      // The FOLDER is in here because the documented way to reach this state is
      // two checkouts of one repo, where it is the only human-meaningful
      // difference between the candidates.
      reason: `"${needle}" is ambiguous — ${matches.length} sessions share that name: ${matches
        .map((s) => `${s.name} (${s.id}, ${s.folder})`)
        .join('; ')}. Use the session id.`,
    };
  }

  /**
   * A sibling's recent output as text (§5.4 `get_session_output`).
   *
   * An empty answer means the session has produced nothing readable yet — a
   * card that has not started, or whose CLI has not written a transcript. That
   * is a normal state and answers `ok` with empty text, NOT a refusal: only a
   * bad reference refuses.
   */
  sessionOutput(ref: string, lastN?: number): QueryResult<SessionOutput> {
    const found = this.resolve(ref);
    if (!found.ok) return found;
    const session = found.value;

    // Says what it means, rather than leaning on `||` to catch both 0 and NaN —
    // which it did, but asymmetrically (0 became the default, -1 became 1).
    // A caller asking for a million blocks gets `MAX_LAST_N`, not a refusal:
    // clamping keeps a clumsy agent working instead of teaching it to retry.
    const n = Number(lastN);
    const want =
      Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), MAX_LAST_N) : DEFAULT_LAST_N;

    const file = attempt(() => this.deps.transcriptFor(session.id), null);
    if (!file) {
      return { ok: true, value: { session, text: '', blocks: 0, truncated: false } };
    }
    const entries = attempt(() => readTranscriptTail(file), []);
    const all = blocksFrom(entries, DISPLAY_CAPS);
    const taken = all.slice(-want);
    const pieces = taken.map(renderBlock).filter((s) => s !== '');
    const rendered = pieces.join('\n\n');

    // CUT FROM THE FRONT, keeping the NEWEST text. `taken` selects the newest
    // window and then this used to `slice(0, CAP)` it, which handed back the
    // START of that window — the exact opposite of "what is my sibling doing
    // now", and reachable on the default path (five 4k tool results inside 20
    // blocks). The marker is in-band so the model knows it holds a fragment.
    const overflow = rendered.length > OUTPUT_CHAR_CAP;
    const text = overflow
      ? TRIM_MARKER + '\n\n' + rendered.slice(-(OUTPUT_CHAR_CAP - TRIM_MARKER.length - 2))
      : rendered;

    return {
      ok: true,
      value: {
        session,
        text,
        // What actually contributed text — a block that renders to nothing is
        // not output, and counting it produces `{blocks: 20, text: ''}`.
        blocks: pieces.length,
        truncated: taken.length < all.length || overflow || entries.length >= HISTORY_MAX_LINES,
      },
    };
  }

  /**
   * A sibling's uncommitted changes as a unified diff (§5.4 `get_session_diff`).
   *
   * Text, because the consumer is a language model. `GitService.fileVersions`
   * exists for Monaco and returns two whole file contents, which is the wrong
   * shape and the wrong size for this.
   */
  async sessionDiff(ref: string): Promise<QueryResult<SessionDiff>> {
    const found = this.resolve(ref);
    if (!found.ok) return found;
    const session = found.value;
    let got: { isRepo: boolean; text: string };
    try {
      got = await this.deps.git.diff(session.folder);
    } catch (err) {
      // A REFUSAL, not `{isRepo:false}`. Reporting a crashed git as "not a
      // repository" is the same confident lie the ambiguity refusal exists to
      // avoid: the caller would conclude there is nothing to see.
      return { ok: false, reason: `could not read the diff: ${String(err)}` };
    }
    const overflow = got.text.length > DIFF_CHAR_CAP;
    // Cut at a line boundary: a diff sliced mid-hunk still LOOKS like a valid
    // patch, which is worse than one that is visibly incomplete.
    let diff = got.text.slice(0, DIFF_CHAR_CAP);
    if (overflow) {
      const nl = diff.lastIndexOf('\n');
      diff = (nl > 0 ? diff.slice(0, nl) : diff) + '\n… [diff truncated]';
    }
    return { ok: true, value: { session, isRepo: got.isRepo, diff, truncated: overflow } };
  }
}
