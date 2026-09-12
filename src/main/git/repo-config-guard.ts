// #776: stop a session's OWN repository config from making switchboard run a
// command while it reads that session's working tree.
//
// #764 closed `diff.external` with `--no-ext-diff`. Probing #772 found the same
// class of hole still open through two more knobs, and probing this item found
// two more again — everything below is measured, on git 2.51.0.windows.2, by
// `spike/probes/776/probe-filter-mitigations.mjs` and `probe-round2.mjs`:
//
//   core.fsmonitor              RAN during diff-index AND status
//   filter.<n>.clean            RAN during diff-index AND status
//   filter.<n>.process          RAN during diff-index AND status
//   .git/hooks/post-index-change  RAN during status — WITH NO CONFIG AT ALL
//   a SUBMODULE's own config      RAN during the superproject's reads
//
// The threat is #764's: an agent allowed to EDIT files (`.git/config`,
// `.gitattributes`, `.git/hooks/*`) but not to RUN commands gets switchboard's
// main process to run one for it, outside whatever permission mode its session
// was in. It is live in the git pane today and the bus points it at a folder
// ANOTHER agent controls.
//
// (`git show HEAD:<path>`, what `fileVersions` calls, ran NONE of them — not a
// clean, a smudge or a `process` filter, and not `core.fsmonitor` — so it is
// the one read that carries no config guard. `smudge` is neutralised on the
// other paths anyway: one entry, same key shape.)

import { randomBytes } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

/** One `key = value` from `git config --list --show-scope -z`. */
export interface ScopedConfigEntry {
  /** git's own word: `system`, `global`, `local`, `worktree`, `command` */
  scope: string;
  key: string;
  /** `null` for a valueless key, which git reads as boolean true */
  value: string | null;
}

/**
 * Where a filter driver is allowed to come from. **An allow-list, so an
 * unrecognised scope is treated as repo-authored** — git already emits
 * `command`, `submodule` and `unknown` besides the four everyone knows, and a
 * future one we have never heard of must fail towards guarding rather than
 * towards silently trusting. `git lfs install` writes `global`.
 */
const TRUSTED_SCOPES = new Set(['global', 'system']);

/**
 * git's canonical empty tree — the base every file reads as an addition
 * against, for a repository whose HEAD is unborn.
 *
 * ⚠️ **NOT USABLE AS A SECURITY SWITCH.** An earlier version of this file used
 * `--attr-source=<empty tree>` as a blanket "this tree has no attributes, so no
 * filter driver is selected" fallback. It is not blanket: measured, it
 * suppresses only the WORKING-TREE `.gitattributes`, while
 * `.git/info/attributes` and `core.attributesFile` still deliver a `filter`
 * attribute and the driver still runs. Both of those are files an edit-only
 * agent can write. The guard below therefore neutralises the DRIVER, which is
 * the one thing every attribute source has to go through.
 */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** The filter-driver sub-keys whose values git EXECUTES. */
const EXECUTED_DRIVER_KEYS = ['clean', 'smudge', 'process'];

/**
 * An empty directory we own, for `core.hooksPath` to find nothing in.
 *
 * ⚠️ **CREATED, NOT JUST NAMED, AND WITH A RANDOM NAME.** A fixed path under the
 * temp directory is world-writable on Linux, so another account could plant
 * hooks at the exact location we point git at. If creating it fails we name a
 * path inside it that cannot exist, which is just as good: git runs no hook
 * when `core.hooksPath` is missing (measured).
 */
let emptyHooks: string | null = null;
export function emptyHooksDir(): string {
  if (emptyHooks) return emptyHooks;
  try {
    emptyHooks = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-no-hooks-'));
  } catch {
    // RANDOM here too, and for the same reason the comment above gives: a
    // name derived from the pid is guessable, and pids are cheap to enumerate.
    emptyHooks = path.join(os.tmpdir(), `switchboard-no-hooks-${randomBytes(12).toString('hex')}-absent`);
  }
  return emptyHooks;
}

/**
 * The guards that cost nothing, so they ride on EVERY invocation rather than on
 * the ones measured to need them — a guard applied per call site is a guard the
 * next call site forgets. The filter half cannot be free like this: it has to
 * know what the repository named, so it needs a config read first.
 *
 * - **`core.fsmonitor=false`** names a command git runs to ask which files
 *   changed. Purely a performance optimisation: measured, `status` output on a
 *   plain repo is byte-identical with and without, and it propagates into
 *   submodules.
 * - **`core.hooksPath`** to a directory of ours. `.git/hooks/post-index-change`
 *   RAN during `status` with **no config file at all** — `status` refreshes the
 *   index for a stat-dirty file, writes it, and fires the hook. On Windows,
 *   the primary platform, a hook needs no execute bit. Measured in a
 *   submodule's `.git/modules/<n>/hooks` too.
 *
 * ⚠️ **THE PATH MUST BE ABSOLUTE.** git resolves a relative `core.hooksPath`
 * against the cwd — which is the folder the hostile agent controls, so a
 * relative one would point git straight back at a directory that agent can
 * create.
 *
 * This overlaps `GIT_OPTIONAL_LOCKS=0` (see `git()`), and the overlap is
 * deliberate: on today's git either one alone stops the only hook we could find
 * on these read paths, and neither is individually pinned by a test for that
 * reason. What each is separately pinned for is its own second job —
 * `GIT_OPTIONAL_LOCKS` for not writing a sibling's index, this one for pointing
 * somewhere absolute and empty — and keeping both is what covers a hook we have
 * not enumerated, or one a later git adds.
 */
