// How `~/.claude.json`'s `projects` map is keyed — and the ONE place that knows
// (#724).
//
// ── WHY THIS MODULE EXISTS ───────────────────────────────────────────────────
//
// Because there were two answers to one question, and the difference was a
// silent bug. `sessions/trust.ts` normalised separators and stopped;
// `mcp/config.ts` normalised separators AND folded case on win32. Same file,
// same map, two keying rules — so auto-trust wrote `hasTrustDialogAccepted`
// under `c:/Projects/Foo` while the CLI read `C:/Projects/Foo`, and the feature
// was off while every layer reported success.
//
// The fix is not a third copy of the rule. It is one module both sides import,
// which is the same argument `shared/mcp.ts` makes for its wire types after
// `status` and `transport` drifted between hand-written copies (#618).
//
// ── CASE IS FOLDED ON WINDOWS ONLY, AND IT IS A HEURISTIC, NOT A TRUTH ───────
//
// `C:/foo` and `C:/Foo` are usually one directory on Windows and usually two on
// Linux. Folding case everywhere would merge two real projects' state into one;
// folding it nowhere is the bug above. The platform is a PARAMETER for the #127
// reason `launchSpec`, `win-cmd.ts` and the old `samePath` all cite: read from
// the ambient process, drive-letter tests pass on the maintainer's Windows
// machine and go red on the Linux CI leg, because the behaviour they assert
// exists on only one of them. Injected, both branches run on every runner.
//
// ⚠️ **"USUALLY" IS DOING REAL WORK IN BOTH DIRECTIONS, AND `samePath` KNOWS
// NEITHER.** A win32 UNC path can be served by a case-sensitive backend (a WSL
// share — measured, see `resolveProjectKeys`), and stock macOS is case-
// INSENSITIVE while this module treats darwin as sensitive. So `samePath` is a
// cheap candidate filter and nothing more; anything that ACTS on a match
// confirms it by resolution first. `resolveProjectKeys` does. The two known
// consequences:
//
//   • On macOS, a case-variant key is not matched, so #724's phantom-entry bug
//     is still reachable there. Known, unfixed, and worth its own ticket — the
//     shipping target is Windows and widening the fold would also change what
//     `mcp/config.ts` merges, which is a bigger decision than this item.
//   • `projectKey` rewrites `\` to `/` unconditionally, which on POSIX folds a
//     legal filename (`/home/dan/a\b`) into a path (`/home/dan/a/b`). Harmless
//     in practice — the CLI keys projects with forward slashes — but it means
//     "nothing folds off win32" would be too strong a claim to make.
//
// ── WHAT THIS MODULE DOES NOT DO ─────────────────────────────────────────────
//
// It does not tidy the collisions already in the user's config. A real
// `~/.claude.json` on the dev machine holds five folders under two spellings
// each — created by other tools over the repo's life, not by us. Rewriting
// somebody's live config to merge them is a far bigger decision than declining
// to add to the pile, and #724 scopes it out explicitly. This module's whole job
// is to WRITE WHERE THE CLI READS and never to invent a second spelling.

import fs from 'fs';

/**
 * The key Claude Code uses for a project: absolute path, forward slashes, no
 * trailing slash.
 *
 * NORMALISED DETERMINISTICALLY rather than through `path.resolve`, which on
 * POSIX treats a Windows `C:\…` path as relative and prepends cwd. This runs on
 * a Windows machine but the tests run cross-platform, and a helper that only
 * behaves on one of them is one nobody can test.
 *
 * Note this does NOT fold case — it is the spelling half of the job. Comparison
 * is `samePath`; choosing which spelling to write is `resolveProjectKeys`.
 */
export function projectKey(folder: string): string {
  return folder.replace(/\\/g, '/').replace(/\/+$/, '');
}

