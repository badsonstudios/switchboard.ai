// Where a provider's transcripts live on disk, and whether a given conversation
// is really there.
//
// Split out of `watcher.ts` in P2-E15-01. These are pure path/fs helpers about
// a transcript LAYOUT, and the provider adapters need them to answer §5.3's
// `resume` capability — an adapter importing the host's watcher to ask "does
// this file exist" inverts the dependency the seam exists to establish (the
// host asks the adapter, not the other way round). `watcher.ts` re-exports both
// so existing consumers are unaffected.
import fs from 'fs';
import path from 'path';

/** The directory name a provider derives from a project folder. */
export function slugForCwd(cwd: string): string {
  return cwd.replace(/[\\/:. ]/g, '-');
}

/**
 * Does a resumable conversation actually exist for this session id? Claude
 * only writes the transcript once a real turn happens, so `--resume <id>` on
 * a session that never got a prompt errors with "No conversation found" and
 * exits — checking the file first lets us fall back to a fresh session.
 * Slug matched case-insensitively (real paths lowercase the drive letter).
 */
export function conversationExists(projectsRoot: string, folder: string, nativeId: string): boolean {
  return conversationFile(projectsRoot, folder, nativeId) !== null;
}

/**
 * WHERE that conversation's transcript is, or null if it is not there.
 *
 * The same question `conversationExists` asks — it is now this function's
 * boolean — because #395 needs the PATH: a resumed Direct session replays the
 * history off this file into its Feed, since the CLI re-sends none of it over
 * the stream.
 *
 * ONE RESOLVER, so "is this resumable" and "where do I read it back from" cannot
 * answer differently for the same directory — and since #432, not about two
 * different directories either: the root is no longer something an adapter
 * derives per question. `planSessionStart` reads `transcripts.projectsRoot()`
 * ONCE per session start and hands that single string to `resume.canResume`
 * (via `ResumeQuery`), to the transcript watcher, and to #395's replay. An
 * adapter answering "yes" here is answering about a file the host will really
 * read — which matters from Phase 4 on, when these strings become third-party.
 */
export function conversationFile(
  projectsRoot: string,
  folder: string,
  nativeId: string
): string | null {
  const found = locateConversation(projectsRoot, folder, nativeId);
  return found.status === 'found' ? found.file : null;
}

/**
 * The answer `conversationFile` flattens: WHERE the transcript is, or WHY it is
 * not being returned — and those are two different whys (#484).
 *
 * `absent` means we looked and it is really not there. `unknown` means we could
 * not look: the root would not list, or the file would not stat for a reason
 * other than "no such file" — an antivirus scan, an indexer's oplock, a network
 * drive between reconnects. Both DECLINE a resume, because a conversation we
 * cannot see is one `--resume` would crash on. They must not be the same answer
 * to the caller, though, because one of them used to be permanent: the session
 * IPC read a declined resume as "that conversation is gone" and persisted
 * `nativeSessionId: undefined` over the card, so a single mistimed file lock
 * severed the link to a conversation that was sitting on disk the whole time.
 *
 * An id that is not a plausible conversation id is `absent`, not `unknown` — we
 * did not fail to look, we declined to, and the answer will never change.
 */
export type ConversationLookup =
  | { status: 'found'; file: string }
  | { status: 'absent' }
  | { status: 'unknown'; reason: string };

export function locateConversation(
  projectsRoot: string,
  folder: string,
  nativeId: string
): ConversationLookup {
  // The id is interpolated into a path below, and it reaches us from the
  // persisted workspace store and from hook payloads. A native id is a uuid
  // shape; anything else is not a conversation we wrote, and `..` would turn
  // this into an existence oracle for arbitrary files (§5.29 — validate where
  // the untrusted value enters, not where it lands).
  if (!isConversationId(nativeId)) return { status: 'absent' };
  const dirs = conversationDirs(projectsRoot, folder);
  if (dirs.status !== 'ok') return dirs;
  // A stat that fails for a reason OTHER than absence is the whole point of
  // this function. Remembered rather than returned immediately, because a
  // second directory could still match the slug and hold the real file — the
  // uncertainty only decides the answer once nothing was found.
  let couldNotLook = '';
  for (const dir of dirs.dirs) {
    const full = path.join(dir, `${nativeId}.jsonl`);
    try {
      if (fs.statSync(full).isFile()) return { status: 'found', file: full };
    } catch (err) {
      if (!isMissing(err)) couldNotLook ||= `${full}: ${String(err)}`;
    }
  }
  return couldNotLook ? { status: 'unknown', reason: couldNotLook } : { status: 'absent' };
}

