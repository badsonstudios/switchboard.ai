// Claude's `detect` (#1291), against the CLI contract measured on PATH 2.1.288:
// `--version` prints `2.1.288 (Claude Code)`; `auth status --json` prints
// `{loggedIn, authMethod, email?, subscriptionType?, …}` and exits 1 when
// logged out. No real CLI is started here.
import { describe, expect, it, vi } from 'vitest';
import type { CaptureResult } from '../transport/run-capture';
import { claudeDetect, parseAuthStatus, parseClaudeVersion } from './claude-detect';

const out = (stdout: string, code = 0): CaptureResult => ({ code, stdout, stderr: '' });
const signal = (): AbortSignal => new AbortController().signal;

const LOGGED_IN = JSON.stringify({
  loggedIn: true,
  authMethod: 'claude.ai',
  apiProvider: 'firstParty',
  email: 'dan@example.com',
  orgId: 'x',
  subscriptionType: 'max',
});
const LOGGED_OUT = JSON.stringify({ loggedIn: false, authMethod: 'none', apiProvider: 'firstParty' });

function runner(answers: Record<string, CaptureResult>) {
  return vi.fn((...a: [string, string[], AbortSignal]) => Promise.resolve(answers[a[1].join(' ')] ?? out('', 1)));
}

describe('parseClaudeVersion', () => {
  it('takes the semver off the first line', () => {
    expect(parseClaudeVersion('2.1.288 (Claude Code)\n')).toBe('2.1.288');
    expect(parseClaudeVersion('3.0.0-beta.1 (Claude Code)')).toBe('3.0.0-beta.1');
    expect(parseClaudeVersion('')).toBeUndefined();
    expect(parseClaudeVersion('something else')).toBe('something else');
  });
});

describe('parseAuthStatus', () => {
  it('logged in, with the account and plan the CLI reports', () => {
    expect(parseAuthStatus(out(LOGGED_IN))).toEqual({ login: 'logged-in', account: 'dan@example.com', plan: 'max' });
  });
  it('logged out (the CLI exits 1 and still prints the object)', () => {
    expect(parseAuthStatus(out(LOGGED_OUT, 1))).toEqual({ login: 'logged-out' });
  });
  it('anything unreadable is unknown, never a guess', () => {
    expect(parseAuthStatus(out('error: unknown command'))).toMatchObject({ login: 'unknown' });
    expect(parseAuthStatus({ code: null, stdout: '', stderr: '', error: 'aborted' })).toEqual({
      login: 'unknown',
      detail: 'auth status: aborted',
    });
  });
});

describe('claudeDetect', () => {
  it('not installed: no CLI on PATH, and nothing is started', async () => {
    const run = runner({});
    const r = await claudeDetect({ resolve: () => null, run }).detect(signal());
    expect(r).toEqual({ installed: false, login: 'unknown' });
    expect(run).not.toHaveBeenCalled();
  });

  it('installed and logged in', async () => {
    const run = runner({ '--version': out('2.1.288 (Claude Code)\n'), 'auth status --json': out(LOGGED_IN) });
    const r = await claudeDetect({ resolve: () => 'C:/npm/claude.cmd', run }).detect(signal());
    expect(r).toEqual({ installed: true, version: '2.1.288', login: 'logged-in', account: 'dan@example.com', plan: 'max' });
    expect(run).toHaveBeenCalledWith('C:/npm/claude.cmd', ['--version'], expect.anything());
    expect(run).toHaveBeenCalledWith('C:/npm/claude.cmd', ['auth', 'status', '--json'], expect.anything());
  });

  it('installed and logged out', async () => {
    const run = runner({ '--version': out('2.1.288 (Claude Code)'), 'auth status --json': out(LOGGED_OUT, 1) });
    expect(await claudeDetect({ resolve: () => '/usr/bin/claude', run }).detect(signal())).toEqual({
      installed: true,
      version: '2.1.288',
      login: 'logged-out',
    });
  });

  it('passes the runner’s signal to both processes, so a timeout kills them', async () => {
    const run = runner({});
    const c = new AbortController();
    await claudeDetect({ resolve: () => '/usr/bin/claude', run }).detect(c.signal);
    for (const call of run.mock.calls) expect(call[2]).toBe(c.signal);
  });

  it('login is not driven from here, and says how', async () => {
    const r = await claudeDetect({ resolve: () => null }).login!(signal());
    expect(r.supported).toBe(false);
    expect(r.reason).toMatch(/claude auth login/);
  });
});