/**
 * Do two paths name the same folder?
 *
 * ⚠️ **IT IS NOT `===`, AND THAT WAS FOUND THE HARD WAY** (#632 probe,
 * 2026-08-25): a real `~/.claude.json` held two entries for one repo differing
 * only in the case of the drive letter —
 *
 *     'c:/Projects/Switchboard.ai'   ← one set of mcpServers
 *     'C:/Projects/Switchboard.ai'   ← another
 *
 * — because different tools resolved the same folder differently over the
 * repo's life. A `===` lookup finds whichever the CLI wrote last and reports the
 * other scope as empty, which reads on screen as "you have no local servers"
 * rather than as the ambiguity it is.
 *
 * Moved here from `mcp/config.ts` (#724). It was never really an MCP concern —
 * `main/index.ts` already imported it to gate session folders, which has nothing
 * to do with MCP — and leaving it there is what let the trust path grow a second
 * rule instead of importing this one.
 */
export function samePath(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  const norm = (p: string): string => {
    const slashed = projectKey(p);
    return platform === 'win32' ? slashed.toLowerCase() : slashed;
  };
  return norm(a) === norm(b);
}

/** Which keys name this folder, and how we decided. */
export interface ResolvedProjectKeys {
  /**
   * Every existing key **confirmed** to name this folder — or one
   * newly-normalised key when none does. Never empty.
   *
   * PLURAL, AND THAT IS THE FIX RATHER THAN A DETAIL. See `resolveProjectKeys`.
   */
  keys: readonly string[];
  /** true when nothing in the file named this folder, so `keys` is invented */
  created: boolean;
  /** true when more than one spelling matched and had to be disambiguated —
   *  the config is split for this folder and the caller should say so */
  ambiguous: boolean;
}

/** Excludes arrays and null, which `typeof x === 'object'` does not.
 *
 *  `~/.claude.json` is hand-edited by users and written by a CLI that grows
 *  fields, so neither `projects` nor an entry inside it can be assumed to be a
 *  plain object. Without this, an ARRAY `projects` passes the type check,
 *  `Object.keys` yields indices, and the caller's write lands on a property
 *  `JSON.stringify` drops — a silent no-op that still reports success, which is
 *  the exact failure mode #724 is about. Same guard `mcp/config.ts` uses. */
export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** `fs.realpathSync.native`, or `null` if the path cannot be resolved.
 *
 *  Injected by `resolveProjectKeys` so the disambiguation is testable without a
 *  filesystem, and so a stale key naming a folder that no longer exists is a
 *  `null` rather than a throw. */
function resolvePath(p: string): string | null {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return null;
  }
}

