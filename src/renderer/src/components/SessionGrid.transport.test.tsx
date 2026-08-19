// @vitest-environment jsdom
// The card's transport surfaces (#419, from the #404 audit): the ⋯ menu's mode
// label, the toggle round-trip, and the pending-restart affordance.
//
// These were e2e-only. Three of the four ways they rot are one-character edits
// — swapping `now`/`next` in the label, dropping the `r.ok` guard so a REFUSED
// change still repaints, or forgetting to clear `transportPending` on restart,
// which leaves a "still running on the old one" notice above a session that is
// running on the new one. None of them crashes, all of them lie, and a lie
// about which transport a session is on is the one this epic can least afford.
//
// HOW A CARD IS REACHED WITHOUT A LIVE DOCKVIEW
// --------------------------------------------
// `SessionCardPanel` is the file's private component — every comment in
// SessionGrid.test.tsx that says "needs a live dockview" is about this wall.
// It is not exported for a test here: `DockviewReact` is stubbed instead, so
// rendering the real `SessionGrid` hands over the very `components` map
// dockview would have instantiated cards from. The card is then mounted with
// the panel props dockview passes it (`IdentityTab.test.tsx` fakes the same
// api, one level up). Nothing in the product moves.
//
// The two heavy leaf panes are stubbed: the Terminal panel is `keepMounted`,
// so a card ALWAYS builds an xterm, and jsdom has no canvas for one. Neither
// is a transport surface — the Terminal tab's own stream branch is pinned in
// `extensibility/panels.transport.test.tsx`, against the real registry.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { initI18nForTests } from '../i18n/test-i18n';
import en from '../i18n/locales/en.json';
import { sessionStore } from '../store/session-store';
import { registerBuiltinContributions } from '../bootstrap';
import { rendererRegistry } from '../extensibility/registry-instance';
import { DEFAULT_SESSION_TRANSPORT, type TransportKind } from '../../../shared/transport';
import type { IDockviewPanelProps } from 'dockview-react';
// STATIC, not a dynamic import inside the hook: this module pulls in monaco
// and xterm through its panel components, and paying for that inside a
// `beforeAll` blew vitest's 10s hook budget when the file ran alongside the
// rest of the suite. Collection has no such cap. `vi.mock` is hoisted above
// every import, so the stub below is still in place when this loads.
import { SessionGrid, type CardParams } from './SessionGrid';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

/** The `components` map SessionGrid hands dockview — captured from the stub. */
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

// ── the bridge, as much of it as a mounted card touches ──────────────────────

interface Calls {
  setTransport: Array<[string, TransportKind]>;
  create: number;
  dropLive: string[];
}
let calls: Calls;
/** what `sessions.setTransport` answers next */
let setTransportReply: { ok: boolean; reason?: string; pending?: boolean };
/** what `sessions.create` reports as the session's transport — never absent,
 *  because a live record always carries one (#445) */
let spawnTransport: TransportKind;

const off = (): void => {};
const disposable = { dispose: off };

function installBridge(): void {
  calls = { setTransport: [], create: 0, dropLive: [] };
  (window as unknown as { switchboard: unknown }).switchboard = {
    sessions: {
      create: () => {
        calls.create++;
        return Promise.resolve({
          id: `live-${calls.create}`,
          // a token, not a hex: the card paints its accent border with this and
          // the lint rule that bans raw hex in this repo applies to tests too
          identity: { accentColor: 'var(--faint)', langBadge: 'ts' },
          autonomy: 'ask',
          status: 'idle',
          transport: spawnTransport,
        });
      },
      setTransport: (cardId: string, transport: TransportKind) => {
        calls.setTransport.push([cardId, transport]);
        return Promise.resolve(setTransportReply);
      },
      dropLive: (cardId: string) => {
        calls.dropLive.push(cardId);
        return Promise.resolve();
      },
      setAutonomy: () => Promise.resolve(),
      setTaskLabel: () => Promise.resolve(),
      decidePermission: () => Promise.resolve(),
      allowAllSession: () => Promise.resolve(),
      closeCard: () => Promise.resolve(),
      pendingPermissions: () => Promise.resolve([]),
      onExited: () => off,
      onUsage: () => off,
      onStatus: () => off,
      onPermissionRequest: () => off,
      onPermissionResolved: () => off,
    },
    transcripts: { binding: () => Promise.resolve(null) },
    git: { status: () => Promise.resolve(null) },
  };
}

/** The panel props dockview gives a card. Only what the card reads. */
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

// ── the DOM the tests speak in ───────────────────────────────────────────────

