// What the bootstrap registers (#1290): with Codex absent, exactly what it
// registered before — Claude alone; with `npx` on PATH, Codex goes in AFTER
// Claude, so Claude stays the default AI; and a fake-provider e2e launch
// never sees a real Codex.
import fs from 'fs';
import path from 'path';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { tempDir } from '../test-temp-dirs';

const NPX = process.platform === 'win32' ? 'npx.cmd' : 'npx';

async function registeredIds(env: { PATH: string; fake?: string }): Promise<string[]> {
  vi.resetModules();
  vi.stubEnv('PATH', env.PATH);
  vi.stubEnv('SWITCHBOARD_FAKE_PROVIDER', env.fake ?? '');
  const { registerBuiltinContributions } = await import('./bootstrap');
  const { registry } = await import('./extensibility');
  registerBuiltinContributions();
  return registry.list('provider-adapter').map((p) => p.manifest.id);
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('registerBuiltinContributions', () => {
  it('with no npx on PATH: Claude alone, exactly as before Codex existed', async () => {
    const empty = tempDir('sb-boot-nonpx-');
    expect(await registeredIds({ PATH: empty })).toEqual(['claude-code']);
  });

  it('with npx on PATH: Claude first (still the default), then Codex', async () => {
    const dir = tempDir('sb-boot-npx-');
    fs.writeFileSync(path.join(dir, NPX), '');
    expect(await registeredIds({ PATH: dir })).toEqual(['claude-code', 'codex']);
  });

  it('a fake-provider e2e launch never registers Codex, even with npx on PATH', async () => {
    const dir = tempDir('sb-boot-fake-');
    fs.writeFileSync(path.join(dir, NPX), '');
    expect(await registeredIds({ PATH: dir, fake: '1' })).toEqual(['claude-code']);
    expect(await registeredIds({ PATH: dir, fake: 'acp' })).toEqual(['fake-acp', 'claude-code']);
    // both (#1294): the Claude fake first, the default, then the ACP fake
    expect(await registeredIds({ PATH: dir, fake: 'both' })).toEqual(['claude-code', 'fake-acp']);
  });
});
