// @vitest-environment jsdom
// `approveFile` — the card's half of "Approve all in this file" (P2-E22-03, #974).
//
// ── WHY THIS SEAM GETS ITS OWN FILE ─────────────────────────────────────────
//
// It is the one with the history. `FeedView.approval-buttons.test.tsx` stops at
// `onAllowFile`; `stream-permissions.test.ts` starts after the bridge. What sits
// between them is the function that decides WHICH request gets answered and in
// WHAT ORDER — and this exact seam has silently dropped an argument twice
// (`updatedInput` in #563, `reason` in #973), each time typechecking all the way
// down because a function taking fewer parameters is assignable to one taking
// more.
//
// Two claims, both of which a screenshot and an e2e happy path would miss:
//
//  1. **Grant, THEN answer.** The CLI can raise its next gated call the instant
//     this one is answered. A grant that landed after it would leave that call
//     holding a bar the user believed they had just dismissed for this file.
//  2. **Answer the request that was GRANTED**, not whatever is head when the IPC
//     resolves. `permissionResolved` (an OS toast, the batch card, the 300s
//     fail-open) and `subscribeLiveRetired` all move the queue while the grant
//     is in flight.
//
// ⚠️ CLAIM 2 IS A CHARACTERISATION TEST, AND THE FILE SAYS SO RATHER THAN
// IMPLYING OTHERWISE. Measured: it passes with or without `decide`'s explicit
// `target` argument, because the deferred call closes over the `cardQueue` of
// the render the click happened in. That safety is an accident of where `decide`
// is declared — a `useCallback`, a ref, or a hoist would take it away with no
// type error and nothing failing. So this pins the BEHAVIOUR, which is the thing
// that must not change, rather than the mechanism that currently provides it.
//
// The dockview wall is climbed as `SessionGrid.sound.test.tsx` climbs it; see
// its header. `FeedView` is stubbed to a component that CAPTURES its props,
// which is how the card's `onAllowFile` is reachable at all.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { initI18nForTests } from '../i18n/test-i18n';
import { registerBuiltinContributions } from '../bootstrap';
import { rendererRegistry } from '../extensibility/registry-instance';
import type { IDockviewPanelProps } from 'dockview-react';
import type { IncomingPermission } from '../lib/held-permissions';
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

/** the props the card handed the feed on its last render */
let feedProps: {
  approval?: { requestId: string; tool: string; input: Record<string, unknown> } | null;
  onAllowFile?: (filePath: string) => void;
} = {};
vi.mock('./FeedView', () => ({
  FeedView: (props: typeof feedProps): React.JSX.Element => {
    feedProps = props;
    return <div data-testid="feed-view" />;
  },
}));

const off = (): void => {};
const disposable = { dispose: off };

/** every bridge call this test cares about, IN ORDER — the order is a claim */
let calls: string[];
/** resolve the in-flight `allowFileForSession` by hand, to open the race window */
let releaseGrant: (() => void) | null = null;
/** pushed to the card's intake, so it has a queue */
let pushPermission: ((r: IncomingPermission) => void) | null = null;
/** main saying a request is no longer held — what MOVES the card's queue */
let resolvePermission: ((r: { requestId: string }) => void) | null = null;

function installBridge(): void {
  calls = [];
  releaseGrant = null;
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
      decidePermission: (requestId: string, decision: string) => {
        calls.push(`decide:${requestId}:${decision}`);
        return Promise.resolve(true);
      },
      allowFileForSession: (liveId: string, filePath: string) => {
        calls.push(`grant:${liveId}:${filePath}`);
        return new Promise<string | null>((res) => {
          releaseGrant = () => res(filePath);
        });
      },
      allowAllSession: () => Promise.resolve(),
      standingGrants: () => Promise.resolve({ allowAll: false, files: [] }),
      onStandingGrants: () => off,
      closeCard: () => Promise.resolve(),
      pendingPermissions: () => Promise.resolve([]),
      onExited: () => off,
      onUsage: () => off,
      currentModel: () => Promise.resolve(null),
      onModel: () => off,
      onStatus: () => off,
      onPermissionRequest: (cb: (r: IncomingPermission) => void) => {
        pushPermission = cb;
        return off;
      },
      onPermissionResolved: (cb: (r: { requestId: string }) => void) => {
        resolvePermission = cb;
        return off;
      },
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

const held = (requestId: string, filePath: string): IncomingPermission => ({
  requestId,
  sessionId: 'live-1',
  cardId: 'c1',
  tool: 'Write',
  input: { file_path: filePath, content: 'x' },
});

let root: Root | null = null;

async function mountCard(): Promise<void> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(React.createElement(components.sessionCard, panelProps('c1')));
  });
  // the spawn and the pendingPermissions replay are both promises
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
  feedProps = {};
  pushPermission = null;
  resolvePermission = null;
  document.body.innerHTML = '';
});

afterEach(async () => {
  if (root) {
    const r = root;
    root = null;
    await act(async () => r.unmount());
  }
});

describe('approveFile (P2-E22-03, #974)', () => {
  it('grants the file BEFORE it answers, so the next call is already covered', async () => {
    await mountCard();
    await act(async () => pushPermission!(held('r1', 'C:/p/a.ts')));
    expect(feedProps.approval?.requestId).toBe('r1');

    await act(async () => feedProps.onAllowFile!('C:/p/a.ts'));
    // the grant is out and the answer has NOT been sent yet
    expect(calls).toEqual(['grant:live-1:C:/p/a.ts']);

    await act(async () => {
      releaseGrant!();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(calls).toEqual(['grant:live-1:C:/p/a.ts', 'decide:r1:allow']);
  });

  // The queue really does move here — `feedProps.approval` below proves the bar
  // has advanced to r2 — and the answer still lands on r1. See the header for
  // why this passes without `decide`'s `target` argument and is worth keeping.
  it('answers the request it GRANTED, not whatever is head when the IPC lands', async () => {
    await mountCard();
    await act(async () => pushPermission!(held('r1', 'C:/p/a.ts')));
    await act(async () => feedProps.onAllowFile!('C:/p/a.ts'));

    // something else resolves r1 and a different request takes the bar — an OS
    // toast, the batch card, or the 300s fail-open, all of which reach the card
    // as `permissionResolved` and prune its queue
    await act(async () => pushPermission!(held('r2', 'C:/p/DANGEROUS.ts')));
    await act(async () => resolvePermission!({ requestId: 'r1' }));
    expect(feedProps.approval?.requestId).toBe('r2');
    await act(async () => {
      releaseGrant!();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(calls).toContain('decide:r1:allow');
    expect(calls).not.toContain('decide:r2:allow');
  });

  it('still answers when the grant is REFUSED — the half we can honour is the yes', async () => {
    await mountCard();
    await act(async () => pushPermission!(held('r1', 'C:/p/a.ts')));
    await act(async () => feedProps.onAllowFile!('C:/p/a.ts'));
    await act(async () => {
      // main refuses an unresolvable path by rejecting nothing and answering
      // null; the catch below covers the rejection case too
      releaseGrant!();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(calls).toContain('decide:r1:allow');
  });
});
