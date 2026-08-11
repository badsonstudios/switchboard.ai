// @vitest-environment jsdom
// The corroboration strip actually reaching a screen reader (P2-E14-07, §5.14).
//
// Same defect class as #222/#314, so the same assertions: the live region has
// to exist before the words do, the words have to land INSIDE it, and a quiet
// day has to paint nothing at all. The banner is pushed from main at a moment
// nobody is looking for it — which is exactly when an un-announced region is
// worth nothing.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act, StrictMode } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { initI18nForTests } from '../i18n/test-i18n';
import { ServiceHealthStatus } from '../../../shared/service-health';
import { ServiceHealthBanner } from './ServiceHealthBanner';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let root: Root | null = null;
let host: HTMLElement;

const quiet: ServiceHealthStatus = {
  state: 'operational',
  reason: 'ok',
  incidents: [],
  corroboration: null,
};
const raised: ServiceHealthStatus = {
  ...quiet,
  corroboration: { sessions: 3 },
};

function region(): HTMLElement | null {
  return host.querySelector<HTMLElement>('[role="status"]');
}

async function render(status: ServiceHealthStatus | null, strict = false): Promise<void> {
  const tree = strict ? (
    <StrictMode>
      <ServiceHealthBanner status={status} />
    </StrictMode>
  ) : (
    <ServiceHealthBanner status={status} />
  );
  await act(async () => {
    root!.render(tree);
  });
}

describe('the corroboration banner', () => {
  beforeEach(async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    document.body.innerHTML = '';
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await initI18nForTests();
  });

  afterEach(async () => {
    if (root) {
      const r = root;
      root = null;
      await act(async () => r.unmount());
    }
  });

  it('has its live region up before main has said anything', async () => {
    await render(null);
    expect(region()).not.toBeNull();
    expect(region()?.textContent).toBe('');
    // and it paints nothing: no class, so the CSS rule does not apply
    expect(region()?.className).toBe('');
  });

  it('stays silent while the sessions are fine', async () => {
    await render(quiet);
    expect(region()?.textContent).toBe('');
  });

  it('speaks when several sessions error at once, and says how many', async () => {
    await render(raised);
    expect(region()?.textContent).toContain('3 sessions');
    expect(region()?.className).toBe('service-health-banner');
  });

  it('puts the words INTO the region that was already there', async () => {
    await render(quiet);
    const before = region();
    await render(raised);
    expect(region()).toBe(before);
    expect(before?.textContent).not.toBe('');
  });

  it('lands its words as a second mutation even when it mounts already raised', async () => {
    // main polls at startup and pushes before the shell finishes mounting, so
    // this really can arrive raised on the first frame — the silent case.
    const seen: MutationRecord[] = [];
    const obs = new MutationObserver((records) => seen.push(...records));
    obs.observe(host, { childList: true, subtree: true, characterData: true });
    await render(raised);
    seen.push(...obs.takeRecords());
    obs.disconnect();
    const el = region();
    const arrived = seen.findIndex((r) => [...r.addedNodes].includes(el as Node));
    const spoke = seen.findIndex((r) => r.target === el && r.addedNodes.length > 0);
    expect(arrived, 'the region was never inserted on its own').toBeGreaterThanOrEqual(0);
    expect(spoke, 'the words came WITH the region — nothing would announce them').toBeGreaterThan(
      arrived
    );
  });

  it('goes away on its own when the sessions recover', async () => {
    await render(raised);
    expect(region()?.textContent).not.toBe('');
    await render(quiet);
    expect(region()?.textContent).toBe('');
    expect(region()?.className).toBe('');
  });

  it('offers nothing to click — there is no decision to make', async () => {
    await render(raised);
    expect(host.querySelectorAll('button')).toHaveLength(0);
  });

  it('survives StrictMode double-rendering', async () => {
    await render(quiet, true);
    const before = region();
    await render(raised, true);
    expect(region()).toBe(before);
    expect(before?.textContent).not.toBe('');
  });
});