let root: Root | null = null;
let host: HTMLElement;

/** the ⋯ button in the card header */
function menuButton(): HTMLButtonElement {
  const btn = host.querySelector<HTMLButtonElement>(`button[title="${en.grid.menu}"]`);
  if (!btn) throw new Error('the card has no ⋯ menu');
  return btn;
}

/** the transport entry — found by its hint, which is the one thing about it
 *  that is not the text under test */
function transportItem(): HTMLButtonElement | null {
  return host.querySelector<HTMLButtonElement>(
    `button[title="${en.grid.menuTransportHint}"]`
  );
}

function restartButton(): HTMLButtonElement | null {
  return (
    Array.from(host.querySelectorAll('button')).find(
      (b) => b.textContent === en.grid.menuTransportRestart
    ) ?? null
  );
}

function pendingNoticeShown(): boolean {
  return (host.textContent ?? '').includes(en.grid.menuTransportPending);
}

/** the menu entry's words, as en.json renders them */
function label(now: string, next: string): string {
  return en.grid.menuTransportSwitch.replace('{now}', now).replace('{next}', next);
}
const STREAM = en.grid.transportStream;
const PTY = en.grid.transportPty;

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

/** Mount a card whose session comes up on `transport`. */
async function mountCard(transport: TransportKind = 'pty'): Promise<void> {
  spawnTransport = transport;
  await act(async () => {
    root!.render(React.createElement(components.sessionCard, panelProps('c1')));
  });
}

async function openMenu(): Promise<void> {
  await click(menuButton());
}

beforeAll(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  await initI18nForTests();
  installBridge();
  // The card renders its view tabs from the MODULE registry, which `main.tsx`
  // fills at boot and a test file does not get for free — without this a card
  // has a header and an empty body, and the panel half of these surfaces would
  // be asserting against nothing.
  registerBuiltinContributions(rendererRegistry);
  // one render of the real grid, purely to take the components map off the
  // stubbed DockviewReact
  const gridHost = document.createElement('div');
  document.body.appendChild(gridHost);
  const gridRoot = createRoot(gridHost);
  await act(async () => {
    gridRoot.render(
      <SessionGrid colorScheme="dark" seedPanels={0} onCardsChanged={() => {}} />
    );
  });
  await act(async () => gridRoot.unmount());
  gridHost.remove();
  expect(typeof components.sessionCard).toBe('function');
});

beforeEach(() => {
  installBridge();
  setTransportReply = { ok: true, pending: false };
  sessionStore.setSessions([]);
  sessionStore.initPresentation(new Map());
  sessionStore.forgetCardLiveIds('c1'); // no live id from the last card survives
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root!.unmount());
  host.remove();
  root = null;
});

// ── the mode label ───────────────────────────────────────────────────────────

describe('the ⋯ menu says which transport this session is on', () => {
  it('reads Direct for a stream session, and offers Terminal', async () => {
    await mountCard('stream');
    await openMenu();
    expect(transportItem()?.textContent).toBe(label(STREAM, PTY));
  });

  it('reads Terminal for a PTY session, and offers Direct', async () => {
    await mountCard('pty');
    await openMenu();
    expect(transportItem()?.textContent).toBe(label(PTY, STREAM));
  });

  it('states the mode and the ACTION separately, never one word alone', async () => {
    // #153's defect, as a claim: in a menu an entry reads as a command, so
    // "Transport: Terminal" on its own looked like "switch to Terminal" — and
    // it was the current state. Both modes must be named, in that order.
    await mountCard('stream');
    await openMenu();
    const text = transportItem()?.textContent ?? '';
    expect(text.indexOf(STREAM)).toBeGreaterThanOrEqual(0);
    expect(text.indexOf(PTY)).toBeGreaterThan(text.indexOf(STREAM));
  });

  it('follows main’s answer rather than a default of its own', async () => {
    // The regression #419 names: the state seeds from DEFAULT_SESSION_TRANSPORT
    // and is then overwritten by the record. If the two ever disagree about
    // what a default session is, every card mislabels its mode — so the
    // expectation is COMPUTED from the shared constant, not typed out.
    await mountCard(DEFAULT_SESSION_TRANSPORT);
    await openMenu();
    const now = DEFAULT_SESSION_TRANSPORT === 'stream' ? STREAM : PTY;
    expect(transportItem()?.textContent).toBe(
      label(now, now === STREAM ? PTY : STREAM)
    );
  });

  it('never shows the seed: there is no menu until main has answered', async () => {
    // Why the seed cannot be asserted through this surface, written down so the
    // next reader does not go looking for a test of it: the ⋯ menu renders only
    // inside the `live` branch, and `live` and the stored transport are set in
    // the SAME batch off the create reply. The seed is the answer the component
    // would give if asked before that — it is never on screen, which is exactly
    // why it must not be a second opinion about the default.
    let land = (): void => {};
    const held = new Promise<void>((r) => {
      land = r;
    });
    const real = (
      window as unknown as { switchboard: { sessions: { create: () => Promise<unknown> } } }
    ).switchboard.sessions;
    const answer = real.create;
    real.create = () => held.then(() => answer());
    await act(async () => {
      root!.render(React.createElement(components.sessionCard, panelProps('c1')));
    });
    expect(host.querySelector(`button[title="${en.grid.menu}"]`)).toBeNull();
    expect(host.textContent).toContain('Resuming');
    // let the card finish coming up, so the menu it has no business showing yet
    // is proven to be one it CAN show
    await act(async () => {
      land();
      await held;
    });
    expect(menuButton().textContent).toBe(en.grid.menuIcon);
  });
});

