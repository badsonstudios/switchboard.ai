// Detecting Codex (#1290): a PATH scan, `codex --version`, and the login
// state from `account/read` — with the shapes measured on the owner's machine.
import fs from 'fs';
import path from 'path';
import { describe, it, expect } from 'vitest';
import { tempDir } from '../../../test-temp-dirs';
import {
  codexInstalled,
  codexLoginState,
  codexVersion,
  detectCodex,
  findOnPath,
  npxPath,
  parseAccount,
} from './codex-detect';

function pathWith(...files: string[]): string {
  const dir = tempDir('sb-codex-detect-');
  for (const f of files) fs.writeFileSync(path.join(dir, f), '');
  return dir;
}

describe('the PATH scan', () => {
  it('finds codex.cmd on Windows and codex elsewhere; null when absent', () => {
    const win = pathWith('codex.cmd');
    expect(codexInstalled(win, 'win32')).toBe(path.join(win, 'codex.cmd'));
    const nix = pathWith('codex');
    expect(codexInstalled(nix, 'linux')).toBe(path.join(nix, 'codex'));
    expect(codexInstalled(pathWith('claude.cmd'), 'win32')).toBeNull();
    expect(codexInstalled('', 'win32')).toBeNull();
  });

  it('finds npx.cmd on Windows (the adapter runs through it)', () => {
    const empty = pathWith();
    const dir = pathWith('npx.cmd');
    expect(npxPath([empty, dir].join(path.delimiter), 'win32')).toBe(path.join(dir, 'npx.cmd'));
    expect(npxPath(empty, 'win32')).toBeNull();
  });

  it('a directory with the name is not a match', () => {
    const dir = tempDir('sb-codex-detect-');
    fs.mkdirSync(path.join(dir, 'codex.cmd'));
    expect(findOnPath(['codex.cmd'], dir)).toBeNull();
  });
});

describe('codexVersion', () => {
  it('reads `codex-cli 0.163.0` (measured)', async () => {
    await expect(codexVersion('codex.cmd', () => Promise.resolve('codex-cli 0.163.0\n'))).resolves.toBe('0.163.0');
  });
  it('null when not installed, failed, or unreadable', async () => {
    await expect(codexVersion(null, () => Promise.resolve('codex-cli 1.0.0'))).resolves.toBeNull();
    await expect(codexVersion('codex.cmd', () => Promise.resolve(null))).resolves.toBeNull();
    await expect(codexVersion('codex.cmd', () => Promise.resolve('no version here'))).resolves.toBeNull();
    await expect(codexVersion('codex.cmd', () => Promise.reject(new Error('x')))).resolves.toBeNull();
  });
});

describe('the login state', () => {
  it('logged in, with the plan (measured shape, email left out)', () => {
    expect(
      parseAccount({
        ok: true,
        result: {
          account: { type: 'chatgpt', email: 'someone@example.com', planType: 'team' },
          requiresOpenaiAuth: true,
        },
      })
    ).toEqual({ state: 'logged-in', plan: 'team' });
  });

  it('logged out (measured: account null)', () => {
    expect(parseAccount({ ok: true, result: { account: null, requiresOpenaiAuth: true, workspaceRouting: null } })).toEqual(
      { state: 'logged-out' }
    );
  });

  it('anything else is unknown, never a guess', () => {
    expect(parseAccount({ ok: false, reason: 'timed out' })).toEqual({ state: 'unknown' });
    expect(parseAccount({ ok: true, result: {} })).toEqual({ state: 'unknown' });
    expect(parseAccount({ ok: true, result: { account: {} } })).toEqual({ state: 'unknown' });
    expect(parseAccount({ ok: true, result: { account: 'yes' } })).toEqual({ state: 'unknown' });
  });

  it('no CLI or a throwing probe is unknown', async () => {
    await expect(codexLoginState(null)).resolves.toEqual({ state: 'unknown' });
    await expect(codexLoginState('codex.cmd', () => Promise.reject(new Error('boom')))).resolves.toEqual({
      state: 'unknown',
    });
    await expect(
      codexLoginState('codex.cmd', () => Promise.resolve({ ok: true, result: { account: null } }))
    ).resolves.toEqual({ state: 'logged-out' });
  });
});

describe('detectCodex (the shape #1291 detect returns)', () => {
  const live = () => new AbortController().signal;

  it('installed and logged in: version and plan', async () => {
    await expect(
      detectCodex(live(), {
        cliPath: () => 'codex.cmd',
        version: () => Promise.resolve('0.163.0'),
        login: () => Promise.resolve({ state: 'logged-in', plan: 'team' }),
      })
    ).resolves.toEqual({ installed: true, version: '0.163.0', login: 'logged-in', plan: 'team' });
  });

  it('not installed means the codex CLI, not npx: nothing is probed', async () => {
    let probed = false;
    const got = await detectCodex(live(), {
      cliPath: () => null,
      version: () => {
        probed = true;
        return Promise.resolve('x');
      },
    });
    expect(got).toMatchObject({ installed: false, login: 'unknown' });
    expect(probed).toBe(false);
  });

  it('logged out', async () => {
    await expect(
      detectCodex(live(), {
        cliPath: () => 'codex.cmd',
        version: () => Promise.resolve('0.163.0'),
        login: () => Promise.resolve({ state: 'logged-out' }),
      })
    ).resolves.toEqual({ installed: true, version: '0.163.0', login: 'logged-out' });
  });

  it("the runner's deadline: unknown, and the probes are handed the signal to stop", async () => {
    const ac = new AbortController();
    const seen: AbortSignal[] = [];
    const hang = (_c: string, s: AbortSignal) =>
      new Promise<never>((_r, rej) => {
        seen.push(s);
        s.addEventListener('abort', () => rej(new Error('aborted')));
      });
    const p = detectCodex(ac.signal, { cliPath: () => 'codex.cmd', version: hang, login: hang });
    ac.abort();
    await expect(p).resolves.toMatchObject({ installed: true, login: 'unknown', detail: 'Codex did not answer in time' });
    expect(seen).toEqual([ac.signal, ac.signal]);
  });

  it('a PATH scan that throws is unknown, never a rejection', async () => {
    await expect(
      detectCodex(live(), {
        cliPath: () => {
          throw new Error('x');
        },
      })
    ).resolves.toMatchObject({ installed: 'unknown', login: 'unknown' });
  });
});
