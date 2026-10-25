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
import { allowAllTooltip, AUTONOMIES, autonomyTooltip } from '../lib/autonomy';
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
      presentationPolicy="always-visible"
      onCyclePresentationPolicy={noop}
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
    onCycleAutonomy: noop,
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
      expect(chip.title).toBe(autonomyTooltip(i18next.t.bind(i18next), mode, 'session'));
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
 * the chip went on reading "ask". These pin that it no longer does, and that
 * the way out is one click from the chip.
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
    expect(chip.title.startsWith(allowAllTooltip(t, ON, 'session'))).toBe(true);
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

  it('a click offers Stop allowing all instead of cycling, and Stop calls the revoke', async () => {
    const cycle = vi.fn();
    const stop = vi.fn();
    const host = await composerHost('ask', undefined, {
      standingGrants: ON,
      onStopAllowAll: stop,
      onCycleAutonomy: cycle,
    });
    const chip = titled(host, 'composer-autonomy');
    expect(host.querySelector('[data-testid="composer-allow-all-choice"]')).toBeNull();
    await act(async () => chip.click());
    expect(cycle).not.toHaveBeenCalled();
    expect(chip.getAttribute('aria-expanded')).toBe('true');
    const stopBtn = titled(host, 'composer-stop-allow-all');
    expect(stopBtn.textContent).toBe(en.autonomy.allowAll.stop);
    await act(async () => stopBtn.click());
    expect(stop).toHaveBeenCalledTimes(1);
    // the choice closes, and focus goes back to the chip rather than the body
    expect(host.querySelector('[data-testid="composer-allow-all-choice"]')).toBeNull();
    expect(document.activeElement).toBe(chip);
  });

  it('Change mode is still there, and cycles', async () => {
    const cycle = vi.fn();
    const host = await composerHost('ask', undefined, {
      standingGrants: ON,
      onStopAllowAll: noop,
      onCycleAutonomy: cycle,
    });
    await act(async () => titled(host, 'composer-autonomy').click());
    const change = titled(host, 'composer-allow-all-change-mode');
    expect(change.textContent).toContain('plan');
    await act(async () => change.click());
    expect(cycle).toHaveBeenCalledTimes(1);
  });

  it('a revoke from ELSEWHERE closes the choice and puts focus back on the chip, not the page', async () => {
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
      onCycleAutonomy: noop,
      standingGrants: grants,
      onStopAllowAll: noop,
    });
    const host = await mount(feedPanel.render(ctx(ON)));
    const chip = titled(host, 'composer-autonomy');
    await act(async () => chip.click());
    titled(host, 'composer-stop-allow-all').focus();
    expect(chip.getAttribute('aria-controls')).toBe(titled(host, 'composer-allow-all-choice').id);
    // the card menu's ✕ (or a toast) revoked it: main pushes the new set
    await act(async () => roots[roots.length - 1].render(feedPanel.render(ctx({ allowAll: false, files: [] }))));
    expect(host.querySelector('[data-testid="composer-allow-all-choice"]')).toBeNull();
    expect(document.activeElement).toBe(chip);
    expect(chip.textContent).toBe('🛡 ask');
  });

  it('Escape on the chip closes the choice too', async () => {
    const host = await composerHost('ask', undefined, { standingGrants: ON, onStopAllowAll: noop });
    const chip = titled(host, 'composer-autonomy');
    await act(async () => chip.click());
    await act(async () => {
      chip.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(host.querySelector('[data-testid="composer-allow-all-choice"]')).toBeNull();
  });

  it('full-auto reads as itself — it already asks nothing', async () => {
    const host = await composerHost('full-auto', undefined, { standingGrants: ON, onStopAllowAll: noop });
    expect(titled(host, 'composer-autonomy').textContent).toBe('🛡 full-auto');
  });
});
