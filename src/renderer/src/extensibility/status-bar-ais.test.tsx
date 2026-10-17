// @vitest-environment jsdom
// The status bar's list of AIs (E40 item 10, #1293): each detected AI with its
// version, Claude first, the health dot after the AI it describes — in place of
// the single `claude <version>` line, which is still the answer when no list
// of AIs has arrived. Asserted against the REAL `en.json`.
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { initI18nForTests } from '../i18n/test-i18n';
import { createRendererRegistry } from '../bootstrap';
import type { StatusBarContext } from './contributions';
import { statusBarAis } from './status-bar-items';
import { resetAisStoreForTests, type AisState } from '../lib/ais-store';
import type { AiListItem, CatalogEntry, DetectionResult } from '../../../shared/ais';
import type { ServiceHealthStatus } from '../../../shared/service-health';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let host: HTMLDivElement;
let root: Root;

beforeAll(async () => {
  await initI18nForTests();
});

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  resetAisStoreForTests();
});

const found = (version?: string): DetectionResult => ({
  installed: true,
  ...(version ? { version } : {}),
  login: 'logged-in',
  probedAt: 1,
});

function catalog(id: string, name: string, detection?: DetectionResult, providerId?: string): AiListItem {
  const entry: CatalogEntry = {
    id,
    name,
    maker: 'x',
    description: '',
    engine: id === 'claude-code' ? 'native' : 'acp',
    install: { kind: 'link', url: 'https://example.invalid' },
    detectCommand: id,
    runsLocalModels: false,
    icon: `${id}.svg`,
    ...(providerId ? { providerId } : {}),
  };
  return { kind: 'catalog', entry, providerId, registered: !!providerId, ...(detection ? { detection } : {}) };
}

const OPERATIONAL: ServiceHealthStatus = {
  state: 'operational',
  reason: 'ok',
  incidents: [],
  corroboration: null,
};

const base: StatusBarContext = { count: 1, theme: 'nordic', themeNameKey: 'theme.nordic' };

function renderEnd(over: Partial<StatusBarContext>): HTMLElement {
  const items = createRendererRegistry()
    .list('status-bar-item')
    .filter((i) => i.align === 'end')
    .sort((a, b) => a.order - b.order);
  act(() => {
    root.render(
      <>
        {items.map((i) => (
          <span key={i.manifest.id} data-item={i.manifest.id}>
            {i.render({ ...base, ...over })}
          </span>
        ))}
      </>
    );
  });
  return host;
}

describe('which AIs the status bar lists (statusBarAis)', () => {
  it('Claude first, then every other AI found installed, in list order', () => {
    const state: AisState = {
      items: [
        catalog('codex-acp', 'Codex', found('0.48.0'), 'codex'),
        catalog('gemini', 'Gemini CLI', { installed: 'unknown', login: 'unknown', probedAt: 1 }),
        catalog('claude-code', 'Claude Code', found('2.1.288'), 'claude-code'),
        catalog('goose', 'goose', { installed: false, login: 'unknown', probedAt: 1 }),
        { kind: 'provider', entry: { id: 'fake-acp', name: 'Fake ACP' }, providerId: 'fake-acp', registered: true, detection: found('0.0.0') },
      ],
      defaultId: 'claude-code',
    };
    const ais = statusBarAis(state, undefined, 'AI');
    expect(ais.map((a) => [a.look.name, a.version])).toEqual([
      ['Claude Code', '2.1.288'],
      ['Codex', '0.48.0'],
      ['Fake ACP', '0.0.0'],
    ]);
    // a slow probe ('unknown') is not a claim worth printing, and neither is false
    expect(ais.map((a) => a.providerId)).not.toContain('gemini');
  });

  it("keeps a Claude the old line showed even before detection says so", () => {
    const state: AisState = { items: [catalog('claude-code', 'Claude Code', undefined, 'claude-code')], defaultId: null };
    expect(statusBarAis(state, '2.1.200', 'AI')).toEqual([
      expect.objectContaining({ providerId: 'claude-code', version: '2.1.200' }),
    ]);
    // ...and drops one that neither source has seen
    expect(statusBarAis(state, null, 'AI')).toEqual([]);
  });

  it('is empty with no list, so the caller can show the old line', () => {
    expect(statusBarAis({ items: null, defaultId: null }, '2.1.288', 'AI')).toEqual([]);
  });
});

describe('the AIs readout on the bar', () => {
  it('names each AI with its version, and puts the health dot after the default one', () => {
    resetAisStoreForTests({
      items: [
        catalog('claude-code', 'Claude Code', found('2.1.288'), 'claude-code'),
        catalog('codex-acp', 'Codex', found('0.48.0'), 'codex'),
      ],
      defaultId: 'claude-code',
    });
    const bar = renderEnd({ cliVersion: '2.1.288', serviceHealth: OPERATIONAL });
    const readout = bar.querySelector<HTMLElement>('[data-testid="status-ais"]')!;
    expect(readout.textContent).toContain('Claude Code 2.1.288');
    expect(readout.textContent).toContain('Codex 0.48.0');
    // the title lists every AI, for the window too narrow to show them
    expect(readout.getAttribute('title')).toBe('AIs on this computer: Claude Code 2.1.288, Codex 0.48.0');
    // the dot: inside Claude's entry, and drawn ONCE on the whole bar
    expect(readout.querySelector('[data-status-ai="claude-code"] [data-testid="service-health"]')).not.toBeNull();
    expect(bar.querySelectorAll('[data-testid="service-health"]')).toHaveLength(1);
    // never wraps; may clip with an ellipsis
    expect(readout.style.whiteSpace).toBe('nowrap');
    expect(readout.style.textOverflow).toBe('ellipsis');
    // each AI's icon, decorative (the words are beside it)
    expect(readout.querySelectorAll('img[alt=""]')).toHaveLength(2);
  });

  it('keeps the dot on its own when the AI it describes is not listed', () => {
    resetAisStoreForTests({
      items: [catalog('claude-code', 'Claude Code', found('2.1.288'), 'claude-code')],
      defaultId: 'fake-acp',
    });
    const bar = renderEnd({ serviceHealth: OPERATIONAL });
    expect(bar.querySelector('[data-item="status-service-health"] [data-testid="service-health"]')).not.toBeNull();
    expect(bar.querySelectorAll('[data-testid="service-health"]')).toHaveLength(1);
  });

  it('with no list of AIs, is exactly the old line and the old dot (fail-open)', () => {
    const bar = renderEnd({ cliVersion: '2.1.288', serviceHealth: OPERATIONAL });
    expect(bar.querySelector('[data-testid="status-ais"]')).toBeNull();
    expect(bar.querySelector('[data-item="status-ais"]')!.textContent).toBe('claude 2.1.288');
    expect(bar.querySelector('[data-item="status-service-health"] [data-testid="service-health"]')).not.toBeNull();
  });
});