export function guardArgs(): string[] {
  return ['-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${emptyHooksDir()}`];
}

/**
 * How to ask git for a config listing.
 *
 * ⚠️ **`--includes` IS LOAD-BEARING ON THE BY-NAME READS.** git follows
 * `include.path` when it is searching all the config files and **not** when it
 * has been pointed at one scope or one file. Measured: with
 * `[include] path = extra.cfg` in `.git/config`, `--local --list` does not see
 * the driver the included file defines and `--local --list --includes` does.
 * Two lines in a config file would otherwise hide a driver from the guard while
 * git expanded it during the read — which is exactly how an earlier version of
 * the submodule enumeration was walked around. On `--list --show-scope` it is
 * redundant (includes are already followed there) and kept for the reader.
 */
export const CONFIG_LIST_SCOPED = ['config', '--list', '--show-scope', '--includes', '-z'];
export function configListForScope(scope: 'local' | 'worktree'): string[] {
  return ['config', `--${scope}`, '--list', '--includes', '-z'];
}

/**
 * Parse `git config --list --show-scope -z`.
 *
 * The format is TWO NUL-terminated fields per entry — the scope, then
 * `key\nvalue` — and `-z` is what makes this safe to parse at all: a config
 * value may contain newlines (so a line-based reader can be fed a forged
 * record) but it can never contain NUL.
 */
export function parseScopedConfig(out: string): ScopedConfigEntry[] {
  const fields = out.split('\0');
  const entries: ScopedConfigEntry[] = [];
  // The field after the final NUL is empty, and `i + 1 < length` drops it.
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const entry = entryFrom(fields[i], fields[i + 1]);
    if (entry) entries.push(entry);
  }
  return entries;
}

/**
 * Parse `git config --list -z` for ONE scope asked for by name, on a git too
 * old for `--show-scope`. Same records without the scope field: `key\nvalue`.
 */
export function parseUnscopedConfig(out: string, scope: string): ScopedConfigEntry[] {
  const entries: ScopedConfigEntry[] = [];
  for (const rec of out.split('\0')) {
    const entry = entryFrom(scope, rec);
    if (entry) entries.push(entry);
  }
  return entries;
}

/** One record, or `null` for the empty tail — and for a truncated stream. */
function entryFrom(scope: string, rest: string): ScopedConfigEntry | null {
  if (rest === '') return null;
  // The FIRST newline: a config value may legitimately contain more of them,
  // and folding one into the key would stop `isDriverKey` matching — which is
  // to say it would silently unguard the driver.
  const nl = rest.indexOf('\n');
  if (nl === -1) return { scope, key: rest, value: null };
  return { scope, key: rest.slice(0, nl), value: rest.slice(nl + 1) };
}

/**
 * The config settings to force so that a repo-authored filter driver cannot
 * execute, WITHOUT breaking a legitimate one. `[key, value]` pairs, to be
 * applied at the highest precedence git has.
 *
 * The discriminator is scope, and it holds because of where the two kinds of
 * driver come from: `git lfs install` writes `filter.lfs.*` to the **global**
 * config, while an agent that can only write inside its session folder reaches
 * **local**, **worktree**, or a submodule's own config. So a globally-installed
 * driver is never touched, and a locally *shadowed* one is put back to its
 * global value — measured: *local cmd blocked, status clean (right)*.
 *
 * A driver defined only in the repo is neutralised to empty. If it also carries
 * `required = true`, git then fails the read outright rather than silently
 * reporting every file as modified — deliberate, and the honest outcome when we
 * have disabled machinery the repo declared mandatory. `diff()` turns that into
 * a refusal with a reason. The one legitimate configuration this breaks is
 * `git lfs install --local` on a machine with no global LFS, which fails loudly
 * and is fixed by installing LFS globally.
 *
 * ⚠️ **THESE GO IN THE ENVIRONMENT, NOT ON THE COMMAND LINE, AND THAT IS A
 * SECURITY PROPERTY.** `-c key=value` parses on the FIRST `=`, and a git
 * subsection name may contain one: given `[filter "x.clean=touch pwned"]`, the
 * key is `filter.x.clean=touch pwned.clean` and `-c <key>=` sets
 * **`filter.x.clean`** to `touch pwned.clean=` — the mitigation becoming the
 * exploit. `GIT_CONFIG_KEY_<n>` / `GIT_CONFIG_VALUE_<n>` (git ≥ 2.31) carry the
 * two halves in separate variables, so **every key is expressible** and there
 * is no shape this cannot guard. The earlier command-line version needed an
 * all-or-nothing escape hatch for unquotable names, and that escape hatch was
 * itself bypassable (see `EMPTY_TREE`).
 */