/** Is this string shaped like a conversation id at all? */
export function isConversationId(nativeId: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(nativeId);
}

/**
 * Every conversation this provider has on disk for `folder`, newest first.
 *
 * The repair sweep's evidence (#484): a card whose stored id has no file needs
 * to know what IS in its project directory before it can reattach. Newest-first
 * because the conversation a card lost is the one it was last in, and `--resume`
 * touches the parent transcript on its way past.
 *
 * `unknown` for the same reason as `locateConversation` — a directory we could
 * not read must never look like a directory with nothing in it, or the sweep
 * would conclude "this card has no history anywhere" from a file lock.
 */
export type ConversationListing =
  | { status: 'ok'; conversations: { nativeId: string; file: string; mtimeMs: number }[] }
  | { status: 'unknown'; reason: string };

/**
 * Past this many transcripts in one project directory, we decline to list it.
 *
 * Two reasons, and they point the same way. This runs SYNCHRONOUSLY on the main
 * process inside `sessions:create`, and it stats every file: measured at
 * 124-133 ms warm for a real 6,259-file directory on the owner's machine, and
 * seconds cold or mid-scan. And a folder with thousands of conversations in it
 * is exactly where the only question this listing answers — "which one did this
 * card lose?" — is least answerable, because almost all of them belong to
 * `claude` sessions run by hand that no card ever knew about.
 *
 * So the cap is not a truncation: it reports `unknown`, which every caller reads
 * as "do not guess". A big folder gets the same answer as an unreadable one,
 * which is the correct one for both.
 */
export const MAX_LISTED_CONVERSATIONS = 500;

export function listConversations(projectsRoot: string, folder: string): ConversationListing {
  const dirs = conversationDirs(projectsRoot, folder);
  if (dirs.status !== 'ok') return dirs;
  const conversations: { nativeId: string; file: string; mtimeMs: number }[] = [];
  for (const dir of dirs.dirs) {
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch (err) {
      return { status: 'unknown', reason: `${dir}: ${String(err)}` };
    }
    // checked BEFORE the stat loop — the point is not to pay for it
    if (names.length > MAX_LISTED_CONVERSATIONS) {
      return {
        status: 'unknown',
        reason: `${dir}: ${names.length} entries is past the ${MAX_LISTED_CONVERSATIONS} this will scan`,
      };
    }
    for (const name of names) {
      if (!name.toLowerCase().endsWith('.jsonl')) continue;
      const nativeId = name.slice(0, -'.jsonl'.length);
      if (!isConversationId(nativeId)) continue;
      const file = path.join(dir, name);
      try {
        const st = fs.statSync(file);
        if (st.isFile() && st.size > 0) conversations.push({ nativeId, file, mtimeMs: st.mtimeMs });
      } catch (err) {
        // A file that VANISHED between the readdir and the stat is simply not in
        // the list — that is a conversation being deleted while we look, and the
        // listing is still true of everything else.
        //
        // Any OTHER stat failure fails the whole listing. The only question this
        // answers is "which conversation did this card lose?", and a file we
        // could not read is a candidate we cannot rule in OR out — so a listing
        // missing it is not a listing whose "newest unclaimed" means anything.
        // Same rule as the directory: uncertainty is reported, never silently
        // dropped.
        if (!isMissing(err)) return { status: 'unknown', reason: `${file}: ${String(err)}` };
      }
    }
  }
  conversations.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return { status: 'ok', conversations };
}

/** The directories under `projectsRoot` that hold `folder`'s conversations.
 *  Slug matched case-insensitively (real paths lowercase the drive letter). */
function conversationDirs(
  projectsRoot: string,
  folder: string
): { status: 'ok'; dirs: string[] } | { status: 'unknown'; reason: string } {
  const wantSlug = slugForCwd(folder).toLowerCase();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(projectsRoot, { withFileTypes: true });
  } catch (err) {
    // Deliberately `unknown` even for ENOENT. A missing root is not evidence
    // that a card's conversation is gone — it is evidence that we are not
    // looking where the CLI writes (a HOME the app read differently this
    // launch, a profile still mounting), and treating it as absence would
    // condemn every card in the workspace at once on the strength of one
    // failed readdir.
    return { status: 'unknown', reason: `${projectsRoot}: ${String(err)}` };
  }
  const dirs: string[] = [];
  for (const d of entries) {
    if (d.isDirectory() && d.name.toLowerCase() === wantSlug) dirs.push(path.join(projectsRoot, d.name));
  }
  return { status: 'ok', dirs };
}

function isMissing(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}
