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
import os from 'os';
import path from 'path';
import { Logger } from '../log/logger';

function claudeConfigPath(): string {
  return path.join(os.homedir(), '.claude.json');
}

/** The key Claude Code uses for a project: absolute path, forward slashes. */
export function projectKey(folder: string): string {
  return path.resolve(folder).replace(/\\/g, '/');
}

/**
 * Ensure `folder` is marked trusted. Returns true if the config now reflects
 * trust (already-trusted or successfully written), false on any failure.
 */
export function ensureFolderTrusted(folder: string, log?: Logger, configPath?: string): boolean {
  const file = configPath ?? claudeConfigPath();
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const cfg = JSON.parse(raw) as { projects?: Record<string, Record<string, unknown>> };
    cfg.projects = cfg.projects ?? {};
    const key = projectKey(folder);
    const existing = cfg.projects[key] ?? {};
    if (existing.hasTrustDialogAccepted === true) return true; // already trusted
    cfg.projects[key] = {
      ...existing,
      hasTrustDialogAccepted: true,
      projectOnboardingSeenCount:
        typeof existing.projectOnboardingSeenCount === 'number' ? existing.projectOnboardingSeenCount : 1,
    };
    const tmp = `${file}.switchboard.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
    fs.renameSync(tmp, file); // atomic: never leave a half-written config
    log?.info('folder auto-trusted', { folder: key });
    return true;
  } catch (err) {
    // fail-open: the session just shows the trust dialog as normal
    log?.warn('auto-trust skipped', { folder, error: String(err) });
    return false;
  }
}
