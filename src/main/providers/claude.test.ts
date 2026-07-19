import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  claudeAdapter,
  resetCliPathCache,
  scanPath,
  writeSessionSettings,
} from './claude';

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-claude-'));
  resetCliPathCache();
});

describe('scanPath (absolute CLI resolution, S-01 footgun)', () => {
  it('finds the CLI in a PATH dir', () => {
    const name = process.platform === 'win32' ? 'claude.cmd' : 'claude';
    fs.writeFileSync(path.join(tmp, name), 'stub');
    expect(scanPath([tmp, '/nope'].join(path.delimiter))).toBe(path.join(tmp, name));
  });

  it('returns null when absent', () => {
    expect(scanPath(tmp)).toBeNull();
  });
});

describe('writeSessionSettings (S-02 validate-before-spawn)', () => {
  it('writes a per-session file and returns its absolute path', () => {
    const p = writeSessionSettings(tmp, 's1', { hooks: {} });
    expect(path.isAbsolute(p)).toBe(true);
    expect(JSON.parse(fs.readFileSync(p, 'utf8'))).toEqual({ hooks: {} });
    expect(p).toContain(path.join('s1', 'settings.json'));
  });

  it('rejects malformed hooks shapes (the silent-ignore trap)', () => {
    expect(() => writeSessionSettings(tmp, 's1', { hooks: 'nope' })).toThrow(/hooks/);
    expect(() => writeSessionSettings(tmp, 's1', { hooks: { Stop: [{}] } })).toThrow(/hooks/);
    expect(() =>
      writeSessionSettings(tmp, 's1', { hooks: { Stop: [{ hooks: [{ command: '' }] }] } })
    ).toThrow(/command/);
  });

  it('accepts a valid hook config', () => {
    const p = writeSessionSettings(tmp, 's1', {
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node x.js' }] }] },
    });
    expect(fs.existsSync(p)).toBe(true);
  });
});

describe('claudeAdapter.buildSpawn', () => {
  function withCliOnPath(): string {
    const name = process.platform === 'win32' ? 'claude.cmd' : 'claude';
    const cli = path.join(tmp, name);
    fs.writeFileSync(cli, 'stub');
    const orig = process.env.PATH;
    process.env.PATH = tmp + path.delimiter + (orig ?? '');
    return cli;
  }

  it('uses the absolute CLI path, settings + resume args, env scrubs', () => {
    const cli = withCliOnPath();
    const recipe = claudeAdapter.buildSpawn({
      cwd: tmp,
      sessionId: 'sess-1',
      stateDir: path.join(tmp, 'state'),
      resumeSessionId: 'native-123',
      settings: { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node x.js' }] }] } },
    });
    expect(recipe.command).toBe(cli);
    expect(path.isAbsolute(recipe.command)).toBe(true);
    const i = recipe.args.indexOf('--settings');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(path.isAbsolute(recipe.args[i + 1])).toBe(true);
    expect(recipe.args).toContain('--resume');
    expect(recipe.args[recipe.args.indexOf('--resume') + 1]).toBe('native-123');
    expect('ELECTRON_RUN_AS_NODE' in recipe.env).toBe(true);
    expect(recipe.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
  });

  it('maps autonomy profiles to permission modes (E6-01)', () => {
    withCliOnPath();
    const argsFor = (autonomy?: 'plan' | 'ask' | 'auto-edit' | 'full-auto') =>
      claudeAdapter.buildSpawn({ cwd: tmp, sessionId: 's', stateDir: path.join(tmp, 'st'), autonomy }).args;
    expect(argsFor('plan')).toEqual(['--permission-mode', 'plan']);
    expect(argsFor('auto-edit')).toEqual(['--permission-mode', 'acceptEdits']);
    expect(argsFor('full-auto')).toEqual(['--permission-mode', 'bypassPermissions']);
    expect(argsFor('ask')).toEqual([]);
    expect(argsFor(undefined)).toEqual([]);
  });

  it('omits --settings when none provided', () => {
    withCliOnPath();
    const recipe = claudeAdapter.buildSpawn({
      cwd: tmp,
      sessionId: 's',
      stateDir: path.join(tmp, 'state'),
    });
    expect(recipe.args).not.toContain('--settings');
  });
});
