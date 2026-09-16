// A folder's PAST CONVERSATIONS, described well enough to recognise (P2-E20-01,
// §5.33).
//
// switchboard can only open a conversation some card already points at — a
// handful of the 3,037 transcripts on the owner's machine. This module is the
// listing that makes the rest reachable: ids, when they were last active, and
// the one thing `listConversations` cannot answer, WHICH CONVERSATION IT IS.
//
// ── IT IS A DESCRIPTION LAYER, NOT A SECOND SCANNER ────────────────────────
//
// The ids, the mtimes and the 500-entry refusal are `listConversations`' and are
// used as they are. What is added here is a bounded read of each transcript's
// HEAD, and that is the whole cost of this feature — so the rules about what may
// be read are stated once, here, rather than per caller. #722's activity report
// wants the same scan over a date range and should grow from this module rather
// than starting a second one (§5.33 says so explicitly).
//
// ── WHAT ONE HEAD WINDOW CAN ANSWER, MEASURED ──────────────────────────────
//
// Probed 2026-09-16 over the 200 most recently written transcripts on the
// owner's machine (`spike/findings/e20-836-transcript-head.md`), reading only
// the first `PACKAGE_HEAD_BYTES`:
//
//   * `cwd`      — 200/200, first carried on average at line 2.0
//   * `ai-title` — 192/200, the LAST one never later than line 18, and not one
//                  transcript carried two
//   * a real first user prompt — 200/200
//   * neither a title nor a prompt — 0/200
//
// So one window answers both questions for every transcript sampled, and the
// title is at the very front rather than scattered — which is why there is no
// tail read here and no second pass. The three transcripts whose `ai-title` sits
// PAST the window (found by scanning those files whole) fall back to their first
// prompt, which is what the CLI's own picker shows anyway, so they are described
// rather than blank.
//
// `summary` is measured at 0/200 and is not a source — anything built on it
// would render blank for every conversation on this machine (§5.33).
//
// ── FAIL-OPEN (P6) ─────────────────────────────────────────────────────────
//
// A transcript that will not read is a row with no description, never a lost
// listing: the id, the folder and the last-active time are still true, and the
// user can still recognise a conversation by when they had it.
import fs from 'fs';
import path from 'path';
import {
  ConversationHistory,
  ConversationHistoryRequest,
  ConversationRow,
  MAX_HISTORY_ROWS,
} from '../../shared/session-history';
import { commandInvocation } from '../../shared/command-invocation';
import { blocksFrom } from '../sessions/transcript-blocks';
import { PACKAGE_CAPS, promptText } from '../sessions/context-package';
// The head budget belongs to the question "where does the opening prompt live",
// which `SessionQueries` asked first (#766) and sized against a real fixture.
// Imported rather than re-chosen: two budgets for one window is how the picker
// and the context package would come to disagree about which conversations have
// an opening prompt at all.
import { PACKAGE_HEAD_BYTES } from '../sessions/queries';
import { readTranscriptHead } from '../feed/history';
import { isConversationId, listConversations, MAX_LISTED_CONVERSATIONS } from './paths';

/** What this module needs from the rest of the app, injected rather than imported. */
export interface HistoryDeps {
  /**
   * Where the provider writes transcripts — the host's already-resolved root.
   *
   * Passed in rather than read from the Claude adapter, for the reason
   * `start-plan.ts` resolves it once per session start (#432): a listing that
   * answered about a different directory than the resume path reads would offer
   * conversations that cannot be opened.
   */
  projectsRoot: string;
  /**
   * The provider's `titles` capability (§5.3), injected.
   *
   * NOT an import of `readAiTitle`. This module lives under `transcripts/` and
   * must not know which CLI wrote the file — an adapter is what knows that a
   * title is spelled `ai-title`, and importing the Claude adapter here would
   * invert exactly the seam `paths.ts` was split out to establish. A provider
   * with no titles simply has every row described by its first prompt.
   */
  readTitle?: (line: Record<string, unknown>) => string | undefined;
  /**
   * Every conversation id a card already holds — heads, ancestors and ceded
   * ids alike.
   *
   * A picked conversation that another card is in must not be opened twice:
   * plain `--resume` APPENDS to the transcript rather than forking it (measured
   * 2026-08-15, recorded in the Claude adapter), so two cards in one
   * conversation means two cards writing one file. The rows say which, and the
   * create path refuses it again — the UI's answer is a courtesy, not the
   * guard.
   */
  claimed: () => string[];
}