// ── the seed ─────────────────────────────────────────────────────────────────
//
// WHY THE WITNESS IS THE SOURCE TEXT
// ----------------------------------
// The same reason `always-visible-notices.test.ts` reads App.tsx: there is no
// other witness. The seed is the value `cardTransport` holds before main has
// answered, and the test above proves that state is never on screen — the menu
// lives inside the `live` branch, and `live` arrives in the same batch as the
// record's transport. So a rendered assertion of the seed is not merely hard,
// it is impossible by construction, and the thing #419 asks to pin is exactly
// the one a running card cannot show: that this component holds no SECOND
// OPINION about what a default session's transport is. A hard-coded `'pty'`
// here was the pre-#381 state, and the day the shared default changes it is
// the answer every card would give in the gap before main replies.

describe('the seeded transport (#381)', () => {
  const source = fs
    .readFileSync(path.join(__dirname, 'SessionGrid.tsx'), 'utf8')
    .replace(/\r\n/g, '\n');

  /** the `useState` that holds the card's transport, declaration and all */
  const seed = source.match(/useState<TransportKind>\(\s*([^)]*?)\s*\)/);

  it('seeds from the shared default, not from a literal of its own', () => {
    expect(seed, 'the cardTransport useState moved or changed shape').not.toBeNull();
    expect(seed![1]).toBe('DEFAULT_SESSION_TRANSPORT');
  });

  it('takes that constant from shared/, the one main reads too', () => {
    // A local `const DEFAULT_SESSION_TRANSPORT = 'pty'` would satisfy the test
    // above and be the very drift it exists to stop.
    expect(source).toMatch(
      /import \{[^}]*DEFAULT_SESSION_TRANSPORT[^}]*\} from '\.\.\/\.\.\/\.\.\/shared\/transport'/
    );
    expect(source).not.toMatch(/(const|let) DEFAULT_SESSION_TRANSPORT/);
  });

  // #445 — the OTHER end of the same state. The seed above is what this
  // component holds before main answers; this is what it does WITH the answer,
  // and it used to be `record.transport === 'stream' ? 'stream' : 'pty'`. That
  // ternary reads as a type narrowing, which is why it survived review, but a
  // narrowing with an `else` branch is a default — a second one, disagreeing
  // with the seed four lines above it and with main. Unreachable while every
  // live record carries a transport (the DTO now requires it, pinned in
  // `main/sessions/transport-seam.test.ts`), and that is exactly the kind of
  // stray a rendered assertion cannot reach: the source text is the witness.
  it('takes main’s answer verbatim, with no default of its own (#445)', () => {
    const assign = source.match(/setCardTransport\(record\.transport[^;]*\);/);
    expect(assign, 'the create-reply assignment moved or changed shape').not.toBeNull();
    expect(assign![0]).toBe('setCardTransport(record.transport);');
  });

  it('holds no second opinion about the default anywhere in the file', () => {
    // Belt to the braces above, and the shape the stray is most likely to come
    // back in: `?? 'pty'` is a default by definition, wherever it is written.
    // The plain literals stay legal — the toggle's other side is one.
    expect(source).not.toMatch(/\?\?\s*'pty'/);
    expect(source).not.toMatch(/\?\?\s*'stream'/);
  });
});

// ── the toggle ───────────────────────────────────────────────────────────────

