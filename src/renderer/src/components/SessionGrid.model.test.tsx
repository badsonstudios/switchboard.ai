// @vitest-environment jsdom
// Which model the card's FOOTER shows (#746).
//
// THE BUG THIS PINS: the footer used to read `model` off the usage snapshot —
// the transcript watcher's last-seen `message.model` on an assistant line,
// which exists for COST estimation. That field cannot move until the session
// next replies, so switching model left the footer showing the old name for a
// whole turn, and a control whose effect is invisible reads as a control that
// did nothing. The picker's own tick moved immediately, from a different
// source, which is what made it two sources of truth for one question with the
// user-visible one stale.
//
// So these tests assert the two halves that were missing, and one that must NOT
// come back: the push moves the footer, the pull covers a card that mounts
// mid-session, and a usage snapshot may no longer move it at all.
//
// The card is reached the same way `SessionGrid.transport.test.tsx` reaches it
// — DockviewReact stubbed, the real grid rendered once to capture the
// `components` map — and the reasoning for that is documented there. What is
// different here is the FeedView stub: it renders its `model` prop into the
// DOM, because the prop IS the surface under test. What FeedView then draws
// with it (the mono chip beside the autonomy chip) is unchanged by this item.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { initI18nForTests } from '../i18n/test-i18n';
import { sessionStore } from '../store/session-store';
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
// The stub RENDERS the prop — see the header.
vi.mock('./FeedView', () => ({
  FeedView: (p: { model?: string }): React.JSX.Element => (
    <div data-testid="feed-view" data-feed-model={p.model ?? ''} />
  ),
}));

const off = (): void => {};
const disposable = { dispose: off };

/** what `sessions.currentModel` answers — the pull a mounting card makes */
let pulled: string | null;
/** the live push, so a test can deliver one when it chooses */
let pushModel: (e: { sessionId: string; model: string }) => void;
/** the usage push, which must NOT be able to move the footer any more */
let pushUsage: (snap: unknown) => void;

function installBridge(): void {
  pulled = null;
  pushModel = () => {};
  pushUsage = () => {};
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
      setAutonomy: () => Promise.resolve(),
      setTaskLabel: () => Promise.resolve(),
      decidePermission: () => Promise.resolve(),
      allowAllSession: () => Promise.resolve(),
      closeCard: () => Promise.resolve(),
      dropLive: () => Promise.resolve(),
      pendingPermissions: () => Promise.resolve([]),
      onExited: () => off,
      onUsage: (cb: (snap: unknown) => void) => {
        pushUsage = cb;
        return off;
      },
      currentModel: () => Promise.resolve(pulled),
      onModel: (cb: (e: { sessionId: string; model: string }) => void) => {
        pushModel = cb;
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

/** what the footer would show */
const footerModel = (): string | undefined =>
  host.querySelector<HTMLElement>('[data-feed-model]')?.dataset.feedModel;

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

describe('the footer follows the model the PICKER reports (#746)', () => {
  it('moves on a switch, without waiting for the session to reply', async () => {
    // The whole item. `sessions:model` is pushed the moment `set_model`
    // succeeds — no turn, no assistant line, no usage snapshot involved.
    await mountCard();
    expect(footerModel()).toBe('');

    await act(async () => {
      pushModel({ sessionId: 'live-1', model: 'haiku' });
    });
    expect(footerModel()).toBe('haiku');
  });

  it('shows the model of a session that was ALREADY running when the card mounted', async () => {
    // The push only fires on a CHANGE, and this session announced its model
    // turns ago. Without the pull the footer would sit empty until the model
    // next changed — which for most sessions is never.
    pulled = 'claude-opus-5';
    await mountCard();
    expect(footerModel()).toBe('claude-opus-5');
  });

  it('a usage snapshot cannot overwrite a model the picker has reported — that was the bug', async () => {
    // `usage.model` is the transcript's COST field, which only moves when the
    // session replies. It is still the fallback (see the test below), but once
    // the picker's source has an answer it must win — a later snapshot carrying
    // the pre-switch model is precisely what made the footer stale.
    await mountCard();
    await act(async () => {
      pushModel({ sessionId: 'live-1', model: 'haiku' });
    });
    await act(async () => {
      pushUsage({
        sessionId: 'live-1',
        usage: { input: 1, output: 1, cacheRead: 0, cacheCreate: 0 },
        model: 'claude-opus-5-STALE',
      });
    });
    expect(footerModel()).toBe('haiku');
  });

  it('falls back to the transcript for a session the picker knows nothing about', async () => {
    // NOT a nicety — it is a whole transport. `StreamModel` is fed only from
    // stream messages, so a Terminal-mode session never produces one, and
    // neither does a stream session before its first `system:init` (which
    // includes a resumed card at the moment it appears). Without this the chip
    // would simply disappear for all of them, which is worse than the staleness
    // this item set out to fix.
    await mountCard();
    await act(async () => {
      pushUsage({
        sessionId: 'live-1',
        usage: { input: 1, output: 1, cacheRead: 0, cacheCreate: 0 },
        model: 'claude-opus-5',
      });
    });
    expect(footerModel()).toBe('claude-opus-5');
  });

  it('ignores a push aimed at a different session', async () => {
    await mountCard();
    await act(async () => {
      pushModel({ sessionId: 'someone-else', model: 'sonnet' });
    });
    expect(footerModel()).toBe('');
  });

  it('a push that lands before the pull answers is not overwritten by it', async () => {
    // Both are in flight on mount and the pull is the SLOWER of the two — it is
    // a round trip, the push is an event already on its way. The pull carries
    // the answer from before the change, so letting it land last would put the
    // footer back on the old model and leave it there.
    let answer: (m: string | null) => void = () => {};
    (
      window as unknown as {
        switchboard: { sessions: { currentModel: () => Promise<string | null> } };
      }
    ).switchboard.sessions.currentModel = () =>
      new Promise<string | null>((r) => {
        answer = r;
      });

    await mountCard();
    await act(async () => {
      pushModel({ sessionId: 'live-1', model: 'haiku' });
    });
    expect(footerModel()).toBe('haiku');

    await act(async () => {
      answer('claude-opus-5'); // the stale pull, landing late
      await Promise.resolve();
    });
    expect(footerModel()).toBe('haiku');
  });
});