/**
 * How many project directories the all-projects scope will enumerate.
 *
 * The owner's root holds 3,037 transcripts across hundreds of directories, and
 * this runs on the main process. The cap is on DIRECTORIES rather than bytes
 * because enumerating one is a `readdir` plus a `stat` per entry, and the rows
 * that survive the newest-first sort come from a handful of them.
 */
export const MAX_HISTORY_DIRS = 400;

/** A described row, cached against the file identity it was derived from. */
interface Described {
  size: number;
  mtimeMs: number;
  folder: string;
  description: string;
  descriptionFrom: ConversationRow['descriptionFrom'];
}

/**
 * Descriptions, keyed by transcript path and invalidated on `(size, mtimeMs)`.
 *
 * The same shape and the same reason as the watcher's `headCache`: reopening
 * the picker on a folder nothing has written to is free, and a conversation
 * that HAS been written to is re-read because its title may have arrived since.
 * Cleared wholesale at the ceiling rather than evicted one by one — this is a
 * cache over a user's history, not a hot loop, and a simple bound is one fewer
 * thing to get wrong.
 */
const cache = new Map<string, Described>();
const CACHE_MAX = 1_000;

/** Drop the memoised descriptions. Exported for tests, which need to prove the
 *  cache is keyed on file identity rather than merely that it returns. */
export function clearHistoryCache(): void {
  cache.clear();
}

/**
 * The past conversations for a scope, newest first.
 *
 * Synchronous on purpose, and bounded by the two caps above rather than by
 * time: the caller (`transcripts:history`) is async and yields around it, which
 * is what keeps the UI responsive. Making the file reads async would interleave
 * them with the very `readdir`s they depend on for no measured gain.
 */
export function listHistory(req: ConversationHistoryRequest, deps: HistoryDeps): ConversationHistory {
  const limit = Math.max(1, Math.min(req.limit ?? MAX_HISTORY_ROWS, MAX_HISTORY_ROWS));
  const found =
    req.scope === 'all' ? everyProject(deps.projectsRoot) : oneFolder(deps.projectsRoot, req.folder);
  if (found.status !== 'ok') return found;
  // Newest first, then capped — so the cap takes the most recent conversations
  // rather than whichever directory was enumerated first.
  const picked = found.files.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, limit);
  const claimed = new Set(safely(deps.claimed, []));
  const rows: ConversationRow[] = [];
  for (const f of picked) {
    const d = describe(f.file, deps.readTitle);
    // The FOLDER-scoped answer knows its own folder and says so even when the
    // transcript's `cwd` could not be read — the caller named it, and a row
    // that cannot say where it belongs cannot be opened. The all-projects scope
    // has no such authority: a transcript whose `cwd` is unreadable is dropped
    // there rather than guessed at from the directory name, which is
    // `slugForCwd`'s output and not invertible.
    const folder = req.scope === 'all' ? d.folder : (req.folder ?? d.folder);
    if (!folder) continue;
    rows.push({
      nativeId: f.nativeId,
      folder,
      description: d.description,
      descriptionFrom: d.descriptionFrom,
      lastActiveMs: f.mtimeMs,
      claimed: claimed.has(f.nativeId),
    });
  }
  return { status: 'ok', rows, truncated: found.truncated || found.files.length > picked.length };
}

