// #1608: which editor runs, found how, and what is never run.
import { describe, expect, it } from 'vitest';
import {
  customProgramOk,
  detectEditors,
  editorPrefOf,
  findEditor,
  resolveEditor,
  type EditorEnv,
} from './editor-launch';

/** a machine with exactly these files */
function win(files: string[], pathDirs: string[]): EditorEnv {
  const set = new Set(files.map((f) => f.toLowerCase()));
  return { platform: 'win32', pathDirs, isFile: (p) => set.has(p.toLowerCase()) };
}
function posix(files: string[], pathDirs: string[]): EditorEnv {
  const set = new Set(files);
  return { platform: 'linux', pathDirs, isFile: (p) => set.has(p) };
}

const VSC = 'C:\\Users\\u\\AppData\\Local\\Programs\\Microsoft VS Code';
const CUR = 'C:\\Users\\u\\AppData\\Local\\Programs\\cursor';

describe('finding an editor (#1608)', () => {
  it("Windows: VS Code's code.cmd on PATH leads to the Code.exe above it, never the .cmd", () => {
    const env = win([`${VSC}\\bin\\code.cmd`, `${VSC}\\Code.exe`], [`${VSC}\\bin`]);
    expect(findEditor('code', env)).toBe(`${VSC}\\Code.exe`);
  });
  it("Windows: Cursor's cmd sits three folders down", () => {
    const env = win([`${CUR}\\resources\\app\\bin\\cursor.cmd`, `${CUR}\\Cursor.exe`], [`${CUR}\\resources\\app\\bin`]);
    expect(findEditor('cursor', env)).toBe(`${CUR}\\Cursor.exe`);
  });
  it('Windows: a .cmd with no exe to be found is not usable (it would need a shell)', () => {
    expect(findEditor('code', win([`${VSC}\\bin\\code.cmd`], [`${VSC}\\bin`]))).toBeNull();
  });
  it('POSIX: the name on PATH', () => {
    expect(findEditor('zed', posix(['/usr/local/bin/zed'], ['/usr/bin', '/usr/local/bin']))).toBe('/usr/local/bin/zed');
  });
  it('detects in order, and auto takes the first', () => {
    const env = posix(['/b/cursor', '/b/codium'], ['/b']);
    expect(detectEditors(env)).toEqual(['cursor', 'codium']);
    expect(resolveEditor({ choice: 'auto' }, env)).toBe('/b/cursor');
    expect(resolveEditor({ choice: 'auto' }, posix([], ['/b']))).toBeNull();
  });
  it('a chosen editor that is not installed resolves to nothing, not to another one', () => {
    expect(resolveEditor({ choice: 'zed' }, posix(['/b/code'], ['/b']))).toBeNull();
  });
});

describe('a program of your own (#1608)', () => {
  it('must be an absolute path to an existing executable', () => {
    const env = win(['C:\\Tools\\sublime_text.exe', 'C:\\Tools\\go.bat'], []);
    expect(customProgramOk('C:\\Tools\\sublime_text.exe', env)).toBe(true);
    expect(customProgramOk('sublime_text.exe', env)).toBe(false);
    expect(customProgramOk('C:\\Tools\\missing.exe', env)).toBe(false);
    // a script would need a shell to run, and nothing here uses one
    expect(customProgramOk('C:\\Tools\\go.bat', env)).toBe(false);
    expect(resolveEditor({ choice: 'custom', customPath: 'C:\\Tools\\go.bat' }, env)).toBeNull();
    expect(resolveEditor({ choice: 'custom', customPath: 'C:\\Tools\\sublime_text.exe' }, env)).toBe(
      'C:\\Tools\\sublime_text.exe'
    );
  });
});

describe('editorPrefOf', () => {
  it('keeps only a known choice', () => {
    expect(editorPrefOf(undefined)).toEqual({ choice: 'auto' });
    expect(editorPrefOf({ choice: 'notepad' })).toEqual({ choice: 'auto' });
    expect(editorPrefOf({ choice: 'cursor' })).toEqual({ choice: 'cursor' });
    expect(editorPrefOf({ choice: 'custom', customPath: 'C:\\x.exe' })).toEqual({ choice: 'custom', customPath: 'C:\\x.exe' });
    expect(editorPrefOf({ choice: 'custom', customPath: 5 })).toEqual({ choice: 'custom' });
  });
});
