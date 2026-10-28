// @vitest-environment jsdom
// The permission-mode hover, on the controls a user actually meets (#534).
//
// `lib/autonomy.test.ts` pins the COPY — that every mode has a description,
// that the three surfaces share it, and that what it says about
// `bypassPermissions` and `acceptEdits` matches the CLI. What only a rendered
// test can claim is the part that was actually broken: that the description
// reaches the DOM of the control, on the element the pointer is over.
//
// The defect this guards against is not a wrong string, it is a `title` that
// quietly stops being passed — a prop dropped in a styling tidy-up, or a
// surface refactored into a wrapper that keeps the text and loses the hover.
// Nothing in a copy test would notice, and the user would be back to a chip
// that says "full-auto" and nothing else.
//
// The title-bar chip is GONE (#1434) — one autonomy control now, per session;
// the first test below pins its absence. The card-header badge lives inside
// SessionGrid, whose tree is a live dockview, so it is covered the way the
// tab strip is (see `a11y-surfaces.test.tsx`'s note): by the pure test of the
// copy it renders, plus the hand-test in the dogfood tracker.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import i18next from 'i18next';
import { initI18nForTests } from '../i18n/test-i18n';
import en from '../../../shared/i18n/locales/en.json';
import { TitleBar } from './chrome';
import { sessionPanels } from '../extensibility/panels';
import { PanelContext } from '../extensibility/contributions';
import { allowAllTooltip, AUTONOMIES, autonomyDescription, autonomyTooltip } from '../lib/autonomy';
import { UNKNOWN_BUILD_IDENTITY } from '../../../shared/build-identity';
import { resetAisStoreForTests } from '../lib/ais-store';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

const roots: Root[] = [];
const noop = (): void => {};

async function mount(tree: React.ReactNode): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => {
    root.render(tree);
  });
  return host;
}

/** the title bar, every control held constant */
function bar(): React.JSX.Element {
  return (
    <TitleBar
      version="0.0.0-test"
      identity={UNKNOWN_BUILD_IDENTITY}
      onOpenAbout={noop}
      notifEnabled={false}
      onToggleNotif={noop}
      layoutMode="grid"
      layoutMaximized={false}
      onCycleLayoutMode={noop}
      onLayoutPreset={() => {}}
      onEqualizeLayout={() => {}}
      layoutArrangeable
      layoutBinding="Ctrl+Alt+L"
      autoLabels={true}
      onCycleLabels={noop}
      soundsOn={false}
      onToggleSounds={noop}
      speakOn={false}
      onToggleSpeak={noop}
      railHidden={false}
      sessionsPlacement="left"
      onPlacementClick={noop}
      railBinding="Ctrl+B"
      onOpenPalette={noop}
      paletteBinding="Ctrl+K"
    />
  );
}

const feedPanel = sessionPanels.find((p) => p.id === 'feed')!;

const revokeStandingGrant = vi.fn(() => Promise.resolve(true));

function stubBridge(): void {
  (window as unknown as { switchboard: unknown }).switchboard = {
    transcripts: {
      blocks: () => Promise.resolve([]),
      onBlock: () => () => {},
      onReset: () => () => {},
    },
    sessions: { slashCommands: () => Promise.resolve([]), revokeStandingGrant },
    workspace: { getUi: () => Promise.resolve({}), setUi: () => {} },
  };
}

/** the feed panel, whose composer carries this session's shield button */
async function composerHost(
  autonomy: string,
  providerId?: string,
  extra: Partial<PanelContext> = {}
): Promise<HTMLElement> {
  const ctx: PanelContext = {
    sessionId: 'live-1',
    cardId: 'card-1',
    title: 'acme-web',
    visible: true,
    dockEpoch: 0,
    theme: 'nordic',
    colorScheme: 'dark',
    changed: 0,
    controlsLock: null,
    setView: () => {},
    autonomy,
    onSetAutonomy: noop,
    ...(providerId ? { providerId } : {}),
    ...extra,
  };
  return mount(feedPanel.render(ctx));
}

