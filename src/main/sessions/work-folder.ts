// Where a card's agent is working NOW, apart from where the card was started
// (#1616), and where its conversation may be FILED (#1616, #1643).
//
// THREE FOLDERS, THREE QUESTIONS. They are the same folder for nearly every
// card, which is exactly why they were one field until now:
//
//   identity.folder  where the card STARTS its session. The renderer's panel
//                    params carry it, and `sessions:create` spawns there.
//   workFolder       where the agent is working now, when that is somewhere
//                    else: Claude's own `EnterWorktree` moved it (#1616). The
//                    Changes, history and diff views and the card's project
//                    section follow this one. Absent = identity.folder.
//   conversation     which folders' transcript directories may hold the
//                    card's conversation. Claude files a conversation under a
//                    slug of the folder it runs in, and MOVES the file when
//                    the agent enters or leaves a worktree (measured,
//                    `spike/findings/1616-enter-worktree.md`; the move can
//                    fail and leave it where it was). So a resume check that
//                    looks only under identity.folder misses a conversation
//                    that followed its agent into a worktree.
//
// P7: none of this moves the agent. The CLI decides; the host re-points its
// own views at what the CLI reported.
import path from 'path';
import { pathKey } from '../../shared/projects';
import type { WorkdirEvent } from './engine-events';

/** Longest folder path believed off the engine's word. */
export const MAX_WORK_FOLDER = 4096;

/** The fields of a persisted card this module reads. */
export interface WorkPlaceCard {
  identity: { folder: string };
  workFolder?: string;
  /**
   * The folder whose transcript directory holds the card's conversation, when
   * it is neither the start folder nor the work folder (#1643): a conversation
   * reopened from History after its own folder was removed. Absent for every
   * other card.
   */
  filedUnder?: string;
}

/** What a `workdir` event changes on a card. */
export interface WorkPlaceChange {
  /** the card's new `workFolder`; undefined = back in its start folder */
  workFolder: string | undefined;
  /** the Feed line to draw, for a real move; none for a restatement */
  marker?: 'entered' | 'left';
}

const same = (a: string, b: string): boolean => pathKey(a) === pathKey(b);

/**
 * Is this a folder path we will believe at all? Absolute on either platform's
 * rules (a Windows path read on a Linux test runner is still a Windows path),
 * bounded, no NUL. Existence is the caller's check — it needs the disk.
 */
export function isPlausibleFolder(p: unknown): p is string {
  if (typeof p !== 'string' || !p.trim() || p.length > MAX_WORK_FOLDER || p.includes('\0')) return false;
  return path.isAbsolute(p) || path.win32.isAbsolute(p);
}

/**
 * What a `workdir` event does to this card, or `null` for nothing.
 *
 * - An unusable folder (not absolute, not a directory) changes nothing (P6).
 * - `entered` / `left` set the work folder and draw a Feed line, unless the
 *   card is already there (a repeated result draws nothing twice).
 * - `reported` CORRECTS a card that already believes it moved, and never
 *   starts one moving: a session's own folder spelled another way (a junction,
 *   an 8.3 name) must not read as a move. It draws nothing.
 *
 * Arriving back at the start folder clears `workFolder`, so a card that came
 * home is byte-for-byte a card that never left.
 */
export function nextWorkPlace(
  card: WorkPlaceCard,
  ev: WorkdirEvent,
  isDirectory: (p: string) => boolean
): WorkPlaceChange | null {
  if (!isPlausibleFolder(ev.cwd)) return null;
  const home = same(ev.cwd, card.identity.folder);
  const next = home ? undefined : ev.cwd;
  const current = card.workFolder;
  const unchanged = next === undefined ? current === undefined : current !== undefined && same(current, next);
  if (unchanged) return null;
  if (ev.move === 'reported' && current === undefined) return null;
  // last, because it touches the disk: only for a change we would make
  if (!isDirectory(ev.cwd)) return null;
  if (ev.move === 'reported') return { workFolder: next };
  return { workFolder: next, marker: ev.move };
}

/** Where this card's agent is working: its work folder, else its start folder. */
export function workFolderOf(card: WorkPlaceCard): string {
  return card.workFolder ?? card.identity.folder;
}

/**
 * The folders, OTHER than `runFolder`, whose transcript directories may hold
 * this card's conversation — the ones a resume check should also look in.
 * Bounded by construction (at most three), de-duplicated by path key, and
 * never `runFolder` itself (the caller already looks there).
 */
export function otherConversationFolders(card: WorkPlaceCard | undefined, runFolder: string): string[] {
  if (!card) return [];
  const out: string[] = [];
  for (const f of [card.workFolder, card.filedUnder, card.identity.folder]) {
    if (!isPlausibleFolder(f) || same(f, runFolder) || out.some((o) => same(o, f))) continue;
    out.push(f);
  }
  return out;
}

/**
 * A card's `workFolder` and `filedUnder` once `sessions:create` has decided
 * how it starts — ALWAYS both keys, `undefined` meaning "drop it", so the
 * caller can spread this over the prior card.
 *
 * - **Resumed:** the agent is put back where it last worked by the CLI itself
 *   (measured), so `workFolder` stays — unless that folder is gone (a worktree
 *   removed since, #1638). `filedUnder` becomes where the resume check FOUND
 *   the conversation, when that is neither the run folder nor the work folder.
 * - **Not resumed** (fresh, or the check could not see it this time): the
 *   session runs where it starts, so `workFolder` goes — but the folder its
 *   conversation was filed under is KEPT as `filedUnder` (#484's rule: a
 *   declined resume must never sever the link to a conversation that may
 *   still be on disk; the next start looks there again).
 */
export function placeAfterStart(
  prior: WorkPlaceCard | undefined,
  start: { runFolder: string; resumed: boolean; resumeFolder?: string; isDirectory: (p: string) => boolean }
): { workFolder: string | undefined; filedUnder: string | undefined } {
  if (!prior) {
    const filed = start.resumed && start.resumeFolder && !same(start.resumeFolder, start.runFolder) ? start.resumeFolder : undefined;
    return { workFolder: undefined, filedUnder: filed };
  }
  if (start.resumed) {
    const workFolder = prior.workFolder && start.isDirectory(prior.workFolder) ? prior.workFolder : undefined;
    const found = start.resumeFolder;
    const filedUnder =
      found && !same(found, start.runFolder) && !(workFolder && same(found, workFolder)) ? found : undefined;
    return { workFolder, filedUnder };
  }
  return { workFolder: undefined, filedUnder: prior.filedUnder ?? prior.workFolder };
}

/**
 * A `workFolder` / `filedUnder` read off the workspace file: kept only if it is
 * a plausible folder that is not the start folder. Anything else is dropped,
 * which is the card as it was before these fields existed.
 */
export function sanitizeWorkPlace<T extends WorkPlaceCard>(card: T): T {
  const fix = (v: unknown): string | undefined =>
    isPlausibleFolder(v) && !same(v, card.identity.folder) ? v : undefined;
  const workFolder = fix(card.workFolder);
  const filedUnder = fix(card.filedUnder);
  if (workFolder === card.workFolder && filedUnder === card.filedUnder) return card;
  const out: T = { ...card };
  if (workFolder === undefined) delete out.workFolder;
  else out.workFolder = workFolder;
  if (filedUnder === undefined) delete out.filedUnder;
  else out.filedUnder = filedUnder;
  return out;
}
