// The Codex provider's registration (#1290): what it runs, how it signs in,
// and the mode map — the owner's rule that no card mode lands on Codex's
// hidden-approver `agent` mode.
import fs from 'fs';
import path from 'path';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { AUTONOMY_MODES } from '../../../shared/sessions';
import { tempDir } from '../../../test-temp-dirs';
import { CODEX_ACP_PACKAGE, CODEX_MODE_MAP, codexAdapter, shouldRegisterCodex } from './codex-provider';

const NPX = process.platform === 'win32' ? 'npx.cmd' : 'npx';

afterEach(() => vi.unstubAllEnvs());

describe('codexAdapter', () => {
  it('is Codex, an ACP provider with resume and the Session Bus', () => {
    expect(codexAdapter.manifest).toMatchObject({ id: 'codex', displayName: 'Codex' });
    const caps = codexAdapter.capabilities!;
    expect(caps.events && caps.controls && caps.resume && caps.mcp).toBeTruthy();
    // no Fork, no transcripts we can read (design record §6)
    expect(caps.fork).toBeUndefined();
    expect(caps.transcripts).toBeUndefined();
  });

  it('declares usage with NO price: tokens on a ChatGPT plan cost nothing anyone reported', () => {
    const usage = codexAdapter.capabilities!.usage!;
    expect(usage.estimateCostUsd({ input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheCreate: 0 }, 'gpt-6-luna')).toBeUndefined();
    // the engine surface is intact under the spread
    expect(typeof codexAdapter.sessionFor).toBe('function');
    expect(codexAdapter.capabilities!.controls).toBeDefined();
  });

  it('runs the PINNED adapter through the absolute npx it finds on PATH', () => {
    const dir = tempDir('sb-codex-npx-');
    fs.writeFileSync(path.join(dir, NPX), '');
    vi.stubEnv('PATH', dir);
    const recipe = codexAdapter.buildSpawn({ cwd: dir, sessionId: 'codex-test-1', stateDir: dir });
    expect(recipe.command).toBe(path.join(dir, NPX));
    expect(recipe.args).toEqual(['-y', '@agentclientprotocol/codex-acp@2.2.2']);
    expect(CODEX_ACP_PACKAGE).toMatch(/@\d+\.\d+\.\d+$/); // a version, never a range or "latest"
    expect(recipe.transport).toBe('stream');
    // CODEX_PATH is not set: the adapter's bundled Codex runs (the owner's call)
    expect(recipe.env ?? {}).not.toHaveProperty('CODEX_PATH');
  });

  it('with no npx, the spawn fails with a named error instead of a PATH-relative guess', () => {
    vi.stubEnv('PATH', tempDir('sb-codex-nonpx-'));
    expect(() => codexAdapter.buildSpawn({ cwd: 'C:/x', sessionId: 'codex-test-2', stateDir: 'C:/x' })).toThrow(
      /npx not found on PATH/
    );
  });

  it('...and Log in without npx says so as a code the AIs tab translates (#1365)', async () => {
    vi.stubEnv('PATH', tempDir('sb-codex-nonpx-login-'));
    const r = await codexAdapter.capabilities!.detect!.login!(new AbortController().signal);
    expect(r).toMatchObject({ supported: true, ok: false, reasonCode: { code: 'npx-missing' } });
    expect(r.reason).toMatch(/npx not found on PATH/);
  });
});

describe("Codex's detect capability (#1291's runner)", () => {
  const CODEX = process.platform === 'win32' ? 'codex.cmd' : 'codex';
  const detect = (signal = AbortSignal.timeout(5_000)) => codexAdapter.capabilities!.detect!.detect(signal);

  it('REGRESSION: Codex is NOT reported installed when only npx exists', async () => {
    const dir = tempDir('sb-codex-detect-npx-only-');
    fs.writeFileSync(path.join(dir, NPX), '');
    vi.stubEnv('PATH', dir);
    await expect(detect()).resolves.toMatchObject({ installed: false, login: 'unknown' });
  });

  it('with the codex CLI on PATH it is installed; a CLI that answers nothing leaves version and login unknown', async () => {
    const dir = tempDir('sb-codex-detect-cli-');
    fs.writeFileSync(path.join(dir, CODEX), ''); // an empty program: no version, no sign-in answer
    vi.stubEnv('PATH', dir);
    const got = await detect();
    expect(got).toMatchObject({ installed: true, login: 'unknown' });
    expect(got.version).toBeUndefined();
  });

  it('an already-expired runner deadline answers unknown without probing for long', async () => {
    const dir = tempDir('sb-codex-detect-late-');
    fs.writeFileSync(path.join(dir, CODEX), '');
    vi.stubEnv('PATH', dir);
    const ac = new AbortController();
    ac.abort();
    const t0 = Date.now();
    await expect(detect(ac.signal)).resolves.toMatchObject({ installed: true, login: 'unknown' });
    expect(Date.now() - t0).toBeLessThan(2_000);
  });

  it("keeps the engine's Log in (Codex's own sign-in, never ours)", () => {
    expect(typeof codexAdapter.capabilities!.detect!.login).toBe('function');
  });
});

describe('CODEX_MODE_MAP', () => {
  it('maps every card mode, and none to `agent` (the hidden Guardian approver)', () => {
    expect(Object.keys(CODEX_MODE_MAP).sort()).toEqual([...AUTONOMY_MODES].sort());
    expect(Object.values(CODEX_MODE_MAP)).not.toContain('agent');
  });

  it('uses only mode ids Codex offers (b-session.jsonl)', () => {
    const offered = ['read-only', 'workspace-write', 'agent', 'agent-full-access'];
    for (const v of Object.values(CODEX_MODE_MAP)) expect(offered).toContain(v);
    expect(CODEX_MODE_MAP).toEqual({
      ask: 'workspace-write',
      plan: 'read-only',
      'auto-edit': 'workspace-write',
      'full-auto': 'agent-full-access',
    });
  });
});

describe('shouldRegisterCodex', () => {
  it('only with npx on PATH, and never in a fake-provider launch', () => {
    const dir = tempDir('sb-codex-reg-');
    fs.writeFileSync(path.join(dir, NPX), '');
    expect(shouldRegisterCodex({ PATH: dir })).toBe(true);
    expect(shouldRegisterCodex({ PATH: dir, SWITCHBOARD_FAKE_PROVIDER: '1' })).toBe(false);
    expect(shouldRegisterCodex({ PATH: tempDir('sb-codex-reg-none-') })).toBe(false);
    expect(shouldRegisterCodex({})).toBe(false);
  });
});
