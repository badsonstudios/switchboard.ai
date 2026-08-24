// @vitest-environment jsdom
// The ENDED card's header (#606, §5.8 + §5.11) — the last card state that drew
// none, and the same defect #216 closed for the suspended one.
//
// WHICH CARD, precisely: one whose session NEVER STARTED. A session that ran and
// then died keeps its record (`onExited` sets `ended` and leaves `live` alone,
// deliberately), so it renders through the live arm with the header it always
// had. The arm this file is about is `live === null && ended`, and it drew its
// overlay and nothing else — so §5.8's "double-click a session header toggles
// maximize" had no target on it while `Ctrl+Shift+M` and the palette command
// worked the whole time. That asymmetry is invisible in a screenshot — a header
// that is missing and a header that is dead look identical — which is why it
// survived #216 and needed its own ticket.
//
// What this pins, in order of what a user would notice:
//   • the header EXISTS on that card, with the card's identity on it;
//   • double-clicking it maximizes — and again puts the layout back;
//   • it says so in one word, from the ramp's own vocabulary;
//   • it carries none of the controls that act on a running session, because
//     Try again and Close are the overlay's two buttons below it;
//   • and nothing here re-arms the spawn the card was refused.
//
// The route to the state is the one a user reaches (#347/#355): `sessions:create`
// answers `null` for a start it refused, and the spawn effect paints
// `never-started`.
//
// The dockview wall is climbed exactly as `SessionGrid.suspended-header.test.tsx`
// does; see its header for why the stub is the honest way in.
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
import { SessionGrid, endedPill, type CardParams } from './SessionGrid';

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

/** the bridge, with a `sessions:create` that REFUSES — #347's `null` answer */
function installBridge(): void {
  created = 0;
  (window as unknown as { switchboard: unknown }).switchboard = {
    sessions: {
      create: () => {
        created += 1;
        return Promise.resolve(null);
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
    // truthy and inert, exactly as the suspended-header spec does it: the STORE
    // write is the assertion, not a real panel move
    containerApi: { getPanel: () => undefined, removePanel: off },
    params: { cardId, folder: 'C:\\Projects\\acme', title: 'acme' },
  } as unknown as IDockviewPanelProps<CardParams>;
}

let root: Root | null = null;
let host: HTMLElement;
let warn: ReturnType<typeof vi.spyOn>;

const header = (): HTMLElement | null => host.querySelector('[data-testid="card-header"]');

async function mountCard(): Promise<void> {
  await act(async () => {
    root!.render(React.createElement(components.sessionCard, panelProps('c1')));
  });
  // the refusal lands in a promise chain, so the ended paint is a tick later
  await act(async () => {
    await Promise.resolve();
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
  // the card logs "session did not start — see the app log" on the way in; that
  // line is deliberate (#347) and is not what this file is about
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  sessionStore.setSessions([
    { id: 'c1', title: 'acme', accent: 'var(--accent-teal)', badge: 'ts', status: 'idle' },
    // a second card, so a maximize has something to be a maximize OVER
    { id: 'c2', title: 'other', status: 'idle' },
  ]);
  sessionStore.initPresentation(new Map());
  sessionStore.forgetCardLiveIds('c1');
  sessionStore.setLayout(DEFAULT_LAYOUT);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root!.unmount());
  host.remove();
  root = null;
  warn.mockRestore();
  sessionStore.setLayout(DEFAULT_LAYOUT);
});

describe('an ended card still has a header (#606)', () => {
  it('renders one, over the overlay that says the session never started', async () => {
    await mountCard();
    expect(host.querySelector('[data-testid="card-overlay"]')?.textContent).toContain(
      en.grid.sessionNotStarted
    );
    expect(header()).not.toBeNull();
    // one refusal, not a retry loop: the header must not re-arm the spawn
    expect(created).toBe(1);
  });

  it('carries the card identity — name, badge and accent (§5.11)', async () => {
    await mountCard();
    expect(host.querySelector('[data-testid="card-header-name"]')?.textContent).toBe('acme');
    expect(host.querySelector('[data-testid="identity-badge"]')?.textContent).toBe('ts');
    expect(header()!.style.borderInlineStart).toContain('var(--accent-teal)');
  });

  it('falls back to the neutral accent before the card list has landed', async () => {
    sessionStore.setSessions([]);
    await mountCard();
    expect(header()).not.toBeNull();
    expect(header()!.style.borderInlineStart).toContain('var(--faint)');
    expect(host.querySelector('[data-testid="identity-badge"]')).toBeNull();
  });

  it('offers no control that would act on a session that is not running', async () => {
    await mountCard();
    // Try again and Close are the OVERLAY's; the header's own buttons
    // (collapse, pop out, ⋯) are the ones that must not be there
    expect(header()!.querySelectorAll('button')).toHaveLength(0);
  });

  it('says "not started" in the pill, on the ramp position that means nothing is happening', async () => {
    await mountCard();
    const pill = host.querySelector('.status-pill');
    expect(pill?.textContent).toBe(en.status.notStarted);
    // `idle` is the ramp position, not the word: inventing a seventh hue here
    // would paint a status the contrast tests never measure (#221)
    expect(pill?.getAttribute('data-status')).toBe('idle');
  });
});

// The gesture the header exists for, at the level this component owns it: the
// double-click reaches `toggleMaximizeCard` and the STORE records it. Whether
// the workspace then rearranges is `lib/layout-mode`'s call, and for THIS card
// it declines - `heldMaximize` honours a maximize only for a card the session
// list holds, and a card whose start was refused was never registered as one.
// That is older than this header (`Ctrl+Shift+M` has the same limit on the same
// card) and is reported on #606's PR rather than papered over here.
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
});

// `endedPill` is a TOTAL function over `CardEnded`, and only one of its answers
// renders today: a session that ran and then died keeps its record, so it draws
// the LIVE header and takes its pill from `status`. The `exited` answers below
// are the ones that would be used the moment anyone routes that header through
// here - which is the obvious next step, and the reason the function is total
// rather than a one-armed `if`. Pinned for the same reason `endedCopy` is
// pinned: which words go with which ending, and that every key really exists.
describe('endedPill', () => {
  it('calls a crash a crash, on the ramp position the alarm lives at', () => {
    expect(endedPill({ kind: 'exited', code: 137, crashed: true })).toEqual({
      status: 'crashed',
      labelKey: 'status.crashed',
    });
  });

  it('calls a clean close done', () => {
    expect(endedPill({ kind: 'exited', code: 0, crashed: false })).toEqual({
      status: 'done',
      labelKey: 'status.done',
    });
  });

  it('does not call a session that never ran "idle", "done" or "crashed"', () => {
    const pill = endedPill({ kind: 'never-started' });
    expect(pill.labelKey).toBe('status.notStarted');
    expect(pill.status).toBe('idle');
  });

  it('names only keys that exist in en.json', () => {
    for (const ended of [
      { kind: 'never-started' },
      { kind: 'exited', code: 0, crashed: false },
      { kind: 'exited', code: -1, crashed: true },
    ] as const) {
      const key = endedPill(ended).labelKey.split('.');
      const text = key.reduce<unknown>(
        (node, part) => (node as Record<string, unknown> | undefined)?.[part],
        en
      );
      expect(typeof text).toBe('string');
      expect((text as string).length).toBeGreaterThan(0);
    }
  });
});
