// First-run preflight (P1-E6-03, §5.25): is the claude CLI present, what
// version, does a login plausibly exist? Guided-fix text lives in the
// renderer; this reports facts. Re-checked on demand (and implicitly per
// spawn — the adapter throws when the CLI is missing).
import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { resolveCliPath, resetCliPathCache } from './providers/claude';

export interface PreflightResult {
  cliPath: string | null;
  version: string | null;
  /** heuristic: CLI config exists in the profile (a login has happened) */
  configPresent: boolean;
  ok: boolean;
}

export async function runPreflight(): Promise<PreflightResult> {
  resetCliPathCache(); // installing the CLI mid-run must be detectable
  const cliPath = resolveCliPath();
  let version: string | null = null;
  if (cliPath) {
    version = await new Promise((resolve) => {
      const isCmd = process.platform === 'win32' && cliPath.toLowerCase().endsWith('.cmd');
      execFile(
        isCmd ? 'cmd.exe' : cliPath,
        isCmd ? ['/c', cliPath, '--version'] : ['--version'],
        { encoding: 'utf8', timeout: 30000, windowsHide: true },
        (err, stdout) => resolve(err ? null : (stdout ?? '').trim() || null)
      );
    });
  }
  const configPresent = fs.existsSync(path.join(os.homedir(), '.claude.json'));
  return { cliPath, version, configPresent, ok: !!cliPath && !!version };
}