/**
 * Which keys in `projects` name this folder — reusing the spellings already
 * there, and inventing one only when none is (#724).
 *
 * ⚠️ **DO NOT INVENT A SPELLING FOR A FOLDER THE CLI ALREADY KNOWS.** That is
 * the whole bug — and the rule holds for CASE and SEPARATOR STYLE, which is what
 * actually varies in practice. It does not catch every way one folder can be
 * written: separator runs, 8.3 short names (`RUNNER~1`), trailing dots,
 * junctions and `subst` drives all still miss and still create a phantom. Every
 * one of those fails SAFE — a missed match, never a false merge — which is why
 * they are a known limit rather than a hole.
 *
 * Windows hands us `c:\Projects\Foo` readily — drag-and-drop, shell
 * integrations, a path echoed back from a tool — and writing our own normalised
 * form creates a SECOND entry beside the CLI's. Auto-trust then writes
 * `hasTrustDialogAccepted` where nothing reads it, the trust dialog the user
 * opted out of appears anyway, and the caller returns success because its own
 * write worked. Worse on the second run: our phantom key now says
 * `hasTrustDialogAccepted === true`, so the short-circuit fires and we never
 * even retry.
 *
 * ── WHY IT RETURNS ALL OF THEM, NOT A CHOSEN ONE ─────────────────────────────
 *
 * #724 suggested picking one — prefer the entry carrying `hasTrustDialogAccepted`,
 * then the fuller one. **That rule defeats the feature in precisely the case
 * this ticket is about**, and a mutation test is what surfaced it: when our own
 * phantom key is the flagged one and the CLI's real entry is not, "prefer the
 * flagged one" short-circuits on the phantom and the real entry stays untrusted.
 * The bug survives its own fix.
 *
 * There is also no way to know which spelling the CLI will read next — that
 * depends on how it normalises the path on a future run, which is the thing we
 * cannot observe. So the caller acts on **every** entry that names the folder.
 *
 * ── ⚠️ AND WHY SPELLING ALONE IS NOT ALLOWED TO DECIDE THAT ──────────────────
 *
 * A first draft argued that acting on every `samePath` match was safe because
 * case is folded on win32 only, "where two spellings are the same directory by
 * definition". **That is false, and it was measured false on the machine this
 * was written on** (2026-08-30):
 *
 *     //wsl.localhost/Ubuntu-24.04/home/dheinz/sbcase-Foo  ─┐ created BOTH,
 *     //wsl.localhost/Ubuntu-24.04/home/dheinz/sbcase-foo  ─┘ realpath differs
 *
 * A UNC path is a win32 path served by a possibly case-SENSITIVE backend — a
 * WSL share, Samba, NFS, or an NTFS directory flagged with
 * `fsutil file setCaseSensitiveInfo` (which is the default for WSL-created
 * directories). This is not hypothetical here: the dev machine's own
 * `~/.claude.json` already carries a `//wsl.localhost/...` project key.
 *
 * Writing a trust flag to a directory the user never opened is not a cosmetic
 * mistake — `hasTrustDialogAccepted` is what lets that folder's own
 * `.claude/settings.json` and hooks run. So more than one candidate is
 * confirmed **by resolution, not by spelling**, which is the rule `main/index.ts`
 * already states for the session-folder gate: *a path has many true spellings
 * and exactly one resolution* (learned when Windows CI handed out `RUNNER~1`
 * short names).
 *
 * `samePath` stays as the cheap candidate filter — one string compare per key
 * beats a syscall per key — and the filesystem is only consulted for the rare
 * folder that matched twice.
 *
 * ── WHEN RESOLUTION IS UNAVAILABLE ───────────────────────────────────────────
 *
 * A disconnected share, a deleted folder, a permissions error: `resolvePath`
 * answers `null` and we fall back to **one** key rather than several — the exact
 * spelling if the file has it, otherwise the first match. Narrower than ideal
 * and never wrong: the failure mode is the old missed-trust, not a trust granted
 * somewhere it was not earned.
 *
 * What this still does NOT do is tidy up: no key is created for a folder that
 * has one, none is deleted, and no field outside the caller's own is touched.
 */
export function resolveProjectKeys(
  projects: unknown,
  folder: string,
  platform: NodeJS.Platform = process.platform,
  /** injected so the disambiguation is testable without a filesystem */
  realpath: (p: string) => string | null = resolvePath
): ResolvedProjectKeys {
  realpath = realpath ?? resolvePath;
  const fallback = projectKey(folder);
  const invented = { keys: [fallback], created: true, ambiguous: false };
  if (!isRecord(projects)) return invented;
  const candidates = Object.keys(projects).filter((k) => samePath(k, folder, platform));
  if (candidates.length === 0) return invented;
  if (candidates.length === 1) return { keys: candidates, created: false, ambiguous: false };

  // MORE THAN ONE SPELLING MATCHED. Spelling has told us all it can; ask the
  // filesystem which of them are actually this folder.
  const mine = realpath(folder);
  if (mine === null) {
    const exact = candidates.find((k) => k === fallback) ?? candidates[0];
    return { keys: [exact], created: false, ambiguous: true };
  }
  const confirmed = candidates.filter((k) => {
    const there = realpath(k);
    return there !== null && there === mine;
  });
  // None of them resolved to this folder — they are other directories that
  // merely spell alike. Treat the folder as unknown to the file, which is what
  // it is.
  if (confirmed.length === 0) return { ...invented, created: !candidates.includes(fallback) };
  return { keys: confirmed, created: false, ambiguous: true };
}