/** One folder, through the existing listing — including its refusals. */
function oneFolder(
  projectsRoot: string,
  folder: string | undefined
): Found | { status: 'unknown'; reason: string } {
  if (!folder) return { status: 'unknown', reason: 'no folder was named' };
  const listed = listConversations(projectsRoot, folder);
  // `unknown` is passed straight through — a directory we could not read, or one
  // past MAX_LISTED_CONVERSATIONS. §5.33: reported as unscannable, never
  // silently truncated.
  if (listed.status !== 'ok') return listed;
  return { status: 'ok', files: listed.conversations, truncated: false };
}

interface Found {
  status: 'ok';
  files: { nativeId: string; file: string; mtimeMs: number }[];
  truncated: boolean;
}

/**
 * Every project directory under the root.
 *
 * A directory past `MAX_LISTED_CONVERSATIONS` is SKIPPED here rather than
 * failing the whole answer, which is the one place this departs from
 * `listConversations`' all-or-nothing refusal — and deliberately: refusing to
 * show the user any history at all because one unrelated project has 6,000
 * conversations in it would be a worse answer than a complete list of the other
 * three hundred. It is not silent: `truncated` says so and the picker tells the
 * user, which is the property §5.33 actually asks for.
 */
function everyProject(projectsRoot: string): Found | { status: 'unknown'; reason: string } {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(projectsRoot, { withFileTypes: true });
  } catch (err) {
    // `unknown` even for ENOENT, for `conversationDirs`' reason: a missing root
    // is evidence we are not looking where the CLI writes, not evidence that the
    // user has no history.
    return { status: 'unknown', reason: `${projectsRoot}: ${String(err)}` };
  }
  const all = entries.filter((d) => d.isDirectory());
  let truncated = all.length > MAX_HISTORY_DIRS;
  // NEWEST PROJECTS FIRST, and that is the whole reason this costs a stat per
  // directory. The ROW cap is carefully newest-first, but a directory cap taken
  // in `readdir` order is filesystem order — unrelated to recency — so on a root
  // with more than `MAX_HISTORY_DIRS` projects the one dropped could be the one
  // worked in this morning, with only "some projects were skipped" to show for
  // it. A project directory's mtime moves when a conversation in it is created,
  // which is close enough to "recently used" for choosing what to look at.
  const dirs = all
    .map((d) => {
      const full = path.join(projectsRoot, d.name);
      let mtimeMs = 0;
      try {
        mtimeMs = fs.statSync(full).mtimeMs;
      } catch {
        // Unreadable: sorts last rather than being dropped here, so it still
        // gets its turn if there is room, and still reports through `truncated`
        // if its listing fails below.
      }
      return { full, mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, MAX_HISTORY_DIRS);
  const files: Found['files'] = [];
  for (const { full: dir } of dirs) {
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      // One unreadable project directory is not a reason to refuse the rest.
      truncated = true;
      continue;
    }
    if (names.length > MAX_LISTED_CONVERSATIONS) {
      truncated = true;
      continue;
    }
    for (const name of names) {
      // `subagents/` never arrives here: a subagent transcript lives one
      // directory deeper (`<project>/subagents/agent-*.jsonl`), and this reads
      // only the direct children that end in `.jsonl`. Pinned by a test, because
      // the day this recurses is the day 68,997 sidechain files join the list.
      if (!name.toLowerCase().endsWith('.jsonl')) continue;
      const nativeId = name.slice(0, -'.jsonl'.length);
      if (!isConversationId(nativeId)) continue;
      const file = path.join(dir, name);
      try {
        const st = fs.statSync(file);
        if (st.isFile() && st.size > 0) files.push({ nativeId, file, mtimeMs: st.mtimeMs });
      } catch {
        // vanished or unreadable between the readdir and the stat — not in the
        // list, and not a reason to fail the other three hundred directories
      }
    }
  }
  return { status: 'ok', files, truncated };
}

/**
 * What one transcript IS, from a bounded read of its head.
 *
 * Two answers from one window (see the header's measurements): the `cwd` it was
 * recorded in, and a description — the provider's own title when it has one,
 * else the first user prompt.
 */