describe('the ⋯ menu toggles the transport', () => {
  it('asks main for the OTHER one, and repaints once it is accepted', async () => {
    await mountCard('pty');
    await openMenu();
    await click(transportItem()!);
    expect(calls.setTransport).toEqual([['c1', 'stream']]);
    expect(transportItem()?.textContent).toBe(label(STREAM, PTY));
  });

  it('round-trips: a second toggle goes back to where it started', async () => {
    await mountCard('stream');
    await openMenu();
    await click(transportItem()!);
    await click(transportItem()!);
    expect(calls.setTransport).toEqual([
      ['c1', 'pty'],
      ['c1', 'stream'],
    ]);
    expect(transportItem()?.textContent).toBe(label(STREAM, PTY));
  });

  it('does NOT repaint when main refuses the change', async () => {
    // The `r.ok` guard. Without it the menu shows a mode the record does not
    // hold, and the next spawn contradicts the UI with no event in between.
    setTransportReply = { ok: false, reason: 'unknown-card' };
    await mountCard('pty');
    await openMenu();
    await click(transportItem()!);
    expect(calls.setTransport).toEqual([['c1', 'stream']]);
    expect(transportItem()?.textContent).toBe(label(PTY, STREAM));
    expect(pendingNoticeShown()).toBe(false);
  });

  it('leaves the menu open, so the queued-change notice is seen', async () => {
    setTransportReply = { ok: true, pending: true };
    await mountCard('pty');
    await openMenu();
    await click(transportItem()!);
    expect(transportItem()).not.toBeNull();
  });
});

// ── the pending-restart affordance ───────────────────────────────────────────

describe('a change queued behind a running session', () => {
  it('says the session is still on the old transport, and offers a restart', async () => {
    setTransportReply = { ok: true, pending: true };
    await mountCard('pty');
    await openMenu();
    expect(pendingNoticeShown()).toBe(false); // nothing to say before the change
    await click(transportItem()!);
    expect(pendingNoticeShown()).toBe(true);
    expect(restartButton()).not.toBeNull();
  });

  it('stays quiet when nothing is running to be pending on', async () => {
    setTransportReply = { ok: true, pending: false };
    await mountCard('pty');
    await openMenu();
    await click(transportItem()!);
    expect(pendingNoticeShown()).toBe(false);
    expect(restartButton()).toBeNull();
  });

  it('restarts the session, closes the menu, and clears the notice', async () => {
    // The affordance exists because the only other route to a restart is the
    // card's ✕, which deletes the record and the stored choice with it (#153).
    // Its three effects are one behaviour: main is told to drop the live
    // session, the menu gets out of the way, and the notice — which is about a
    // session that no longer exists — goes with it.
    setTransportReply = { ok: true, pending: true };
    await mountCard('pty');
    await openMenu();
    await click(transportItem()!);
    spawnTransport = 'stream'; // the respawn comes up on the new transport
    await click(restartButton()!);

    expect(calls.dropLive).toEqual(['c1']);
    expect(pendingNoticeShown()).toBe(false);
    expect(transportItem()).toBeNull(); // the menu closed
    // ...and the card really did start again, on the transport that was queued
    expect(calls.create).toBe(2);
    // REOPENED, which is where a notice that was merely hidden by the closing
    // menu would come back: "still running on the old one" over a session that
    // is running on the new one.
    await openMenu();
    expect(transportItem()?.textContent).toBe(label(STREAM, PTY));
    expect(pendingNoticeShown()).toBe(false);
    expect(restartButton()).toBeNull();
  });

  it('does not move the RUNNING session — the Terminal tab keeps its terminal', async () => {
    // The two notions of "this card's transport", side by side, which is the
    // whole reason the notice exists. The menu label is the CHOICE (what the
    // next spawn will use); the panel context is the RUNNING session
    // (`live.transport`). Wiring the panels to the choice would take a PTY
    // session's terminal away while it is still streaming into it — the empty
    // black rectangle, arrived at from the other direction.
    setTransportReply = { ok: true, pending: true };
    await mountCard('pty');
    await openMenu();
    await click(transportItem()!);
    expect(transportItem()?.textContent).toBe(label(STREAM, PTY));
    expect(host.querySelector('[data-testid="terminal-pane"]')).not.toBeNull();
  });

  it('does not carry the notice over to the next change', async () => {
    // `pending` is per-answer: a change accepted while nothing is running must
    // take the notice down rather than leave the previous one standing.
    setTransportReply = { ok: true, pending: true };
    await mountCard('pty');
    await openMenu();
    await click(transportItem()!);
    expect(pendingNoticeShown()).toBe(true);
    setTransportReply = { ok: true, pending: false };
    await click(transportItem()!);
    expect(pendingNoticeShown()).toBe(false);
  });
});
