// @vitest-environment jsdom
// #1072 — the card follows the CLI when the CLI changes mode itself (the header
// badge that used to show it is gone, #1490; the composer chip shows it now).
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
  FeedView: (p: { model?: string; liveAutonomy?: string }): React.JSX.Element => (
    <div data-testid="feed-view" data-feed-model={p.model ?? ''} data-live-autonomy={p.liveAutonomy} />
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

// #1490 moved these off the card header: the header badge is gone, and the
// chip under the prompt box is the one place a mode is shown. The card's half
// is unchanged — read the CLI's announcement (push plus pull) and hand it to
// the composer as `liveAutonomy` — so that is what is checked here, through the
// stub. The chip drawing it ("ask now · plan at next start") is the composer's,
// and `e2e/stream-approval.spec.ts` drives it against the real app.
describe('the card hands the composer what the session SAYS it is in (#1072, #1490)', () => {
  const liveMode = (): string | undefined =>
    host.querySelector<HTMLElement>('[data-testid="feed-view"]')?.dataset.liveAutonomy;

  it('hands nothing over until the session announces a mode', async () => {
    await mountCard();
    expect(host.querySelector('[data-testid="feed-view"]')).not.toBeNull();
    expect(liveMode()).toBeUndefined();
  });

  it('hands over "ask" the moment the CLI says it has left plan mode — the report', async () => {
    await mountCard();
    await act(async () => {
      pushMode({ sessionId: 'live-1', mode: 'ask' });
    });
    expect(liveMode()).toBe('ask');
  });

  it('shows the mode of a session that had ALREADY left plan mode when the card mounted', async () => {
    // The push fires once, on the change. A card opened afterwards missed it.
    pulledMode = 'ask';
    await mountCard();
    expect(liveMode()).toBe('ask');
  });

  it('follows a move INTO a mode too', async () => {
    startedAt = 'ask';
    await mountCard();
    expect(liveMode()).toBeUndefined();
    await act(async () => {
      pushMode({ sessionId: 'live-1', mode: 'auto-edit' });
    });
    expect(liveMode()).toBe('auto-edit');
  });

  it('ignores another session`s announcement', async () => {
    await mountCard();
    await act(async () => {
      pushMode({ sessionId: 'someone-else', mode: 'ask' });
    });
    expect(liveMode()).toBeUndefined();
  });

  it('ignores a mode it has no name for, rather than drawing it', async () => {
    await mountCard();
    await act(async () => {
      pushMode({ sessionId: 'live-1', mode: 'dontAsk' });
    });
    expect(liveMode()).toBeUndefined();
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

// The chip under the prompt box says all of this instead, allow-all included
// (`autonomy-tooltips.test.tsx` covers its label and tooltip).
describe('no mode badge in the card header (#1490)', () => {
  const badgeEl = (): HTMLElement | null => host.querySelector<HTMLElement>('[data-testid="card-mode-badge"]');

  it('shows none at any mode', async () => {
    startedAt = 'full-auto';
    await mountCard();
    expect(badgeEl()).toBeNull();
    // ...nor once the CLI moves it somewhere else
    await act(async () => {
      pushMode({ sessionId: 'live-1', mode: 'auto-edit' });
    });
    expect(badgeEl()).toBeNull();
  });

  it('shows none with allow-all on, where it used to say so in warning ink (#1434)', async () => {
    startedAt = 'ask';
    grants = { allowAll: true, allowAllSince: Date.UTC(2026, 9, 23, 14, 2), files: [] };
    await mountCard();
    expect(badgeEl()).toBeNull();
    expect(host.textContent).not.toContain('allow all');
  });

  it('a grant pushed while the card is up does not bring one back', async () => {
    startedAt = 'ask';
    await mountCard();
    await act(async () => {
      pushGrants({ sessionId: 'live-1', allowAll: true, allowAllSince: 1, files: [] });
    });
    expect(badgeEl()).toBeNull();
    expect(host.textContent).not.toContain('allow all');
  });
});
