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
// TWO of the three surfaces are here. The card-header badge lives inside
// SessionGrid, whose tree is a live dockview, so it is covered the way the
// tab strip is (see `a11y-surfaces.test.tsx`'s note): by the pure test of the
// copy it renders, plus the hand-test in the dogfood tracker.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import i18next from 'i18next';
import { initI18nForTests } from '../i18n/test-i18n';
import en from '../i18n/locales/en.json';
import { TitleBar } from './chrome';
import { sessionPanels } from '../extensibility/panels';
import { PanelContext } from '../extensibility/contributions';
import { AUTONOMIES, autonomyTooltip } from '../lib/autonomy';
import { UNKNOWN_BUILD_IDENTITY } from '../../../shared/build-identity';

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

/** the title bar with everything but the autonomy question held constant */
function bar(autonomy: string): React.JSX.Element {
  return (
    <TitleBar
      version="0.0.0-test"
      identity={UNKNOWN_BUILD_IDENTITY}
      onOpenAbout={noop}
      pref="system"
      themes={[]}
      onTheme={noop}
      lang="en"
      onLang={noop}
      notifEnabled={false}
      onToggleNotif={noop}
      autonomy={autonomy}
      onCycleAutonomy={noop}
      presentationPolicy="always-visible"
      onCyclePresentationPolicy={noop}
      layoutMode="grid"
      layoutMaximized={false}
      onCycleLayoutMode={noop}
      layoutBinding="Ctrl+Alt+L"
      autoTrust={false}
      trustReaches={false}
      onToggleTrust={noop}
      autoLabels={true}
      onToggleAutoLabels={noop}
      soundsOn={false}
      onToggleSounds={noop}
      speakOn={false}
      onToggleSpeak={noop}
      railHidden={false}
      onToggleRail={noop}
      railBinding="Ctrl+B"
      onOpenPalette={noop}
      paletteBinding="Ctrl+K"
    />
  );
}

const feedPanel = sessionPanels.find((p) => p.id === 'feed')!;

function stubBridge(): void {
  (window as unknown as { switchboard: unknown }).switchboard = {
    transcripts: {
      blocks: () => Promise.resolve([]),
      onBlock: () => () => {},
      onReset: () => () => {},
    },
    sessions: { slashCommands: () => Promise.resolve([]) },
    workspace: { getUi: () => Promise.resolve({}), setUi: () => {} },
  };
}

/** the feed panel, whose composer carries this session's shield button */
async function composerHost(autonomy: string): Promise<HTMLElement> {
  const ctx: PanelContext = {
    sessionId: 'live-1',
    cardId: 'card-1',
    title: 'acme-web',
    visible: true,
    dockEpoch: 0,
    theme: 'nordic',
    colorScheme: 'dark',
    changed: 0,
    setView: () => {},
    autonomy,
    onCycleAutonomy: noop,
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

  it('explains the mode on the title-bar chip, for every mode', async () => {
    for (const mode of AUTONOMIES) {
      const host = await mount(bar(mode));
      const chip = titled(host, 'titlebar-autonomy');
      expect(chip.title).toBe(autonomyTooltip(i18next.t.bind(i18next), mode, 'workspace'));
      expect(chip.title).toContain(en.autonomy.desc[mode]);
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
    // full-auto is the CLI's bypassPermissions rather than a gentler cousin
    const titles = [
      titled(await mount(bar('full-auto')), 'titlebar-autonomy').title,
      titled(await composerHost('full-auto'), 'composer-autonomy').title,
    ];
    for (const tip of titles) {
      expect(tip).toContain('bypassPermissions');
      expect(tip).toContain('--dangerously-skip-permissions');
    }
  });

  it('keeps the hover a DESCRIPTION, never the control name', async () => {
    // `title` on a button that has its own text content is the accessible
    // description, not the name — the shipped pattern (`Chip` in chrome.tsx).
    // An aria-label here would REPLACE "🛡 full-auto" with three sentences,
    // which is how a screen-reader user loses the label everyone else can see.
    const chip = titled(await mount(bar('full-auto')), 'titlebar-autonomy');
    expect(chip.getAttribute('aria-label')).toBeNull();
    expect(chip.textContent).toContain('full-auto');
  });
});
