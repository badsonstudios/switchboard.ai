// @vitest-environment jsdom
//
// #1485 — the removed "on submit" setting is wiped from the ui blob at boot.
//
// A workspace saved before the removal can still hold `presentationPolicy`
// (the owner's had "Collapse on submit" on one group). Nothing reads it any
// more; this pins that the record is also DELETED, so no later build can read
// it back, and that a workspace without it costs no write.
import { describe, it, expect } from 'vitest';
import { loadUiState, uiAll } from './ui-state';
import { initPresentation, RETIRED_SUBMIT_POLICY_KEY } from './presentation-boot';

/** Install a bridge whose `workspace:getUi` answers `blob`; records pushes. */
function bridgeAnswering(blob: Record<string, unknown>): { pushed: unknown[] } {
  const pushed: unknown[] = [];
  (window as unknown as { switchboard: unknown }).switchboard = {
    workspace: {
      getUi: () => Promise.resolve(blob),
      setUi: (b: unknown) => pushed.push(b),
    },
  };
  return { pushed };
}

describe('the removed "on submit" setting at boot (#1485)', () => {
  it('a saved setting is deleted, and the deletion is pushed to main', async () => {
    const { pushed } = bridgeAnswering({
      [RETIRED_SUBMIT_POLICY_KEY]: { global: 'auto-collapse', groups: { g1: 'auto-collapse' } },
      theme: 'nordic',
    });
    await loadUiState();
    initPresentation();
    expect(uiAll()).not.toHaveProperty(RETIRED_SUBMIT_POLICY_KEY);
    expect(uiAll()).toHaveProperty('theme', 'nordic');
    const last = pushed.at(-1) as Record<string, unknown> | undefined;
    expect(last).toBeDefined();
    expect(last).not.toHaveProperty(RETIRED_SUBMIT_POLICY_KEY);
  });

  it('a workspace without it is not written to on its account', async () => {
    const { pushed } = bridgeAnswering({ theme: 'nordic' });
    await loadUiState();
    initPresentation();
    expect(pushed).toEqual([]);
  });
});