export function filterGuardOverrides(entries: readonly ScopedConfigEntry[]): [string, string][] {
  /** the value git would use if the repo-scope ones were not there */
  const trusted = new Map<string, string | null>();
  /** every repo-authored driver key, in the order git listed them */
  const repoAuthored: string[] = [];
  const seen = new Set<string>();

  for (const e of entries) {
    if (!isDriverKey(e.key)) continue;
    if (TRUSTED_SCOPES.has(e.scope)) {
      // Later wins, matching git's own precedence for a repeated key.
      trusted.set(e.key, e.value);
    } else if (!seen.has(e.key)) {
      seen.add(e.key);
      repoAuthored.push(e.key);
    }
  }

  // A valueless trusted key maps to empty rather than to `true`: a filter
  // command that is boolean-true is already broken config, and git rejects the
  // command-line spelling of it outright.
  return repoAuthored.map((key) => [key, (trusted.get(key) ?? '') || '']);
}

/**
 * A driver sub-key whose value git executes. git lower-cases the section and
 * the variable but preserves the subsection's case, so only the ends are
 * compared case-blind — and the subsection may contain dots, so the LAST dot is
 * the separator.
 */
function isDriverKey(key: string): boolean {
  if (!key.toLowerCase().startsWith('filter.')) return false;
  const lastDot = key.lastIndexOf('.');
  if (lastDot < 'filter.'.length) return false;
  return EXECUTED_DRIVER_KEYS.includes(key.slice(lastDot + 1).toLowerCase());
}

/**
 * Turn overrides into the environment git reads them from.
 *
 * Ours are appended AFTER whatever `GIT_CONFIG_*` the parent environment
 * already carries: clobbering a user's own `GIT_CONFIG_COUNT` would silently
 * drop THEIR settings, and going last is also what makes ours win.
 *
 * ⚠️ **`GIT_CONFIG_PARAMETERS` IS DROPPED, because it BEATS us.** Measured: a
 * `-c` on the same key — which is what that variable carries between a git
 * process and its children — overrides `GIT_CONFIG_KEY_<n>`. Nothing a
 * repository controls can set it (only a parent git can), so this is not a
 * live hole; it is removed because "the highest precedence git has" has to be
 * true for the guard to mean anything, and because switchboard could one day
 * be launched from a git subprocess.
 */
export function overrideEnv(
  base: NodeJS.ProcessEnv,
  overrides: readonly [string, string][]
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  delete env.GIT_CONFIG_PARAMETERS;
  if (overrides.length === 0) return env;
  const existing = Number(base.GIT_CONFIG_COUNT ?? 0);
  const start = Number.isInteger(existing) && existing > 0 ? existing : 0;
  overrides.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${start + i}`] = key;
    env[`GIT_CONFIG_VALUE_${start + i}`] = value;
  });
  env.GIT_CONFIG_COUNT = String(start + overrides.length);
  return env;
}

/**
 * The submodule paths in a `git ls-files --stage -z` listing: mode `160000`.
 *
 * ⚠️ **THE INDEX IS THE ONLY HONEST SOURCE.** `.gitmodules` is attacker-owned;
 * `<gitdir>/modules/<name>` is where a submodule's git directory USUALLY lives
 * but `sub/.git` is a plain text file an edit-only agent can repoint anywhere,
 * and measured, a submodule whose git directory had been moved into an ordinary
 * working-tree folder still ran its driver while an enumeration that opened
 * `modules/<name>` by name found nothing at all. What git recurses into is what
 * the index says is a gitlink, so that is what we ask.
 */
export function gitlinkPaths(lsFilesZ: string): string[] {
  const paths: string[] = [];
  for (const record of lsFilesZ.split('\0')) {
    if (!record.startsWith('160000 ')) continue;
    const tab = record.indexOf('\t');
    if (tab === -1) continue;
    const p = record.slice(tab + 1);
    // git's index cannot hold `..` or an absolute path; refusing them anyway
    // keeps this honest if it is ever fed something that is not git's output.
    if (p === '' || p.startsWith('/') || p.split('/').includes('..')) continue;
    paths.push(p);
  }
  return paths;
}
