// @vitest-environment jsdom
// The card's "Fork into a new session" entry (P2-E11-12, §5.5 Level 3).
//
// #801's done-when is that the surface is **absent, not merely disabled**, when
// the experiment is off — so every test here asks whether the element EXISTS,
// never whether it is enabled. An entry that rendered greyed would pass a
// "cannot be clicked" test and still fail the requirement.
//
// The second gate is the one that is easy to forget: the entry also stays absent
// when there is nothing to fork FROM. The CLI announces no conversation id until
// a session has one, so a card that has taken no turn would offer a control that
// fails at the far end for a reason the user could not have guessed — the same
// argument the context chip makes about suspended cards.
//
// The dockview wall is climbed exactly as `SessionGrid.siblings.test.tsx` does.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { initI18nForTests } from '../i18n/test-i18n';
import en from '../../../shared/i18n/locales/en.json';
import { sessionStore } from '../store/session-store';
import { registerBuiltinContributions } from '../bootstrap';
import { rendererRegistry } from '../extensibility/registry-instance';
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

/** what main says about the experiment */
let forkFlag = false;
/** whether the flag read is even offered (an older//partial bridge) */
let offerSettingsApi = true;
/** whether the read blows up */
let readThrows = false;
/** the conversation id the spawned session reports — undefined = none yet */
let nativeSessionId: string | undefined = 'conv-a';

function installBridge(): void {
  (window as unknown as { switchboard: unknown }).switchboard = {
    sessions: {
      create: () =>
        Promise.resolve({
          id: 'live-1',
          identity: { accentColor: 'var(--faint)', langBadge: 'ts' },
          autonomy: 'ask',
          status: 'idle',
          transport: 'stream',
          // §5.5 Level 3: what a fork would be forked FROM.
          nativeSessionId,
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
      // Present so the "accept messages from siblings" entry RENDERS. That
      // entry is this file's proof that the ⋯ menu actually opened — without
      // it, "the fork entry is absent" would pass just as happily on a menu
      // that never drew at all, which is the vacuous-guard trap #760 records.
      acceptFromSiblings: () => Promise.resolve(false),
      setAcceptFromSiblings: () => Promise.resolve(false),
    },
    settings: offerSettingsApi
      ? {
          getExperimentalFork: () =>
            readThrows ? Promise.reject(new Error('no')) : Promise.resolve(forkFlag),
        }
      : undefined,
    transcripts: { binding: () => Promise.resolve(null) },
    git: { status: () => Promise.resolve(null) },
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
  host.querySelector<HTMLButtonElement>('[data-testid="card-fork"]');

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
  forkFlag = false;
  offerSettingsApi = true;
  readThrows = false;
  nativeSessionId = 'conv-a';
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

describe('the fork entry is ABSENT unless the experiment is on', () => {
  it('is not in the menu at all when the flag is OFF — absent, not disabled', async () => {
    // The done-when, stated as the test: a greyed entry would advertise a
    // feature the user cannot evaluate and invite a support question answered
    // with "yes, but not really".
    await mountCard();
    await openMenu();
    expect(entry()).toBeNull();
    // ...and the menu really did open, so this is not a vacuous pass — the
    // failure mode this guards is a selector that matches nothing because the
    // menu never rendered.
    expect(host.querySelector('[data-testid="card-accept-siblings"]')).not.toBeNull();
  });

  it('appears when the flag is ON', async () => {
    forkFlag = true;
    await mountCard();
    await openMenu();
    expect(entry()).not.toBeNull();
    expect(entry()?.textContent).toContain(en.grid.menuFork);
  });

  it('stays absent when there is no conversation to fork FROM', async () => {
    // A session that has taken no turn has no id yet. The control would
    // otherwise look ready and fail at the far end.
    forkFlag = true;
    nativeSessionId = undefined;
    await mountCard();
    await openMenu();
    expect(entry()).toBeNull();
  });

  it('stays absent when the flag READ throws — fail-safe in the same direction as main', async () => {
    // An unreadable setting must never leave the bar advertising a gesture main
    // will refuse. Off is also what main assumes.
    forkFlag = true;
    readThrows = true;
    await mountCard();
    await openMenu();
    expect(entry()).toBeNull();
  });

  it('stays absent when the bridge offers no settings API at all', async () => {
    // An older preload, or a window wired without the settings channel. The
    // renderer must degrade to "no experiment" rather than throwing on a
    // missing function.
    forkFlag = true;
    offerSettingsApi = false;
    // ⚠️ RE-INSTALL, and this is the whole reason the test is written this way.
    // `forkFlag` and `readThrows` are read when the stub is CALLED, so flipping
    // them here is enough. `offerSettingsApi` decides the SHAPE of the bridge
    // object and is read when it is BUILT — `beforeEach` already built one with
    // the API present, so without this line the test asserts nothing it claims
    // to and passes only because the flag read happened to be pending.
    installBridge();
    await mountCard();
    await openMenu();
    expect(entry()).toBeNull();
  });

  it('says what it will do, rather than only what it is', async () => {
    // A COMMAND, not a toggle — it makes a new card — so it carries no
    // `aria-pressed`, and its hint has to carry the consequence.
    forkFlag = true;
    await mountCard();
    await openMenu();
    expect(entry()?.getAttribute('aria-pressed')).toBeNull();
    expect(entry()?.getAttribute('title')).toBe(en.grid.menuForkHint);
  });
});
