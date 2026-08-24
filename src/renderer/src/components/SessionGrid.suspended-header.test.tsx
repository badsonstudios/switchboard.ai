// @vitest-environment jsdom
// The SUSPENDED card's header (#216, §5.8 + §5.11).
//
// A restored-not-yet-resumed card used to render its overlay and nothing else,
// so §5.8's "double-click a session header toggles maximize" had no target on
// it — the binding and the palette command worked, the gesture did not, and the
// manual had to write the exception down. The regression this file guards is
// that exception coming back: it is invisible in a screenshot of a suspended
// card, because a header that is there and a header that is there but dead look
// identical.
//
// What it pins, in order of what a user would notice:
//   • the header EXISTS on a suspended card, with the card's identity on it;
//   • double-clicking it maximizes — and again puts the layout back;
//   • it carries none of the controls that act on a running session.
//
// The dockview wall is climbed exactly as `SessionGrid.sound.test.tsx` does;
// see its header for why the stub is the honest way in.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { initI18nForTests } from '../i18n/test-i18n';
import en from '../../../shared/i18n/locales/en.json';
import { sessionStore } from '../store/session-store';
import { DEFAULT_LAYOUT } from '../lib/layout-mode';
import { registerBuiltinContributions } from '../bootstrap';
import { rendererRegistry } from '../extensibility/registry-instance';
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

/** how many times the card asked main to start a session */
let created: number;

function installBridge(): void {
  created = 0;
  (window as unknown as { switchboard: unknown }).switchboard = {
    sessions: {
      create: () => {
        created += 1;
        return Promise.resolve({
          id: 'live-1',
          identity: { accentColor: 'var(--accent-teal)', langBadge: 'ts' },
          autonomy: 'ask',
          status: 'idle',
          transport: 'pty',
        });
      },
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
      onStatus: () => off,
      onTaskLabel: () => off,
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
      onDidActiveChange: () => disposable,
    },
    // Truthy, because `toggleMaximizeCard` refuses a null api — and inert,
    // because the sweep it then asks for is fenced behind `gridReady`, which
    // only a real dockview `onReady` sets. The STORE write is the assertion
    // below: it is what survives the card being unmounted and re-mounted, and
    // it is what the e2e test then watches move real panels.
    containerApi: { getPanel: () => undefined, removePanel: off },
    params: { cardId, folder: 'C:\\Projects\\acme', title: 'acme' },
  } as unknown as IDockviewPanelProps<CardParams>;
}

let root: Root | null = null;
let host: HTMLElement;

const header = (): HTMLElement | null => host.querySelector('[data-testid="card-header"]');

async function mountCard(): Promise<void> {
  await act(async () => {
    root!.render(React.createElement(components.sessionCard, panelProps('c1')));
  });
}

async function dblclick(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
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
  sessionStore.setSessions([
    { id: 'c1', title: 'acme', accent: 'var(--accent-teal)', badge: 'ts', status: 'idle' },
    // a second card, so a maximize has something to be a maximize OVER
    { id: 'c2', title: 'other', status: 'idle' },
  ]);
  sessionStore.initPresentation(new Map());
  sessionStore.forgetCardLiveIds('c1');
  sessionStore.setLayout(DEFAULT_LAYOUT);
  // the state under test: restored with the app, not resumed
  sessionStore.setPresentation('c1', { suspended: true });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root!.unmount());
  host.remove();
  root = null;
  sessionStore.setLayout(DEFAULT_LAYOUT);
});

describe('a suspended card still has a header', () => {
  it('renders one, and does NOT start a session to get it', async () => {
    await mountCard();
    // the overlay is the suspended state, and it is still the body of the card
    expect(host.querySelector('[data-testid="card-overlay"]')?.textContent).toContain(
      en.grid.suspended
    );
    expect(header()).not.toBeNull();
    // the whole point of the state: nothing was resumed to draw this
    expect(created).toBe(0);
  });

  it('carries the card identity — name, badge and accent (§5.11)', async () => {
    await mountCard();
    expect(host.querySelector('[data-testid="card-header-name"]')?.textContent).toBe('acme');
    expect(host.querySelector('[data-testid="identity-badge"]')?.textContent).toBe('ts');
    // the accent is the card record's, not a grey fallback — the same field the
    // card TAB and the live header read
    expect(header()!.style.borderInlineStart).toContain('var(--accent-teal)');
  });

  it('falls back to the neutral accent before the card list has landed', async () => {
    // the frame a card restored at boot renders in: it is suspended from the ui
    // blob, and the `sessions:cards` push that carries its accent and badge has
    // not arrived. A header that throws or draws `undefined` here is a card the
    // user watches fail to appear.
    sessionStore.setSessions([]);
    await mountCard();
    expect(header()).not.toBeNull();
    expect(header()!.style.borderInlineStart).toContain('var(--faint)');
    expect(host.querySelector('[data-testid="identity-badge"]')).toBeNull();
  });

  it('says suspended in the same word the rail and the lamps use', async () => {
    await mountCard();
    const pill = host.querySelector('.status-pill');
    expect(pill?.textContent).toBe(en.status.suspended);
    // ...on the ramp position `presentStatus` folds it into — 'suspended' is a
    // word, not a seventh colour (rail-view: "'starting' and 'suspended' fold
    // in"). Asserted so a hand-rolled hue here would fail rather than paint a
    // status the contrast tests never measured (#221).
    expect(pill?.getAttribute('data-status')).toBe('idle');
  });

  it('offers no control that would act on a session that is not running', async () => {
    await mountCard();
    // Resume and Close live in the overlay and are unaffected; the header's own
    // buttons (collapse, pop out, ⋯) are the ones that must not be there.
    expect(header()!.querySelectorAll('button')).toHaveLength(0);
  });
});

describe('the maximize gesture (§5.8), which is why the header is here', () => {
  it('double-clicking the header maximizes this card', async () => {
    await mountCard();
    await dblclick(header()!);
    expect(sessionStore.getLayout().maximized).toBe('c1');
  });

  it('double-clicking again puts the prior layout back', async () => {
    await mountCard();
    await dblclick(header()!);
    await dblclick(header()!);
    expect(sessionStore.getLayout().maximized).toBeNull();
  });

  it('takes the maximize with it when the card is re-mounted', async () => {
    // a suspended card is unmounted every time the workspace hides it, so the
    // gesture's effect has to live in the store rather than in the panel
    await mountCard();
    await dblclick(header()!);
    await act(async () => root!.unmount());
    root = createRoot(host);
    await mountCard();
    expect(sessionStore.getLayout().maximized).toBe('c1');
    await dblclick(header()!);
    expect(sessionStore.getLayout().maximized).toBeNull();
    // ...and none of it woke the session up. This is the ticket's sharpest
    // promise and the remount is where an accidental resume would come from:
    // rearranging the workspace is a request about the WORKSPACE.
    expect(created).toBe(0);
  });
});
