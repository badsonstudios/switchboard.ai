// @vitest-environment jsdom
// The card's "Accept messages from other sessions automatically" entry
// (P2-E11-05, §5.4).
//
// The one thing this entry must never do is SAY the gate is open when main
// holds it shut, or the reverse — a tick that disagrees with the store is the
// menu lying about a safety setting. So every test here reads `aria-pressed`
// against what the stand-in main answered, including when it refuses or
// throws. The dockview wall is climbed exactly as `SessionGrid.sound.test.tsx`
// does; see `SessionGrid.transport.test.tsx` for why the stub is the honest way
// in.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { initI18nForTests } from '../i18n/test-i18n';
import en from '../../../shared/i18n/locales/en.json';
import { sessionStore } from '../store/session-store';
import { registerBuiltinContributions } from '../bootstrap';
import { rendererRegistry } from '../extensibility/registry-instance';
import { AUTO_ACCEPT_LIMIT, AUTO_ACCEPT_WINDOW_MS } from '../../../shared/sibling-message';
import { receiveSiblingMessage, removeHeldMessages, resetInboxCacheForTests } from '../lib/sibling-inbox';
import { loadUiState } from '../lib/ui-state';
import type { IDockviewPanelProps } from 'dockview-react';
import { SessionGrid, type CardParams } from './SessionGrid';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let components: Record<string, React.ComponentType<IDockviewPanelProps<CardParams>>> = {};

vi.mock('dockview-react', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return {
    ...real,
    DockviewReact: (props: {
      components: Record<string, React.ComponentType<IDockviewPanelProps<CardParams>>>;
    }): null => {
      components = props.components;
      return null;
    },
  };
});

vi.mock('./TerminalPane', () => ({
  TerminalPane: (): React.JSX.Element => <div data-testid="terminal-pane" />,
}));
vi.mock('./FeedView', () => ({
  FeedView: (): React.JSX.Element => <div data-testid="feed-view" />,
}));

const off = (): void => {};
const disposable = { dispose: off };

let reads: string[];
let writes: [string, boolean][];
/** what main holds */
let stored: boolean;
/** what main answers to a write — the store's truth, which may differ */
let refuseWrites = false;
let readThrows = false;
let writeThrows = false;

function installBridge(withSiblingApi = true): void {
  reads = [];
  writes = [];
  const siblingApi = withSiblingApi
    ? {
        acceptFromSiblings: (cardId: string) => {
          reads.push(cardId);
          return readThrows ? Promise.reject(new Error('no')) : Promise.resolve(stored);
        },
        setAcceptFromSiblings: (cardId: string, on: boolean) => {
          writes.push([cardId, on]);
          if (writeThrows) return Promise.reject(new Error('store said no'));
          if (!refuseWrites) stored = on;
          return Promise.resolve(stored);
        },
      }
    : {};
  (window as unknown as { switchboard: unknown }).switchboard = {
    sessions: {
      create: () =>
        Promise.resolve({
          id: 'live-1',
          identity: { accentColor: 'var(--faint)', langBadge: 'ts' },
          autonomy: 'ask',
          status: 'idle',
          transport: 'stream',
        }),
      setTransport: () => Promise.resolve({ ok: true }),
      dropLive: () => Promise.resolve(),
      setAutonomy: () => Promise.resolve(),
      setTaskLabel: () => Promise.resolve(),
      decidePermission: () => Promise.resolve(),
      allowAllSession: () => Promise.resolve(),
      closeCard: () => Promise.resolve(),
      pendingPermissions: () => Promise.resolve([]),
      onExited: () => off,
      onUsage: () => off,
      currentModel: () => Promise.resolve(null),
      onModel: () => off,
      onStatus: () => off,
      onPermissionRequest: () => off,
      onPermissionResolved: () => off,
      ...siblingApi,
    },
    transcripts: { binding: () => Promise.resolve(null) },
    git: { status: () => Promise.resolve(null) },
    // the inbox persists through the ui blob
    workspace: { getUi: () => Promise.resolve({}), setUi: () => {} },
  };
}

function panelProps(cardId: string): IDockviewPanelProps<CardParams> {
  return {
    api: {
      id: `session-${cardId}`,
      title: 'acme',
      isVisible: true,
      location: { type: 'grid' },
      onDidVisibilityChange: () => disposable,
      onDidLocationChange: () => disposable,
      onDidGroupChange: () => disposable,
      onDidActiveChange: () => disposable,
    },
    containerApi: { getPanel: () => undefined, removePanel: off },
    params: { cardId, folder: 'C:\\Projects\\acme', title: 'acme' },
  } as unknown as IDockviewPanelProps<CardParams>;
}

let root: Root | null = null;
let host: HTMLElement;

function menuButton(): HTMLButtonElement {
  const btn = host.querySelector<HTMLButtonElement>(`button[title="${en.grid.menu}"]`);
  if (!btn) throw new Error('the card has no ⋯ menu');
  return btn;
}

