// Preflight, per AI (#1288). The host runs each provider's own check and
// reports the DEFAULT provider's answer at the top level, which is what the
// banner and the status-bar version read.
import { describe, it, expect, vi } from 'vitest';
import { runPreflight, PREFLIGHT_TIMEOUT_MS, type PreflightTarget } from './preflight';
import type { ProviderPreflight } from './extensibility/contributions';

const FOUND: ProviderPreflight = {
  cliPath: '/usr/bin/claude',
  version: '2.1.290 (Claude Code)',
  configPresent: true,
  ok: true,
};
const MISSING: ProviderPreflight = { cliPath: null, version: null, configPresent: false, ok: false };

const target = (providerId: string, check?: () => Promise<ProviderPreflight>): PreflightTarget => ({
  providerId,
  name: providerId.toUpperCase(),
  capabilities: check ? { preflight: { check } } : {},
});

describe('runPreflight', () => {
  it('with one provider, answers exactly that provider’s check', async () => {
    const r = await runPreflight([target('claude-code', async () => MISSING)], 'claude-code');
    expect(r).toMatchObject({ ...MISSING, providerId: 'claude-code', checked: true });
    expect(r.providers).toHaveLength(1);
  });

  it('the top level is the DEFAULT provider’s, whatever the others say', async () => {
    const r = await runPreflight(
      [target('other', async () => MISSING), target('claude-code', async () => FOUND)],
      'claude-code'
    );
    expect(r.ok).toBe(true);
    expect(r.version).toBe(FOUND.version);
    // ...and every provider's own answer is still reported
    expect(r.providers.map((p) => [p.providerId, p.ok])).toEqual([
      ['other', false],
      ['claude-code', true],
    ]);
  });

  it('a provider that declares NO check is not checked — and not reported broken', async () => {
    const r = await runPreflight([target('quiet')], 'quiet');
    expect(r).toMatchObject({ providerId: 'quiet', checked: false, ok: true, cliPath: null, version: null });
  });

  it('a check that THROWS is "not checked", logged, never a rejection', async () => {
    const log = vi.fn();
    const r = await runPreflight(
      [
        target('broken', () => {
          throw new Error('check exploded');
        }),
      ],
      'broken',
      log
    );
    expect(r).toMatchObject({ checked: false, ok: true });
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('preflight check threw'),
      expect.objectContaining({ provider: 'broken' })
    );
  });

  it('a check that never answers is cut off and reported "not checked"', async () => {
    vi.useFakeTimers();
    try {
      const log = vi.fn();
      const pending = runPreflight(
        [target('stuck', () => new Promise(() => {})), target('claude-code', async () => FOUND)],
        'claude-code',
        log
      );
      await vi.advanceTimersByTimeAsync(PREFLIGHT_TIMEOUT_MS + 1);
      const r = await pending;
      // the default's answer was not held hostage by the stuck one
      expect(r).toMatchObject({ providerId: 'claude-code', ok: true, version: FOUND.version });
      expect(r.providers.find((p) => p.providerId === 'stuck')).toMatchObject({ checked: false, ok: true });
      expect(log).toHaveBeenCalledWith(expect.stringContaining('did not answer in time'), expect.anything());
    } finally {
      vi.useRealTimers();
    }
  });

  it('an answer that is not the promised shape is "not checked", never a banner', async () => {
    for (const bad of [undefined, null, {}, { ok: 'yes' }]) {
      const r = await runPreflight(
        [target('odd', async () => bad as unknown as ProviderPreflight)],
        'odd'
      );
      expect(r, JSON.stringify(bad)).toMatchObject({ checked: false, ok: true });
    }
  });

  it('a default that is not registered claims nothing', async () => {
    const r = await runPreflight([target('claude-code', async () => FOUND)], 'gone');
    expect(r).toMatchObject({ providerId: 'gone', checked: false, ok: true, version: null });
  });

  it('runs the checks side by side, not one after another', async () => {
    let inFlight = 0;
    let most = 0;
    const slow = async (): Promise<ProviderPreflight> => {
      inFlight++;
      most = Math.max(most, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return FOUND;
    };
    await runPreflight([target('a', slow), target('b', slow)], 'a');
    expect(most).toBe(2);
  });
});