function titled(host: HTMLElement, testId: string): HTMLElement {
  const el = host.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  if (!el) throw new Error(`${testId} is not on screen at all`);
  return el;
}

describe('the permission-mode hover', () => {
  beforeAll(async () => {
    await initI18nForTests();
    stubBridge();
  });
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    // jsdom has no ResizeObserver, and the feed's scroll anchor plus the
    // composer's re-measure both install one
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      }
    );
  });
  afterEach(async () => {
    await act(async () => {
      for (const r of roots.splice(0)) r.unmount();
    });
    document.body.innerHTML = '';
  });

  it('the title bar has NO autonomy chip any more (#1434)', async () => {
    // Dan's call: one control, per session. The title bar's chip set the mode
    // new sessions start at, and two controls for one idea confused him.
    const host = await mount(bar());
    expect(host.querySelector('[data-testid="titlebar-autonomy"]')).toBeNull();
    for (const mode of AUTONOMIES) {
      expect(host.textContent).not.toContain(en.autonomy[mode]);
    }
  });

  it("explains the mode on this session's shield button, for every mode", async () => {
    for (const mode of AUTONOMIES) {
      const host = await composerHost(mode);
      const chip = titled(host, 'composer-autonomy');
      expect(chip.title).toBe(autonomyTooltip(i18next.t.bind(i18next), mode));
      expect(chip.title).toContain(en.autonomy.desc[mode]);
    }
  });

  it('says what full-auto really is, wherever it is hovered', async () => {
    // the sentence the whole item exists for: the names alone never said that
    // full-auto is the CLI's bypassPermissions rather than a gentler cousin.
    // Said on CLAUDE since #1316: this session is on Claude.
    resetAisStoreForTests({ items: [], defaultId: 'claude-code' });
    try {
      const titles = [
        titled(await composerHost('full-auto', 'claude-code'), 'composer-autonomy').title,
      ];
      for (const tip of titles) {
        expect(tip).toContain('bypassPermissions');
        expect(tip).toContain('--dangerously-skip-permissions');
      }
    } finally {
      resetAisStoreForTests();
    }
  });

  it('says none of that to another AI (#1316)', async () => {
    resetAisStoreForTests({ items: [], defaultId: 'codex' });
    try {
      const titles = [titled(await composerHost('full-auto', 'codex'), 'composer-autonomy').title];
      for (const tip of titles) {
        expect(tip).toContain(en.autonomy.desc['full-auto']);
        expect(tip).not.toMatch(/claude|bypassPermissions/i);
      }
    } finally {
      resetAisStoreForTests();
    }
  });

  it('keeps the hover a DESCRIPTION, never the control name', async () => {
    // `title` on a button that has its own text content is the accessible
    // description, not the name — the shipped pattern (`Chip` in chrome.tsx).
    // An aria-label here would REPLACE "🛡 full-auto" with three sentences,
    // which is how a screen-reader user loses the label everyone else can see.
    const chip = titled(await composerHost('full-auto'), 'composer-autonomy');
    expect(chip.getAttribute('aria-label')).toBeNull();
    expect(chip.textContent).toContain('full-auto');
  });

  it("ask's copy no longer promises every call, and on Claude names the allow rules (#1434)", async () => {
    // The old copy said "every tool call comes to you first", which is false
    // for anyone whose Claude Code settings allow-list a tool: the CLI honours
    // those rules in ask mode, correctly, before Switchboard is consulted.
    const tip = titled(await composerHost('ask', 'claude-code'), 'composer-autonomy').title;
    expect(tip).not.toMatch(/every tool call comes to you/i);
    expect(tip).toContain("settings don't already allow");
    expect(tip).toContain(en.autonomy.claude.ask);
  });
});

/**
 * ALLOW-ALL ON THE CHIP (#1434). With "Allow all (this session)" in force main
 * answers every gated call Allow, silently, until the session restarts — and
 * the chip went on reading "ask". These pin that it no longer does. The way out
 * is the chip's menu since #1462 (below).
 */
