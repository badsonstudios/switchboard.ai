// @vitest-environment jsdom
// The card's context chip as a CONTROL (#851), not only a drag handle.
//
// #799 shipped it as a `<span draggable>`: dragging was the only way to start
// §5.5's hand-off. What must hold now is that it is a real button that still
// drags, that pressing it opens the "Hand this session's context to…" picker
// over THIS card, that the palette's route opens the same picker, and that a
// pick records the request a drop would have made — this session's LIVE id,
// addressed to the chosen card.
//
// The dockview wall is climbed exactly as `SessionGrid.sound.test.tsx` does;
// see `SessionGrid.transport.test.tsx` for why the stub is the honest way in.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { initI18nForTests } from '../i18n/test-i18n';
import { sessionStore } from '../store/session-store';
import { registerBuiltinContributions } from '../bootstrap';
import { rendererRegistry } from '../extensibility/registry-instance';
import {
  handoffPickerCard,
  openHandoffPicker,
  pendingHandoff,
  requestHandoff,
  resetHandoffForTests,
} from '../lib/context-handoff';
import { CONTEXT_DND_TYPE } from '../../../shared/context-drop';
import { DEFAULT_PANEL_ID } from '../extensibility/contributions';
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

function installBridge(): void {
  (window as unknown as { switchboard: unknown }).switchboard = {
    sessions: {
      create: () =>
        Promise.resolve({
          id: 'live-1',
          // `langBadge` is LEGACY (#1433): a record restored from an old
          // workspace still carries it, and the header must not draw it
          identity: { accentColor: 'var(--faint)', langBadge: 'TS' },
          autonomy: 'ask',
          status: 'idle',
          transport: 'pty',
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
      // which model the footer shows (#746) — push plus pull-on-mount
      currentModel: () => Promise.resolve(null),
      onModel: () => off,
      onStatus: () => off,
      onPermissionRequest: () => off,
      onPermissionResolved: () => off,
    },
    transcripts: { binding: () => Promise.resolve(null) },
    git: { status: () => Promise.resolve(null) },
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
      // the card subscribes to this too, for #555's `dockEpoch` — dockview
      // reattaches a panel's DOM when its group is activated, and the feed
      // cannot see that happen to it
      onDidActiveChange: () => disposable,
    },
    containerApi: { getPanel: () => undefined, removePanel: off },
    params: { cardId, folder: 'C:\\Projects\\acme', title: 'acme' },
  } as unknown as IDockviewPanelProps<CardParams>;
}

let root: Root | null = null;
let host: HTMLElement;

const chip = (): HTMLElement | null => host.querySelector('[data-testid="card-context-chip"]');
const picker = (): HTMLElement | null => host.querySelector('[data-testid="context-handoff-picker"]');

async function mountCard(): Promise<void> {
  await act(async () => {
    root!.render(React.createElement(components.sessionCard, panelProps('c1')));
  });
  // the live session arrives off `sessions.create`, and the chip with it
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

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

beforeEach(() => {
  installBridge();
  resetHandoffForTests();
  sessionStore.setSessions([
    { id: 'c0', title: 'zeta', folder: 'C:/Projects/zeta', liveId: 'live-0', status: 'idle' },
    { id: 'c1', title: 'acme', folder: 'C:/Projects/acme', liveId: 'live-1', status: 'idle' },
    // suspended: no composer to land on, so never offered
    { id: 'c9', title: 'asleep', folder: 'C:/Projects/asleep', status: 'suspended' },
    { id: 'c2', title: 'beta', folder: 'C:/Projects/beta', liveId: 'live-2', status: 'working' },
  ]);
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
  sessionStore.setSessions([]);
});

describe('the context chip (#851)', () => {
  it('is a real button — and still a drag handle', async () => {
    await mountCard();
    expect(chip()?.tagName).toBe('BUTTON');
    expect(chip()?.getAttribute('type')).toBe('button');
    expect(chip()?.getAttribute('draggable')).toBe('true');
    expect(chip()?.getAttribute('aria-haspopup')).toBe('dialog');
    expect(chip()?.getAttribute('aria-label')).toBeTruthy();
  });

  it('a drag still carries this session’s LIVE id, as a copy', async () => {
    await mountCard();
    const data: Record<string, string> = {};
    const dt = { setData: (t: string, v: string) => (data[t] = v), effectAllowed: 'all' };
    const ev = new Event('dragstart', { bubbles: true });
    Object.defineProperty(ev, 'dataTransfer', { value: dt });
    await act(async () => {
      chip()!.dispatchEvent(ev);
    });
    expect(data[CONTEXT_DND_TYPE]).toBe('live-1');
    expect(dt.effectAllowed).toBe('copy');
  });

  it('pressing it opens the picker over THIS card, offering every other RUNNING session in rail order', async () => {
    await mountCard();
    expect(picker()).toBeNull();
    await act(async () => {
      chip()!.click(); // Enter and Space on a button arrive as this click
    });
    expect(handoffPickerCard()).toBe('c1');
    const targets = [...picker()!.querySelectorAll('[data-handoff-target]')].map((b) =>
      b.getAttribute('data-handoff-target')
    );
    expect(targets).toEqual(['c0', 'c2']);
  });

  it('the palette’s route opens the SAME picker on this card', async () => {
    await mountCard();
    await act(async () => openHandoffPicker('c1'));
    expect(picker()).not.toBeNull();
  });

  it('…and only on the card it names', async () => {
    await mountCard();
    await act(async () => openHandoffPicker('c2'));
    expect(picker()).toBeNull();
  });

  it('a pick records what a drop would have carried, addressed to the chosen card, and closes', async () => {
    await mountCard();
    await act(async () => {
      chip()!.click();
    });
    await act(async () => {
      (picker()!.querySelector('[data-handoff-target="c2"]') as HTMLElement).click();
    });
    expect(pendingHandoff()).toMatchObject({ target: 'c2', fromLiveId: 'live-1' });
    expect(picker()).toBeNull();
  });
});

describe('the live header (#1433)', () => {
  it('draws no project-type badge, even for a record that still carries one', async () => {
    await mountCard();
    const header = host.querySelector<HTMLElement>('[data-testid="card-header"]');
    expect(header).not.toBeNull();
    expect(host.querySelector('[data-testid="identity-badge"]')).toBeNull();
    expect(header!.textContent).not.toContain('TS');
  });
});

describe('the grid brings a picked target’s prompt box forward (#851)', () => {
  it('switches the target back to its Session view, so a composer exists to answer', async () => {
    // A card on its Changes tab has no composer at all; a drop could never
    // land there, but a pick can name it.
    const gridHost = document.createElement('div');
    document.body.appendChild(gridHost);
    const gridRoot = createRoot(gridHost);
    await act(async () => {
      gridRoot.render(<SessionGrid colorScheme="dark" seedPanels={0} onCardsChanged={() => {}} />);
    });
    sessionStore.setPresentation('c2', { view: 'changes' });
    await act(async () => requestHandoff('c2', 'live-1'));
    expect(sessionStore.getPresentation('c2').view).toBe(DEFAULT_PANEL_ID);
    // the request is still there for the composer that view switch mounts
    expect(pendingHandoff()).toMatchObject({ target: 'c2', fromLiveId: 'live-1' });
    await act(async () => gridRoot.unmount());
    gridHost.remove();
  });

  it('leaves a target already on its Session view alone, and ignores everything else it hears', async () => {
    const gridHost = document.createElement('div');
    document.body.appendChild(gridHost);
    const gridRoot = createRoot(gridHost);
    await act(async () => {
      gridRoot.render(<SessionGrid colorScheme="dark" seedPanels={0} onCardsChanged={() => {}} />);
    });
    const spy = vi.spyOn(sessionStore, 'setPresentation');
    await act(async () => requestHandoff('c2', 'live-1'));
    await act(async () => openHandoffPicker('c1')); // a notify with no new request
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    await act(async () => gridRoot.unmount());
    gridHost.remove();
  });
});
