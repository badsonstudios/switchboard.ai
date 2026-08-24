// @vitest-environment jsdom
// The pin for #678: a refused `sessions:knownCards` read during layout restore
// must prune NOTHING, and the guard for that lives at the call site.
//
// #650 chose `null` over `[]` for the degraded known-card set, because six of
// the eight prune targets delete unconditionally against it — presentation,
// policies, layout, focus policies, pins and manual rail order — so an empty
// set there wipes every one of them for every session, in the first second of
// a launch, on the strength of an IPC answer we never received. The choice was
// correct, load-bearing, and unpinned: the refusal scanner pins the LAUNDERER
// (`answered`), not the choice of `null` over `[]` after it. Someone could
// keep `answered` and write `?? new Set()` and this file is the only thing
// that goes red.
//
// THE GUARD PLACEMENT IS A DECISION, pinned here deliberately (the issue asked
// for one): it stays AT THE CALL SITE (`if (known !== null)`), NOT pushed down
// into the six `prune*` helpers as an empty-set early-return. A genuinely
// cardless app — fresh workspace, every card closed — SHOULD prune, or stale
// records leak forever; an unconditional `size === 0` return inside the
// helpers cannot tell that state from "we could not ask". The second test is
// that half: a real empty answer still prunes. (The two DRAFT prunes are not
// spied here — they are module imports with their own deliberate empty-set
// early-returns, pinned in `composer-draft.test.ts` / its sibling.)
//
// HOW THE RESTORE PATH IS REACHED: the prune block lives inside `onReady`,
// which dockview calls with its api. `DockviewReact` is stubbed (the
// `SessionGrid.transport.test.tsx` wall), so the stub captures the `onReady`
// prop and the test invokes it with a fake api — empty grid, no-op `fromJSON`.
// Everything between the bridge answer and the prune calls is the real code.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { initI18nForTests } from '../i18n/test-i18n';
import { sessionStore } from '../store/session-store';
import { ipcRefusal } from '../../../shared/ipc/refusal';
import { SessionGrid } from './SessionGrid';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

/** the `onReady` prop SessionGrid hands dockview — captured from the stub */
let capturedOnReady: ((e: unknown) => void) | null = null;

vi.mock('dockview-react', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return {
    ...real,
    DockviewReact: (props: { onReady: (e: unknown) => void }): null => {
      capturedOnReady = props.onReady;
      return null;
    },
  };
});

// the two heavy leaf panes, stubbed for the same jsdom reasons as the
// transport test — neither is on the restore path
vi.mock('./TerminalPane', () => ({
  TerminalPane: (): React.JSX.Element => <div data-testid="terminal-pane" />,
}));
vi.mock('./FeedView', () => ({
  FeedView: (): React.JSX.Element => <div data-testid="feed-view" />,
}));

const off = (): void => {};

/** what `sessions.knownCards` / `groups.list` answer in this test */
let knownCardsAnswer: unknown;
let groupsAnswer: unknown;

// A saved layout that exists — the restore (and therefore the prune block)
// only runs when `workspace:getLayout` answers one. No popout groups, no
// panels: the blob only has to survive `prunePopoutGroups` /
// `sanitizePopoutLayout` (both pass unknown shapes through) and a no-op
// `fromJSON`.
const SAVED_LAYOUT = { grid: { root: { type: 'branch', data: [] } }, panels: {} };

function installBridge(): void {
  (window as unknown as { switchboard: unknown }).switchboard = {
    sessions: {
      knownCards: () => Promise.resolve(knownCardsAnswer),
      pendingPermissions: () => Promise.resolve([]),
      closeCard: () => Promise.resolve(),
      onExited: () => off,
      onUsage: () => off,
      onStatus: () => off,
      onPermissionRequest: () => off,
      onPermissionResolved: () => off,
    },
    groups: { list: () => Promise.resolve(groupsAnswer) },
    workspace: {
      getLayout: () => Promise.resolve(SAVED_LAYOUT),
      setLayout: () => {},
      setUi: () => {},
    },
    workAreas: () => Promise.resolve([]),
    transcripts: { binding: () => Promise.resolve(null) },
    git: { status: () => Promise.resolve(null) },
  };
}