describe('the mode chip while allow-all is on (#1434)', () => {
  beforeAll(async () => {
    await initI18nForTests();
    stubBridge();
  });
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    revokeStandingGrant.mockClear();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      }
    );
  });
  afterEach(async () => {
    await act(async () => {
      for (const r of roots.splice(0)) r.unmount();
    });
    document.body.innerHTML = '';
  });

  const ON = { allowAll: true, allowAllSince: Date.UTC(2026, 9, 23, 14, 2), files: ['c:/p/a.ts', 'c:/p/b.ts'] };

  it('reads "ask · allow all", never plain ask, with since-when, until-restart and the file count', async () => {
    const host = await composerHost('ask', undefined, { standingGrants: ON, onStopAllowAll: noop });
    const chip = titled(host, 'composer-autonomy');
    expect(chip.textContent).toBe('🛡 ask · allow all');
    expect(chip.dataset.allowAll).toBe('true');
    const t = i18next.t.bind(i18next);
    expect(chip.title.startsWith(allowAllTooltip(t, ON))).toBe(true);
    expect(chip.title).toContain(new Date(ON.allowAllSince).toLocaleTimeString(i18next.language, { timeStyle: 'short' }));
    expect(chip.title).toContain('until the session restarts');
    expect(chip.title).toContain('2 files are also always allowed');
    // ...and still says what the mode itself is, underneath
    expect(chip.title).toContain(en.autonomy.desc.ask);
  });

  it('reads plain ask once the grant is gone', async () => {
    const host = await composerHost('ask', undefined, {
      standingGrants: { allowAll: false, files: [] },
      onStopAllowAll: noop,
    });
    const chip = titled(host, 'composer-autonomy');
    expect(chip.textContent).toBe('🛡 ask');
    expect(chip.dataset.allowAll).toBeUndefined();
  });

  it('full-auto reads as itself — it already asks nothing', async () => {
    const host = await composerHost('full-auto', undefined, { standingGrants: ON, onStopAllowAll: noop });
    expect(titled(host, 'composer-autonomy').textContent).toBe('🛡 full-auto');
  });
});

/**
 * THE MODE MENU (#1462). Dan: the chip cycled blind on a click, and with
 * allow-all on it grew two extra buttons he found confusing. A click now always
 * opens a ticked list of the four modes, plus — only while allow-all is on — a
 * ticked "Allow all (this session)" row that takes it back.
 */
