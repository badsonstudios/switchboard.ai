// "Open folder in editor" (#1608): a session's folder, in the editor the user
// chose (VS Code, Cursor, Zed, VSCodium, or a program of their own), detected
// by default.
//
// NO SHELL, EVER. The folder is ONE argument to the editor's own executable,
// spawned directly, so a folder named `a & b` or `$(x)` is just a name. That
// has a cost on Windows: `code` on PATH is `code.cmd`, a batch file, and Node
// refuses to spawn one without a shell (CVE-2024-27980). Every one of these
// editors keeps its real `.exe` a few folders above its `bin\<name>.cmd`
// (`Microsoft VS Code\bin\code.cmd` → `Microsoft VS Code\Code.exe`), so that
// is what is launched. A custom program must itself be an executable, not a
// script for a shell to run.
//
// MAIN DECIDES WHAT RUNS: the choice is stored here, the folder is read from
// the card's own record, and the window only says which card. Nothing it
// sends is ever a path to execute.
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';

export const EDITOR_IDS = ['code', 'cursor', 'zed', 'codium'] as const;
export type EditorId = (typeof EDITOR_IDS)[number];
/** `auto` = the first of `EDITOR_IDS` found on this machine */
export type EditorChoice = 'auto' | EditorId | 'custom';

export interface EditorPref {
  choice: EditorChoice;
  /** the program, for `custom`: an absolute path to an executable */
  customPath?: string;
}

export const DEFAULT_EDITOR_PREF: EditorPref = { choice: 'auto' };

/** What a stored or sent preference is, keeping only what can be used. */
export function editorPrefOf(raw: unknown): EditorPref {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_EDITOR_PREF };
  const r = raw as Record<string, unknown>;
  const choice = (['auto', 'custom', ...EDITOR_IDS] as const).includes(r.choice as EditorChoice)
    ? (r.choice as EditorChoice)
    : 'auto';
  const customPath = typeof r.customPath === 'string' && r.customPath.length <= 1024 ? r.customPath : undefined;
  return { choice, ...(customPath ? { customPath } : {}) };
}

/** On PATH, the name each editor installs, and the exe(s) behind a Windows `.cmd`. */
const KNOWN: Record<EditorId, { bin: string; exes: string[] }> = {
  code: { bin: 'code', exes: ['Code.exe'] },
  cursor: { bin: 'cursor', exes: ['Cursor.exe'] },
  zed: { bin: 'zed', exes: ['Zed.exe', 'zed.exe'] },
  codium: { bin: 'codium', exes: ['VSCodium.exe'] },
};

export interface EditorEnv {
  platform: NodeJS.Platform;
  /** the PATH entries, in order */
  pathDirs: readonly string[];
  isFile(p: string): boolean;
}

export function realEditorEnv(): EditorEnv {
  return {
    platform: process.platform,
    pathDirs: (process.env.PATH ?? '').split(path.delimiter).filter(Boolean),
    isFile: (p) => {
      try {
        return fs.statSync(p).isFile();
      } catch {
        return false;
      }
    },
  };
}

/** The executable for one known editor on this machine, or null. */
export function findEditor(id: EditorId, env: EditorEnv): string | null {
  const { bin, exes } = KNOWN[id];
  const p = env.platform === 'win32' ? path.win32 : path.posix;
  const join = (...parts: string[]): string => p.join(...parts);
  const dirname = (s: string): string => p.dirname(s);
  for (const dir of env.pathDirs) {
    if (env.platform !== 'win32') {
      const p = join(dir, bin);
      if (env.isFile(p)) return p;
      continue;
    }
    const exe = join(dir, `${bin}.exe`);
    if (env.isFile(exe)) return exe;
    if (!env.isFile(join(dir, `${bin}.cmd`))) continue;
    // the real program sits a few folders above its `bin\<name>.cmd`
    let up = dir;
    for (let i = 0; i < 4; i++) {
      up = dirname(up);
      for (const name of exes) {
        const candidate = join(up, name);
        if (env.isFile(candidate)) return candidate;
      }
    }
  }
  return null;
}

/** Which known editors are installed, in `EDITOR_IDS` order. */
export function detectEditors(env: EditorEnv): EditorId[] {
  return EDITOR_IDS.filter((id) => findEditor(id, env) !== null);
}

/** A custom program is usable only as a real executable: no scripts. */
export function customProgramOk(p: string | undefined, env: EditorEnv): boolean {
  if (!p) return false;
  const isAbs = env.platform === 'win32' ? path.win32.isAbsolute(p) : path.posix.isAbsolute(p);
  if (!isAbs || !env.isFile(p)) return false;
  if (env.platform === 'win32' && !/\.exe$/i.test(p)) return false;
  return true;
}

/** What to launch for a preference, or null when nothing usable is set up. */
export function resolveEditor(pref: EditorPref, env: EditorEnv): string | null {
  if (pref.choice === 'custom') return customProgramOk(pref.customPath, env) ? pref.customPath! : null;
  if (pref.choice !== 'auto') return findEditor(pref.choice, env);
  for (const id of EDITOR_IDS) {
    const found = findEditor(id, env);
    if (found) return found;
  }
  return null;
}

/**
 * Start the editor on a folder, detached, no shell. The editor is an app of
 * its own: it must not inherit Electron's run-as-node switch, or VS Code (an
 * Electron app too) would start as a bare Node.js.
 */
export function launchEditor(program: string, folder: string, onError: (err: unknown) => void): void {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  try {
    const child = spawn(program, [folder], { detached: true, stdio: 'ignore', windowsHide: false, env, shell: false });
    child.on('error', onError);
    child.unref();
  } catch (err) {
    onError(err);
  }
}
