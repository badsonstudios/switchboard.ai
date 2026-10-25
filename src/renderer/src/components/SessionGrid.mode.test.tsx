// @vitest-environment jsdom
// #1072 — the card's mode badge follows the CLI when the CLI changes mode itself.
//
// Approve a plan and Claude Code leaves plan mode, announcing it in a `status`
// message. Nothing read it: the badge is drawn from the mode the session was
// STARTED at, and went on saying "plan" over a session that had begun asking
// about each write, as an ask session does.
//
// The scaffolding is `SessionGrid.model.test.tsx`'s, for the same reason that
// test has it: the badge lives in the card header, and the card only exists
// inside the grid's registered component.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { initI18nForTests } from '../i18n/test-i18n';
import { sessionStore } from '../store/session-store';
import { registerBuiltinContributions } from '../bootstrap';
import { rendererRegistry } from '../extensibility/registry-instance';
import type { IDockviewPanelProps } from 'dockview-react';
import { SessionGrid, type CardParams } from './SessionGrid';
import { uiSet } from '../lib/ui-state';

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
// The stub RENDERS the prop — see the header.
vi.mock('./FeedView', () => ({
  FeedView: (p: { model?: string }): React.JSX.Element => (
    <div data-testid="feed-view" data-feed-model={p.model ?? ''} />
  ),
}));

const off = (): void => {};
const disposable = { dispose: off };

/** the mode the session is STARTED at — what `live.autonomy` carries */
let startedAt: string;
/** what `sessions.currentMode` answers — the pull a mounting card makes */
let pulledMode: string | null;
/** the live push: the CLI announcing a mode change */
let pushMode: (e: { sessionId: string; mode: string }) => void;
/** what `sessions.create` was asked for (#1434: the autonomy a NEW card starts at) */
let createdWith: { autonomy?: string } | null;
/** main's standing grants for live-1, and the push that changes them (#1434) */
let grants: { allowAll: boolean; allowAllSince?: number; files: string[] };
let pushGrants: (g: { sessionId: string; allowAll: boolean; allowAllSince?: number; files: string[] }) => void;
let revoked: unknown[][];

function installBridge(): void {
  startedAt = 'plan';
  pulledMode = null;
  pushMode = () => {};
  createdWith = null;
  grants = { allowAll: false, files: [] };
  pushGrants = () => {};
  revoked = [];
  (window as unknown as { switchboard: unknown }).switchboard = {
    sessions: {
      create: (opts: { autonomy?: string }) => {
        createdWith = opts;
        return Promise.resolve({
          id: 'live-1',
          identity: { accentColor: 'var(--faint)' },
          autonomy: startedAt,
          status: 'idle',
          transport: 'stream',
        });
      },
      standingGrants: () => Promise.resolve(grants),
      onStandingGrants: (cb: typeof pushGrants) => {
        pushGrants = cb;
        return off;
      },
      revokeStandingGrant: (...args: unknown[]) => {
        revoked.push(args);
        return Promise.resolve(true);
      },
      setAutonomy: () => Promise.resolve(),
      setTaskLabel: () => Promise.resolve(),
      decidePermission: () => Promise.resolve(),
      allowAllSession: () => Promise.resolve(),
      closeCard: () => Promise.resolve(),
      dropLive: () => Promise.resolve(),
      pendingPermissions: () => Promise.resolve([]),
      onExited: () => off,
      onUsage: () => off,
      currentModel: () => Promise.resolve(null),
      onModel: () => off,
      currentMode: () => Promise.resolve(pulledMode),
      onMode: (cb: (e: { sessionId: string; mode: string }) => void) => {
        pushMode = cb;
        return off;
      },
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
      onDidActiveChange: () => disposable,
    },
    containerApi: { getPanel: () => undefined, removePanel: off },
    params: { cardId, folder: 'C:\\Projects\\acme', title: 'acme' },
  } as unknown as IDockviewPanelProps<CardParams>;
}

let root: Root | null = null;
let host: HTMLElement;

async function mountCard(): Promise<void> {
  await act(async () => {
    root!.render(React.createElement(components.sessionCard, panelProps('c1')));
  });
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

describe('the mode badge follows what the session SAYS it is in (#1072)', () => {
  const badge = (): string | null =>
    host.querySelector<HTMLElement>('[data-testid="card-mode-badge"]')?.textContent ?? null;

  it('starts on the mode the session was started at', async () => {
    await mountCard();
    expect(badge()).toContain('plan');
  });

  it('drops "plan" the moment the CLI says it has left plan mode — the report', async () => {
    await mountCard();
    expect(badge()).toContain('plan');
    await act(async () => {
      pushMode({ sessionId: 'live-1', mode: 'ask' });
    });
    // an ask session shows no badge at all, and now neither does this one
    expect(badge()).toBeNull();
  });

  it('shows the mode of a session that had ALREADY left plan mode when the card mounted', async () => {
    // The push fires once, on the change. A card opened afterwards missed it.
    pulledMode = 'ask';
    await mountCard();
    expect(badge()).toBeNull();
  });

  it('follows a move INTO a mode too', async () => {
    startedAt = 'ask';
    await mountCard();
    expect(badge()).toBeNull();
    await act(async () => {
      pushMode({ sessionId: 'live-1', mode: 'auto-edit' });
    });
    expect(badge()).toContain('auto-edit');
  });

  it('ignores another session`s announcement', async () => {
    await mountCard();
    await act(async () => {
      pushMode({ sessionId: 'someone-else', mode: 'ask' });
    });
    expect(badge()).toContain('plan');
  });

  it('ignores a mode it has no name for, rather than drawing it', async () => {
    await mountCard();
    await act(async () => {
      pushMode({ sessionId: 'live-1', mode: 'dontAsk' });
    });
    expect(badge()).toContain('plan');
  });
});

describe('a NEW card starts at ask, whatever the old title-bar chip stored (#1434)', () => {
  it('sends ask to main even with "plan" left in the ui blob by the removed chip', async () => {
    // the chip wrote `autonomy` to the ui blob; it is left there, read by nothing
    uiSet('autonomy', 'plan');
    try {
      await mountCard();
      expect(createdWith?.autonomy).toBe('ask');
    } finally {
      uiSet('autonomy', undefined);
    }
  });
});

describe('allow-all on the card header (#1434)', () => {
  const badgeEl = (): HTMLElement | null =>
    host.querySelector<HTMLElement>('[data-testid="card-mode-badge"]');

  it('an ask session on allow-all shows the badge, saying so; revoking clears it', async () => {
    startedAt = 'ask';
    grants = { allowAll: true, allowAllSince: Date.UTC(2026, 9, 23, 14, 2), files: [] };
    await mountCard();
    expect(badgeEl()?.textContent).toBe('🛡 ask · allow all');
    expect(badgeEl()?.dataset.allowAll).toBe('true');
    expect(badgeEl()?.title).toContain('until the session restarts');
    // main's push after a revoke — from the chip, the card menu, anywhere
    await act(async () => {
      pushGrants({ sessionId: 'live-1', allowAll: false, files: [] });
    });
    // a plain ask session shows no badge at all
    expect(badgeEl()).toBeNull();
  });

  it('a grant pushed while the card is up turns the badge on', async () => {
    startedAt = 'ask';
    await mountCard();
    expect(badgeEl()).toBeNull();
    await act(async () => {
      pushGrants({ sessionId: 'live-1', allowAll: true, allowAllSince: 1, files: [] });
    });
    expect(badgeEl()?.textContent).toBe('🛡 ask · allow all');
  });
});