describe('the mode chip opens a ticked list of modes (#1462)', () => {
  beforeAll(async () => {
    await initI18nForTests();
    stubBridge();
  });
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      }
    );
  });
  afterEach(async () => {
    await act(async () => {
      for (const r of roots.splice(0)) r.unmount();
    });
    document.body.innerHTML = '';
  });

  const menuOf = (host: HTMLElement): HTMLElement | null =>
    host.querySelector<HTMLElement>('[data-testid="autonomy-menu"]');
  const modeRows = (host: HTMLElement): HTMLButtonElement[] =>
    Array.from(host.querySelectorAll<HTMLButtonElement>('[data-autonomy-row]'));
  const allowAllRow = (host: HTMLElement): HTMLButtonElement | null =>
    host.querySelector<HTMLButtonElement>('[data-testid="autonomy-menu-allow-all"]');
  const key = async (el: Element, k: string): Promise<void> => {
    await act(async () => {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
    });
  };

  it('a click opens the four modes in order, the current one ticked, and cycles nothing', async () => {
    const set = vi.fn();
    const host = await composerHost('plan', undefined, { onSetAutonomy: set });
    const chip = titled(host, 'composer-autonomy');
    expect(chip.getAttribute('aria-haspopup')).toBe('menu');
    expect(chip.getAttribute('aria-expanded')).toBe('false');
    expect(menuOf(host)).toBeNull();

    await act(async () => chip.click());
    expect(set).not.toHaveBeenCalled();
    expect(chip.getAttribute('aria-expanded')).toBe('true');
    expect(menuOf(host)!.querySelector('[role="menu"]')).not.toBeNull();
    const rows = modeRows(host);
    expect(rows.map((r) => r.dataset.autonomyRow)).toEqual([...AUTONOMIES]);
    expect(rows.map((r) => r.getAttribute('role'))).toEqual(Array(4).fill('menuitemradio'));
    expect(rows.map((r) => r.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false', 'false']);
    // the ✓ is drawn on the current row only, in its own column
    expect(rows[1].textContent).toBe(en.autonomy.menu.currentMark + en.autonomy.menu.name.plan);
    expect(rows[0].textContent).toBe(en.autonomy.menu.name.ask);
    // each row's hover says what the mode does
    const t = i18next.t.bind(i18next);
    rows.forEach((r, i) => expect(r.title).toBe(autonomyDescription(t, AUTONOMIES[i])));
    // the keyboard lands on the ticked row
    expect(document.activeElement).toBe(rows[1]);
    // no allow-all row while allow-all is off
    expect(allowAllRow(host)).toBeNull();
    // and the old inline buttons are gone for good
    expect(host.querySelector('[data-testid="composer-stop-allow-all"]')).toBeNull();
    expect(host.querySelector('[data-testid="composer-allow-all-change-mode"]')).toBeNull();
  });

  it('picking a row sets that mode and closes, focus back on the chip', async () => {
    const set = vi.fn();
    const host = await composerHost('ask', undefined, { onSetAutonomy: set });
    const chip = titled(host, 'composer-autonomy');
    await act(async () => chip.click());
    await act(async () => modeRows(host)[2].click());
    expect(set).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledWith('auto-edit');
    expect(menuOf(host)).toBeNull();
    expect(chip.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(chip);
  });

  it('picking the current mode only closes', async () => {
    const set = vi.fn();
    const host = await composerHost('full-auto', undefined, { onSetAutonomy: set });
    await act(async () => titled(host, 'composer-autonomy').click());
    await act(async () => modeRows(host)[3].click());
    expect(set).not.toHaveBeenCalled();
    expect(menuOf(host)).toBeNull();
  });

  it('a second click on the chip closes it', async () => {
    const host = await composerHost('ask', undefined, { onSetAutonomy: vi.fn() });
    const chip = titled(host, 'composer-autonomy');
    await act(async () => chip.click());
    expect(menuOf(host)).not.toBeNull();
    await act(async () => chip.click());
    expect(menuOf(host)).toBeNull();
  });

  it('Escape closes without changing anything, and gives the chip its focus back', async () => {
    const set = vi.fn();
    const host = await composerHost('ask', undefined, { onSetAutonomy: set });
    const chip = titled(host, 'composer-autonomy');
    await act(async () => chip.click());
    await key(document.activeElement!, 'Escape');
    expect(menuOf(host)).toBeNull();
    expect(set).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(chip);
  });

  it('arrows walk the rows and wrap; Enter on a row is its click', async () => {
    const set = vi.fn();
    const host = await composerHost('ask', undefined, { onSetAutonomy: set });
    await act(async () => titled(host, 'composer-autonomy').click());
    const rows = modeRows(host);
    expect(document.activeElement).toBe(rows[0]);
    await key(rows[0], 'ArrowDown');
    expect(document.activeElement).toBe(rows[1]);
    await key(rows[1], 'ArrowUp');
    await key(rows[0], 'ArrowUp');
    expect(document.activeElement).toBe(rows[3]);
    await key(rows[3], 'Home');
    expect(document.activeElement).toBe(rows[0]);
    // a native <button>: Enter and Space are its click, which is what we test
    await act(async () => rows[1].click());
    expect(set).toHaveBeenCalledWith('plan');
  });

  const ON = { allowAll: true, allowAllSince: Date.UTC(2026, 9, 23, 14, 2), files: [] };

  it('with allow-all on, the list ends with a ticked "Allow all (this session)" row that takes it back', async () => {
    const set = vi.fn();
    const stop = vi.fn();
    const host = await composerHost('ask', undefined, {
      standingGrants: ON,
      onStopAllowAll: stop,
      onSetAutonomy: set,
    });
    const chip = titled(host, 'composer-autonomy');
    await act(async () => chip.click());
    expect(modeRows(host)).toHaveLength(4);
    const row = allowAllRow(host)!;
    expect(row.getAttribute('role')).toBe('menuitemcheckbox');
    expect(row.getAttribute('aria-checked')).toBe('true');
    expect(row.textContent).toBe(en.autonomy.menu.currentMark + en.autonomy.menu.allowAll);
    // it is the LAST item in the menu
    const items = Array.from(menuOf(host)!.querySelectorAll('[role^="menuitem"]'));
    expect(items[items.length - 1]).toBe(row);
    await act(async () => row.click());
    expect(stop).toHaveBeenCalledTimes(1);
    expect(set).not.toHaveBeenCalled();
    expect(menuOf(host)).toBeNull();
    expect(document.activeElement).toBe(chip);
  });

  it('picking a mode while allow-all is on changes the mode and leaves allow-all alone', async () => {
    // Dan's call in the issue comment; his to flip
    const set = vi.fn();
    const stop = vi.fn();
    const host = await composerHost('ask', undefined, {
      standingGrants: ON,
      onStopAllowAll: stop,
      onSetAutonomy: set,
    });
    await act(async () => titled(host, 'composer-autonomy').click());
    await act(async () => modeRows(host)[1].click());
    expect(set).toHaveBeenCalledWith('plan');
    expect(stop).not.toHaveBeenCalled();
  });

  it('a revoke from ELSEWHERE closes the menu and puts focus back on the chip, not the page', async () => {
    const ctx = (grants: PanelContext['standingGrants']): PanelContext => ({
      sessionId: 'live-1',
      cardId: 'card-1',
      title: 'acme-web',
      visible: true,
      dockEpoch: 0,
      theme: 'nordic',
      colorScheme: 'dark',
      changed: 0,
      controlsLock: null,
      setView: () => {},
      autonomy: 'ask',
      onSetAutonomy: noop,
      standingGrants: grants,
      onStopAllowAll: noop,
    });
    const host = await mount(feedPanel.render(ctx(ON)));
    const chip = titled(host, 'composer-autonomy');
    await act(async () => chip.click());
    allowAllRow(host)!.focus();
    // the card menu's ✕ (or a toast) revoked it: main pushes the new set
    await act(async () => roots[roots.length - 1].render(feedPanel.render(ctx({ allowAll: false, files: [] }))));
    expect(menuOf(host)).toBeNull();
    expect(document.activeElement).toBe(chip);
    expect(chip.textContent).toBe('🛡 ask');
  });

  it("another card's grant ending leaves THIS card's open menu and its focus alone", async () => {
    // review: the focus check once asked "is focus in ANY mode menu", so card
    // A's grant dropping (a restart) pulled the keyboard out of card B's menu
    const ctx = (cardId: string, grants: PanelContext['standingGrants']): PanelContext => ({
      sessionId: `live-${cardId}`,
      cardId,
      title: cardId,
      visible: true,
      dockEpoch: 0,
      theme: 'nordic',
      colorScheme: 'dark',
      changed: 0,
      controlsLock: null,
      setView: () => {},
      autonomy: 'ask',
      onSetAutonomy: noop,
      standingGrants: grants,
      onStopAllowAll: noop,
    });
    await mount(feedPanel.render(ctx('A', ON)));
    const rootA = roots[roots.length - 1];
    const b = await mount(feedPanel.render(ctx('B', { allowAll: false, files: [] })));
    await act(async () => titled(b, 'composer-autonomy').click());
    const focused = document.activeElement;
    expect(menuOf(b)!.contains(focused)).toBe(true);
    await act(async () => rootA.render(feedPanel.render(ctx('A', { allowAll: false, files: [] }))));
    expect(menuOf(b)).not.toBeNull();
    expect(document.activeElement).toBe(focused);
  });
});
