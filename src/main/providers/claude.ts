// Claude Code provider adapter v1 (P1-E2-02) — registered via the
// contribution registry (§5.23); nothing outside bootstrap imports this
// directly. Implements the spike verdicts:
//   S-01: absolute CLI path (PATH-relative .cmd with cwd=user project is a
//         planted-binary footgun) + env landmine scrubs
//   S-02: settings injection via `--settings <abs path>` — generated
//         per-session file, VALIDATED before spawn (invalid settings files
//         are silently ignored by the CLI — our hooks would vanish quietly)
import fs from 'fs';
import path from 'path';
import { ProviderAdapter, SpawnOptions, SpawnRecipe } from '../extensibility/contributions';

const CLI_NAMES = process.platform === 'win32' ? ['claude.cmd', 'claude.exe'] : ['claude'];

let cachedCliPath: string | null | undefined;

/** Resolve the claude CLI to an absolute path by scanning PATH once. */
export function resolveCliPath(envPath = process.env.PATH ?? ''): string | null {
  if (cachedCliPath !== undefined) return cachedCliPath;
  cachedCliPath = scanPath(envPath);
  return cachedCliPath;
}

export function scanPath(envPath: string): string | null {
  for (const dir of envPath.split(path.delimiter).filter(Boolean)) {
    for (const name of CLI_NAMES) {
      const full = path.join(dir, name);
      try {
        if (fs.statSync(full).isFile()) return full;
      } catch {
        /* keep scanning */
      }
    }
  }
  return null;
}

/** test seam */
export function resetCliPathCache(): void {
  cachedCliPath = undefined;
}

/**
 * Write + validate the per-session settings file. Throws rather than letting
 * the CLI silently ignore a malformed file (S-02 caveat).
 */
export function writeSessionSettings(
  stateDir: string,
  sessionId: string,
  settings: Record<string, unknown>
): string {
  if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) {
    throw new Error('session settings must be a plain object');
  }
  if ('hooks' in settings) {
    validateHooksShape(settings.hooks);
  }
  const dir = path.join(stateDir, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'settings.json');
  const json = JSON.stringify(settings, null, 2);
  JSON.parse(json); // round-trip: what we hand the CLI must parse
  fs.writeFileSync(file, json);
  return file;
}

function validateHooksShape(hooks: unknown): void {
  if (typeof hooks !== 'object' || hooks === null) {
    throw new Error('settings.hooks must be an object of event -> matcher groups');
  }
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) throw new Error(`hooks.${event} must be an array`);
    for (const g of groups) {
      const inner = (g as { hooks?: unknown }).hooks;
      if (!Array.isArray(inner) || inner.length === 0) {
        throw new Error(`hooks.${event}[] needs a non-empty "hooks" array`);
      }
      for (const h of inner) {
        const cmd = (h as { command?: unknown }).command;
        if (typeof cmd !== 'string' || cmd.trim() === '') {
          throw new Error(`hooks.${event}[] entries need a "command" string`);
        }
      }
    }
  }
}

export const claudeAdapter: ProviderAdapter = {
  manifest: {
    id: 'claude-code',
    displayName: 'Claude Code',
    version: '0.2.0',
    capabilities: ['sessions.spawn', 'sessions.resume', 'settings.inject'],
  },

  buildSpawn(options: SpawnOptions): SpawnRecipe {
    const cli = resolveCliPath();
    if (!cli) {
      throw new Error(
        'claude CLI not found on PATH — first-run preflight (P1-E6-03) should have caught this'
      );
    }
    const args: string[] = [];
    if (options.settings && Object.keys(options.settings).length > 0) {
      const settingsPath = writeSessionSettings(
        options.stateDir,
        options.sessionId,
        options.settings
      );
      args.push('--settings', settingsPath);
    }
    if (options.resumeSessionId) args.push('--resume', options.resumeSessionId);
    return {
      command: cli,
      args,
      env: {
        // S-01 landmines: never let these leak into a hosted session
        ELECTRON_RUN_AS_NODE: undefined,
        ELECTRON_NO_ATTACH_CONSOLE: undefined,
      },
    };
  },
};