/** the least dockview api the whole of `onReady` touches on an empty grid */
function fakeApi(): { fromJSON: ReturnType<typeof vi.fn> } {
  return {
    panels: [] as unknown[],
    updateOptions: () => {},
    onDidLayoutChange: () => {},
    onDidActivePanelChange: () => {},
    onDidRemovePanel: () => {},
    fromJSON: vi.fn(),
    removePanel: () => {},
    getPanel: () => undefined,
    addPanel: () => {},
  } as unknown as { fromJSON: ReturnType<typeof vi.fn> };
}

type PruneSpy = ReturnType<typeof vi.spyOn>;

/** the six unconditional deleters — the whole hazard, by name */
function spyPrunes(): Record<string, PruneSpy> {
  return {
    presentation: vi.spyOn(sessionStore, 'prunePresentation'),
    policies: vi.spyOn(sessionStore, 'prunePolicies'),
    layout: vi.spyOn(sessionStore, 'pruneLayout'),
    focusPolicies: vi.spyOn(sessionStore, 'pruneFocusPolicies'),
    pins: vi.spyOn(sessionStore, 'prunePins'),
    manualOrder: vi.spyOn(sessionStore, 'pruneManualOrder'),
  };
}

let root: Root | null = null;
let host: HTMLElement;
let onCardsChanged: ReturnType<typeof vi.fn>;

/** mount the grid, then drive its captured `onReady` to the end of bring-up */
async function runBringUp(): Promise<{ fromJSON: ReturnType<typeof vi.fn> }> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <SessionGrid colorScheme="dark" seedPanels={0} onCardsChanged={onCardsChanged} />
    );
  });
  expect(capturedOnReady).toBeTypeOf('function');
  const api = fakeApi();
  await act(async () => {
    capturedOnReady!({ api });
  });
  // `onReady` is async and the capture wraps it in `void` — `report()` firing
  // at the end of the try block is the signal that the restore, the prune
  // block and the grid sweep have all run.
  await vi.waitFor(() => expect(onCardsChanged).toHaveBeenCalled());
  return api;
}

beforeAll(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  await initI18nForTests();
});

beforeEach(() => {
  installBridge();
  capturedOnReady = null;
  onCardsChanged = vi.fn();
  sessionStore.setSessions([]);
  sessionStore.initPresentation(new Map());
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (root) {
    const r = root;
    root = null;
    await act(async () => r.unmount());
  }
  host?.remove();
});

describe('layout restore vs a refused sessions:knownCards read (#678)', () => {
  it('a refusal reaches the prune path as NOTHING — not as an empty set', async () => {
    // The red-on-revert case. Degrade the refusal to `new Set()` instead of
    // `null` at the `known` binding and all six spies fire with an empty set —
    // which in a real launch is every pin, policy, presentation override,
    // maximize, focus policy and manual rail position in the app, deleted.
    knownCardsAnswer = ipcRefusal('sessions:knownCards', 'capability-not-held');
    groupsAnswer = ipcRefusal('groups:list', 'capability-not-held');
    const spies = spyPrunes();
    const api = await runBringUp();
    // the restore itself still ran — a refusal degrades the PRUNE, not the
    // whole layout (fail-open: the user still gets their arrangement back)
    expect(api.fromJSON).toHaveBeenCalledTimes(1);
    for (const [name, spy] of Object.entries(spies)) {
      expect(spy, `${name} pruned on a refused read`).not.toHaveBeenCalled();
    }
  });

  it('a GENUINE empty answer still prunes — the guard is not an empty-set guard', async () => {
    // The other half of the decision, and the reason the guard cannot move
    // down into the `prune*` helpers: a truly cardless app answers `[]`, and
    // that answer MUST prune, or records for long-closed cards leak forever.
    // `null` and `[]` mean different things, and this pair of tests is that
    // sentence, enforced.
    knownCardsAnswer = [];
    groupsAnswer = [];
    const spies = spyPrunes();
    await runBringUp();
    for (const [name, spy] of Object.entries(spies)) {
      expect(spy, `${name} must prune for a cardless app`).toHaveBeenCalledTimes(1);
    }
    // ...and with the empty set the answer actually named, not a fallback
    expect(spies.presentation).toHaveBeenCalledWith(new Set());
  });
});
