// @vitest-environment jsdom
// The two surfaces the status record drives besides the banner (P2-E14-07):
// the status-bar dot, and the incident notice in the Events panel.
//
// Mounted through the REAL contribution and the REAL panel, because what is
// being checked is what a screen reader and a mouse actually find — a helper
// returning the right key proves nothing about the DOM that renders it.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { initI18nForTests } from '../i18n/test-i18n';
import { ServiceHealthStatus } from '../../../shared/service-health';
import { statusBarItems } from '../extensibility/status-bar-items';
import { StatusBarContext } from '../extensibility/contributions';
import { EventsPanel } from './EventsPanel';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let root: Root | null = null;
let host: HTMLElement;

const ctx = (serviceHealth: ServiceHealthStatus | null): StatusBarContext => ({
  count: 1,
  theme: 'nordic',
  themeNameKey: 'theme.nordic',
  serviceHealth,
});

const health = (over: Partial<ServiceHealthStatus> = {}): ServiceHealthStatus => ({
  state: 'operational',
  reason: 'ok',
  incidents: [],
  corroboration: null,
  ...over,
});

const item = statusBarItems.find((i) => i.manifest.id === 'status-service-health')!;

async function mount(tree: React.ReactNode): Promise<void> {
  await act(async () => {
    root!.render(tree);
  });
}

function dot(): HTMLElement | null {
  return host.querySelector<HTMLElement>('[data-testid="service-health"]');
}

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

describe('the status-bar dot', () => {
  it('shows nothing at all before main has said anything', async () => {
    await mount(<>{item.render(ctx(null))}</>);
    expect(dot()).toBeNull();
  });

  it.each(['operational', 'degraded', 'outage', 'unknown'] as const)(
    'renders the %s state with an accessible name',
    async (state) => {
      await mount(<>{item.render(ctx(health({ state })))}</>);
      expect(dot()?.dataset.state).toBe(state);
      const img = host.querySelector<HTMLElement>('[role="img"]');
      // the name is the SENTENCE, not the character — "●" read aloud is noise
      expect(img?.getAttribute('aria-label')).toBeTruthy();
      expect(img?.getAttribute('aria-label')).not.toBe(img?.textContent);
    }
  );

  it('puts words next to the dot when something is wrong', async () => {
    await mount(<>{item.render(ctx(health({ state: 'outage' })))}</>);
    expect(dot()?.textContent).toContain('outage');
  });

  it('stays a bare dot when everything is fine', async () => {
    await mount(<>{item.render(ctx(health()))}</>);
    expect(dot()?.textContent).toBe('●');
  });

  it('names the open incidents in the tooltip', async () => {
    await mount(
      <>
        {item.render(
          ctx(
            health({
              state: 'outage',
              description: 'Partial System Outage',
              incidents: [
                { id: 'a', name: 'Elevated API errors', status: 'investigating', impact: 'major' },
              ],
            })
          )
        )}
      </>
    );
    expect(dot()?.getAttribute('title')).toContain('Elevated API errors');
    expect(dot()?.getAttribute('title')).toContain('Partial System Outage');
  });

  it('says it could not check rather than showing an error', async () => {
    await mount(<>{item.render(ctx(health({ state: 'unknown', reason: 'network' })))}</>);
    const title = dot()?.getAttribute('title') ?? '';
    expect(title).toContain("Couldn't reach");
    // nothing to dismiss, nothing to answer: it is a tooltip on a grey dot
    expect(host.querySelectorAll('button')).toHaveLength(0);
  });
});

describe('the incident notice in the Events panel', () => {
  const panel = (incidents?: { id: string; name: string; status: string }[]) => (
    <EventsPanel
      sessions={[]}
      events={[]}
      queueEvents={[]}
      visited={new Set<number>()}
      onFocus={() => {}}
      onVisit={() => {}}
      queueBinding="Ctrl+Space"
      incidents={incidents}
    />
  );

  it('is absent while the provider is fine', async () => {
    await mount(panel());
    expect(host.querySelector('[data-events-notice="incident"]')).toBeNull();
  });

  it('lists an open incident, politely announced', async () => {
    await mount(panel([{ id: 'a', name: 'Elevated API errors', status: 'investigating' }]));
    const card = host.querySelector<HTMLElement>('[data-events-notice="incident"]');
    expect(card).not.toBeNull();
    expect(card?.textContent).toContain('Elevated API errors');
    const live = card?.querySelector('[role="status"]');
    expect(live?.getAttribute('aria-live')).toBe('polite');
  });

  it('offers no buttons — an incident is not an offer', async () => {
    await mount(panel([{ id: 'a', name: 'Elevated API errors', status: 'investigating' }]));
    const card = host.querySelector<HTMLElement>('[data-events-notice="incident"]');
    expect(card?.querySelectorAll('button')).toHaveLength(0);
  });

  it('goes away when the incident resolves', async () => {
    await mount(panel([{ id: 'a', name: 'Elevated API errors', status: 'investigating' }]));
    await mount(panel([]));
    expect(host.querySelector('[data-events-notice="incident"]')).toBeNull();
  });

  it('does not leave the panel claiming there is nothing to see', async () => {
    // "Nothing needs you right now" under an open provider incident reads as a
    // panel that has not noticed
    await mount(panel([{ id: 'a', name: 'Elevated API errors', status: 'investigating' }]));
    expect(host.textContent).not.toContain('Nothing needs you right now');
  });
});