const entry = (): HTMLButtonElement | null =>
  host.querySelector<HTMLButtonElement>('[data-testid="card-accept-siblings"]');

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function mountCard(): Promise<void> {
  await act(async () => {
    root!.render(React.createElement(components.sessionCard, panelProps('c1')));
  });
  await act(async () => {
    await Promise.resolve();
  });
}

const openMenu = (): Promise<void> => click(menuButton());

beforeAll(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  await initI18nForTests();
  installBridge();
  registerBuiltinContributions(rendererRegistry);
  const gridHost = document.createElement('div');
  document.body.appendChild(gridHost);
  const gridRoot = createRoot(gridHost);
  await act(async () => {
    gridRoot.render(<SessionGrid colorScheme="dark" seedPanels={0} onCardsChanged={() => {}} />);
  });
  await act(async () => gridRoot.unmount());
  gridHost.remove();
  expect(typeof components.sessionCard).toBe('function');
});

beforeEach(async () => {
  resetInboxCacheForTests();
  stored = false;
  refuseWrites = false;
  readThrows = false;
  writeThrows = false;
  installBridge();
  await loadUiState();
  sessionStore.setSessions([]);
  sessionStore.initPresentation(new Map());
  sessionStore.forgetCardLiveIds('c1');
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root!.unmount());
  host.remove();
  root = null;
});

describe('the entry', () => {
  it('is OFF for a card main says is off, and reads by CARD id', async () => {
    await mountCard();
    await openMenu();
    expect(entry()?.getAttribute('aria-pressed')).toBe('false');
    expect(entry()?.textContent).toContain(en.grid.menuAcceptFromSiblings);
    expect(reads).toContain('c1');
  });

  it('shows ON for a card main already holds on — a pipeline survives a restart', async () => {
    stored = true;
    await mountCard();
    await openMenu();
    expect(entry()?.getAttribute('aria-pressed')).toBe('true');
  });

  it('a click turns it on, through main, for this card', async () => {
    await mountCard();
    await openMenu();
    await click(entry()!);
    expect(writes).toEqual([['c1', true]]);
    expect(entry()?.getAttribute('aria-pressed')).toBe('true');
  });

  it('a REFUSED write reverts to what main holds — the tick never lies about the gate', async () => {
    refuseWrites = true;
    await mountCard();
    await openMenu();
    await click(entry()!);
    expect(writes).toEqual([['c1', true]]);
    expect(entry()?.getAttribute('aria-pressed')).toBe('false');
  });

  it('a write that THROWS shows OFF — which is also what main assumes', async () => {
    writeThrows = true;
    await mountCard();
    await openMenu();
    await click(entry()!);
    expect(entry()?.getAttribute('aria-pressed')).toBe('false');
  });

  it('a read that THROWS shows OFF rather than throwing out of the card', async () => {
    readThrows = true;
    stored = true;
    await mountCard();
    await openMenu();
    expect(entry()?.getAttribute('aria-pressed')).toBe('false');
  });

  it('its hint quotes the loop breaker’s REAL numbers, from the constant main enforces', async () => {
    await mountCard();
    await openMenu();
    const title = entry()?.getAttribute('title') ?? '';
    expect(title).toContain(`at most ${AUTO_ACCEPT_LIMIT} in ${AUTO_ACCEPT_WINDOW_MS / 60_000} minutes`);
    expect(title).toMatch(/Direct mode only/);
    expect(title).toMatch(/Off for every session until you turn it on/);
  });

  it('the Session tab COUNTS waiting messages — without making the card count as shown (#765 review)', async () => {
    // FeedView is mocked here, so NO composer is mounted: exactly the state
    // of a card sitting on its Terminal tab. The badge must appear, and the
    // sender must still be told the conversation is not on screen — the
    // badge's subscription is an observer, not a "shown" one.
    await mountCard();
    const tab = host.querySelector<HTMLElement>('[data-vtab="feed"]')!;
    expect(tab.textContent).toBe(en.grid.viewSession);
    let ack: ReturnType<typeof receiveSiblingMessage> = null;
    await act(async () => {
      ack = receiveSiblingMessage({
        deliveryId: 'd-badge',
        cardId: 'c1',
        from: { id: 'live-a', name: 'Alpha' },
        text: 'waiting',
        at: 'T',
      });
    });
    expect(ack).toEqual({ placed: true, shown: false });
    expect(tab.textContent).toBe(`${en.grid.viewSession}1`);
    await act(async () => removeHeldMessages('c1', ['d-badge']));
    expect(tab.textContent).toBe(en.grid.viewSession);
  });

  it('a bridge without the API draws no entry, and the card still mounts (#444’s lesson)', async () => {
    installBridge(false);
    await mountCard();
    await openMenu();
    expect(entry()).toBeNull();
    expect(menuButton()).toBeTruthy();
  });
});
