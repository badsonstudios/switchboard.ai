// Auto-trust (opt-in, default on): choosing a folder to run an agent in IS
// the trust decision (same premise as the VS Code extension). We pre-set the
// flag Claude Code writes when a user accepts its trust dialog, so the session
// skips that prompt.
//
// Verified: projects are keyed in ~/.claude.json by FORWARD-SLASH path, and
// hasTrustDialogAccepted:true under that key makes an interactive session go
// straight to the composer.
//
// This edits the user's real ~/.claude.json — so: merge (never clobber),
// atomic write (tmp + rename), and fail-open (any error just leaves the trust
// dialog in place, no harm).
import fs from 'fs';
import { randomUUID } from 'crypto';
import os from 'os';
import path from 'path';
import { Logger } from '../log/logger';
import { isRecord, projectKey, resolveProjectKeys } from '../project-key';

function claudeConfigPath(): string {
  return path.join(os.homedir(), '.claude.json');
}

// `projectKey` used to live here, WITHOUT the case fold that `mcp/config.ts`
// applied to the same map — which is #724: this path wrote
// `hasTrustDialogAccepted` under `c:/Projects/Foo` while the CLI read
// `C:/Projects/Foo`, so auto-trust silently did nothing. Re-exported rather
// than redefined, because a second copy of a keying rule is exactly what caused
// the bug. See `main/project-key.ts`.
export { projectKey };

/**
 * Ensure `folder` is marked trusted. Returns true if the config now reflects
 * trust (already-trusted or successfully written), false on any failure.
 *
 * ⚠️ **THE KEY IS LOOKED UP, NEVER INVENTED** (#724). Writing our own normalised
 * spelling created a second `projects` entry beside the CLI's whenever the
 * folder reached us case-differently — which Windows produces readily — and the
 * flag then sat where nothing reads it. Every layer reported success and the
 * feature was off. `resolveProjectKeys` reuses whatever spellings the file already
 * has, so we write where the CLI reads — all of them, since which one it reads
 * next is exactly the thing we cannot observe.
 *
 * **That also fixes the second-run trap, which was the worse half.** The
 * short-circuit below asks "is this already trusted?" — against a phantom key,
 * it answered yes to a flag only we had ever written, so the retry never
 * happened either.
 */
export function ensureFolderTrusted(
  folder: string,
  log?: Logger,
  /**
   * AN OBJECT RATHER THAN THREE MORE POSITIONALS. `configPath` was already a
   * test seam; #724 needed two more, and `f(folder, log, path, platform,
   * realpath)` is a call nobody can read at the site. Every field is optional and
   * production passes none.
   */
  opts: {
    configPath?: string;
    /**
     * INJECTED FOR THE #127 REASON, not as a testing nicety. The key lookup
     * folds case on win32 and must not elsewhere, so read from the ambient
     * process the drive-letter cases would pass on the maintainer's Windows
     * machine and go RED on the Linux CI leg — the failure mode `samePath` and
     * `launchSpec` both carry this same parameter to avoid.
     */
    platform?: NodeJS.Platform;
    /** how a candidate key is confirmed to be this folder — see
     *  `resolveProjectKeys`, and the UNC hazard that made it necessary */
    realpath?: (p: string) => string | null;
  } = {}
): boolean {
  const { configPath, platform = process.platform, realpath } = opts;
  const file = configPath ?? claudeConfigPath();
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const cfg = JSON.parse(raw) as { projects?: Record<string, Record<string, unknown>> };
    cfg.projects = cfg.projects ?? {};
    const projects = cfg.projects;
    const { keys, created, ambiguous } = resolveProjectKeys(projects, folder, platform, realpath);
    // ALL OF THEM, and only short-circuit when EVERY one is already trusted.
    // Checking a single entry is what let the second run do nothing: the flag on
    // our phantom key answered "already trusted" for a folder the CLI still had
    // no trust record for.
    if (keys.every((k) => isRecord(projects[k]) && projects[k].hasTrustDialogAccepted === true)) {
      return true;
    }
    // SAID OUT LOUD ONLY WHEN A WRITE FOLLOWS. Emitted before the short-circuit,
    // this logged "trusting all of them" while trusting nothing — and it fires
    // on every session start for a condition the user cannot fix, on a machine
    // where five folders are already split (this repo among them).
    if (ambiguous) {
      log?.warn('folder has more than one entry in the CLI config; trusting each of them', {
        folder: projectKey(folder),
        entries: keys,
      });
    }
    for (const key of keys) {
      // A non-record entry is the user's malformed data, not something to spread
      // — `{...'a string'}` yields a character-indexed object and writes that
      // back over whatever was there.
      const existing = isRecord(projects[key]) ? projects[key] : {};
      projects[key] = {
        ...existing,
        hasTrustDialogAccepted: true,
        projectOnboardingSeenCount:
          typeof existing.projectOnboardingSeenCount === 'number'
            ? existing.projectOnboardingSeenCount
            : 1,
      };
    }
    // A UNIQUE TMP NAME PER CALL. The app starts many sessions at once and each
    // one runs this read-modify-write; a fixed name let two calls interleave
    // into the same file and rename a half-merged config over the user's real
    // one. Found in review.
    const tmp = `${file}.switchboard.${process.pid}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
      fs.renameSync(tmp, file); // atomic: never leave a half-written config
    } catch (err) {
      // Do not leave our scratch file behind on a failed write.
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* it may never have been created */
      }
      throw err;
    }
    // WHAT WE ASKED FOR ALONGSIDE WHAT WE WROTE. The absence of this is what let
    // the bug report success: the log said `folder auto-trusted` naming a key
    // the CLI was not reading, and nothing contradicted it. `folder` stays a
    // single path, as it is everywhere else in this flow.
    log?.info('folder auto-trusted', { folder: projectKey(folder), wrote: keys, created });
    return true;
  } catch (err) {
    // fail-open: the session just shows the trust dialog as normal
    log?.warn('auto-trust skipped', { folder, error: String(err) });
    return false;
  }
}
