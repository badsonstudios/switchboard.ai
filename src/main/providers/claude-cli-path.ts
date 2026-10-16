// Where the `claude` CLI is (S-01: an ABSOLUTE path, because a PATH-relative
// `.cmd` with cwd = the user's project is a planted-binary footgun).
//
// Its own module since #1288, so the Claude surface modules (preflight, the
// one-shot labeler, the MCP CLI and health) can find the CLI without importing
// the adapter — `claude.ts` declares those surfaces, and an import back into it
// would make a cycle. `claude.ts` re-exports all three, so existing importers
// are unaffected.
import fs from 'fs';
import path from 'path';

const CLI_NAMES = process.platform === 'win32' ? ['claude.cmd', 'claude.exe'] : ['claude'];

let cachedCliPath: string | null | undefined;

/**
 * Resolve the claude CLI to an absolute path by scanning PATH. Positive
 * results are cached; a miss is re-scanned each call so installing the CLI
 * mid-run doesn't require an app restart.
 */
export function resolveCliPath(envPath = process.env.PATH ?? ''): string | null {
  if (cachedCliPath != null) return cachedCliPath;
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