function describe(
  file: string,
  readTitle: HistoryDeps['readTitle']
): { folder: string; description: string; descriptionFrom: ConversationRow['descriptionFrom'] } {
  let id: { size: number; mtimeMs: number };
  try {
    const st = fs.statSync(file);
    id = { size: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return { folder: '', description: '', descriptionFrom: 'none' };
  }
  const hit = cache.get(file);
  if (hit && hit.size === id.size && hit.mtimeMs === id.mtimeMs) {
    return { folder: hit.folder, description: hit.description, descriptionFrom: hit.descriptionFrom };
  }
  const head = readTranscriptHead(file, PACKAGE_HEAD_BYTES);
  let folder = '';
  let title: string | undefined;
  for (const entry of head.entries) {
    if (!folder && typeof entry.cwd === 'string' && entry.cwd) folder = entry.cwd;
    // The LAST title in the window wins. Measured: no sampled transcript carries
    // two, so this is about the contract rather than the data — a title the CLI
    // revised is a title it changed its mind about, and showing the earlier one
    // would describe the conversation as it was first understood.
    if (readTitle) {
      const t = safely(() => readTitle(entry), undefined);
      if (t) title = t;
    }
  }
  let description = title ?? '';
  let descriptionFrom: ConversationRow['descriptionFrom'] = title ? 'title' : 'none';
  if (!description) {
    // Only when there is no title — 8/200 of the sample, so the expensive path
    // is also the rare one. `promptText` rather than "the first line whose type
    // is user": it already excludes `isMeta` plumbing, `tool_result` carriers
    // and a subagent's sidechain brief, and renders an attachment-only opening
    // turn as words. A second first-prompt rule here would drift from the one
    // `SessionQueries` already uses.
    const first = safely(() => {
      // ONE pass, two answers. Prose wins: `promptText` skips slash-command
      // invocations (#846), so a conversation that opens with `/clear` and then
      // asks a real question is described by the question — the whole point.
      //
      // The command is remembered as we go rather than found by a second walk
      // over the same window: a second `blocksFrom` would re-parse 128 KB for
      // the 8-in-200 no-title rows, and two loops over one window is how the
      // two rules would eventually drift apart.
      let command: string | undefined;
      for (const block of blocksFrom(head.entries, PACKAGE_CAPS)) {
        const text = promptText(block);
        if (text !== undefined) return text;
        // NOTHING BUT COMMANDS is a real conversation shape, and this is the
        // difference between a useful row and a blank one. A row must say
        // something, so it says what the user actually ran — `/clear`,
        // `/next-item 818`. The context package deliberately does NOT do this:
        // a session goal of "/clear" is worse than admitting there is none.
        if (!command && block.kind === 'user' && !block.sidechain) {
          command = commandInvocation(block.text ?? '') ?? undefined;
        }
      }
      return command;
    }, undefined);
    if (first) {
      description = first;
      descriptionFrom = 'prompt';
    }
  }
  const described: Described = { ...id, folder, description: trim(description), descriptionFrom };
  if (cache.size >= CACHE_MAX) cache.clear();
  cache.set(file, described);
  return {
    folder: described.folder,
    description: described.description,
    descriptionFrom: described.descriptionFrom,
  };
}

/**
 * A row's worth of words.
 *
 * Bounded HERE rather than in the renderer because it crosses IPC: a
 * conversation opening with a 40 KB pasted stack trace would otherwise send all
 * of it to draw one line of text, three hundred times over.
 */
const DESCRIPTION_CHARS = 200;

function trim(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > DESCRIPTION_CHARS ? `${flat.slice(0, DESCRIPTION_CHARS - 1)}…` : flat;
}

/** Run an injected dependency, treating a throw as its empty answer (P6) — the
 *  same guard `queries.ts` uses, and for the same reason: the never-throw
 *  promise this module makes cannot be kept by trusting code it does not own. */
function safely<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}
