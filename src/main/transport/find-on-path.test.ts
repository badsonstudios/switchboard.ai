// findOnPath (#1291): both platforms' rules on every CI leg, through the
// `platform` / `isFile` seams, plus one real lookup.
import { describe, expect, it } from 'vitest';
import path from 'path';
import { candidateNames, findOnPath, pathIndex } from './find-on-path';

describe('candidateNames', () => {
  it('POSIX: the name as given', () => {
    expect(candidateNames('opencode', 'linux', '')).toEqual(['opencode']);
  });
  it('Windows: PATHEXT’s extensions (npm installs .cmd shims); a default list when PATHEXT is empty', () => {
    expect(candidateNames('gemini', 'win32', '.COM;.EXE;.BAT;.CMD')).toEqual(['gemini.com', 'gemini.exe', 'gemini.bat', 'gemini.cmd']);
    expect(candidateNames('gemini', 'win32', '')).toEqual(['gemini.com', 'gemini.exe', 'gemini.bat', 'gemini.cmd']);
    expect(candidateNames('agent.exe', 'win32', '.EXE')[0]).toBe('agent.exe');
  });
});

describe('pathIndex: one async pass, same answers', () => {
  const listings: Record<string, string[]> = {
    'C:\\bin': ['Gemini.CMD', 'other.exe'],
    'C:\\npm': ['gemini.cmd', 'qwen.cmd', 'qwen'],
  };
  const list = (dir: string): Promise<string[]> => Promise.resolve(listings[dir] ?? []);

  it('Windows: first PATH directory wins, case-insensitively, through PATHEXT', async () => {
    const find = await pathIndex({ platform: 'win32', envPath: 'C:\\bin;C:\\missing;C:\\npm', pathext: '.EXE;.CMD', list });
    expect(find('gemini')).toBe('C:\\bin\\Gemini.CMD');
    expect(find('qwen')).toBe('C:\\npm\\qwen.cmd');
    expect(find('nothing')).toBeNull();
    expect(find('')).toBeNull();
    expect(find('bin\\gemini')).toBeNull();
  });

  it('POSIX: exact names', async () => {
    const find = await pathIndex({
      platform: 'linux',
      envPath: '/a:/b',
      list: (d) => Promise.resolve(d === '/b' ? ['goose'] : ['Goose']),
    });
    expect(find('goose')).toBe('/b/goose');
  });

  it('an absolute command is checked as itself', async () => {
    const find = await pathIndex({ platform: 'linux', envPath: '', list, isFile: (p) => p === '/opt/agent' });
    expect(find('/opt/agent')).toBe('/opt/agent');
    expect(find('/opt/other')).toBeNull();
  });

  it('really reads this machine’s PATH', async () => {
    const find = await pathIndex({ envPath: path.dirname(process.execPath) });
    expect(find(path.basename(process.execPath, path.extname(process.execPath)))).toBeTruthy();
  });
});

describe('findOnPath', () => {
  const files = new Set(['C:\\npm\\gemini.cmd', 'C:\\tools\\agent.exe', '/usr/local/bin/goose']);
  const isFile = (p: string): boolean => files.has(p);

  it('Windows: finds the .cmd shim on PATH', () => {
    expect(findOnPath('gemini', { platform: 'win32', envPath: 'C:\\bin;C:\\npm', pathext: '.EXE;.CMD', isFile })).toBe('C:\\npm\\gemini.cmd');
  });

  it('Windows: a bare file with no extension is never a match (it cannot be spawned)', () => {
    expect(findOnPath('gemini', { platform: 'win32', envPath: 'C:\\npm', pathext: '.EXE', isFile })).toBeNull();
  });

  it('POSIX: finds it on PATH', () => {
    expect(findOnPath('goose', { platform: 'linux', envPath: '/usr/bin:/usr/local/bin', isFile })).toBe('/usr/local/bin/goose');
  });

  it('an absolute path is checked as itself, never searched for', () => {
    expect(findOnPath('C:\\tools\\agent.exe', { platform: 'win32', envPath: 'C:\\npm', pathext: '.EXE', isFile })).toBe('C:\\tools\\agent.exe');
    expect(findOnPath('C:\\elsewhere\\gemini.cmd', { platform: 'win32', envPath: 'C:\\npm', pathext: '.CMD', isFile })).toBeNull();
  });

  it('a relative path with a separator is refused (it would depend on the cwd)', () => {
    expect(findOnPath('./goose', { platform: 'linux', envPath: '/usr/local/bin', isFile })).toBeNull();
    expect(findOnPath('npm\\gemini', { platform: 'win32', envPath: 'C:\\', pathext: '.CMD', isFile })).toBeNull();
  });

  it('blank is nothing', () => {
    expect(findOnPath('  ', { isFile })).toBeNull();
  });

  it('really finds this Node by its absolute path', () => {
    expect(findOnPath(process.execPath)).toBe(process.execPath);
    expect(findOnPath(path.basename(process.execPath, path.extname(process.execPath)), { envPath: path.dirname(process.execPath) })).toBeTruthy();
  });
});
