// @vitest-environment jsdom
// The trust chip, as a rendered contract (#397).
//
// The rule that decides IS the chip inert lives in `lib/trust-reach.ts` and is
// tested there. What only a rendered test can claim is the part the user meets:
// that "inert" is real disablement and not grey paint, that the reason is on
// the element rather than only in a comment, and — the one that matters most —
// that a persisted 🔒 ask trust is still SHOWN and never rewritten just because
// we decided it could not do anything today.
//
// The keyboard claim is here for the same reason: `disabled` would have been
// the one-word version, and it would have taken the chip out of the tab order,
// putting the explanation somewhere a keyboard user cannot reach it. That is a
// regression a styling tidy-up could reintroduce without noticing, so it is an
// assertion.
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { initI18nForTests } from '../i18n/test-i18n';
import en from '../../../shared/i18n/locales/en.json';
import { TitleBar } from './chrome';
import { UNKNOWN_BUILD_IDENTITY } from '../../../shared/build-identity';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let root: Root | null = null;

async function mount(tree: React.ReactNode): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(tree);
  });
  return host;
}

const noop = (): void => {};

/** the title bar with everything but the trust question held constant */
async function bar(opts: {
  autoTrust: boolean;
  trustReaches: boolean;
  onToggleTrust?: () => void;
}): Promise<HTMLElement> {
  return mount(
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
      autonomy="ask"
      onCycleAutonomy={noop}
      presentationPolicy="always-visible"
      onCyclePresentationPolicy={noop}
      layoutMode="grid"
      layoutMaximized={false}
      onCycleLayoutMode={noop}
      layoutBinding="Ctrl+Alt+L"
      autoTrust={opts.autoTrust}
      trustReaches={opts.trustReaches}
      onToggleTrust={opts.onToggleTrust ?? noop}
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

function trustChip(host: HTMLElement): HTMLButtonElement {
  const el = host.querySelector<HTMLButtonElement>('[data-testid="auto-trust"]');
  if (!el) throw new Error('the trust chip is not on screen at all');
  return el;
}

describe('the trust chip', () => {
  beforeAll(async () => {
    await initI18nForTests();
  });
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterEach(async () => {
    await act(async () => root?.unmount());
    root = null;
    document.body.innerHTML = '';
  });

  describe('when no session can be asked (all-Direct workspace)', () => {
    it('is disabled, with the reason on the element', async () => {
      const chip = trustChip(await bar({ autoTrust: true, trustReaches: false }));
      expect(chip.getAttribute('aria-disabled')).toBe('true');
      expect(chip.getAttribute('title')).toBe(en.titlebar.trustInert);
      // the reason names the transport and the way out, not just "unavailable"
      expect(en.titlebar.trustInert).toMatch(/Terminal/);
    });

    it('stays reachable from the keyboard', async () => {
      const chip = trustChip(await bar({ autoTrust: true, trustReaches: false }));
      // `disabled` would take it out of the tab order, and a control a keyboard
      // user cannot reach is one they cannot find out about. `title` is the
      // accessible DESCRIPTION here (the name comes from the button's text), so
      // assistive tech reads the reason out on arrival — Chromium still will
      // not draw the native tooltip on focus, which is a gap this does not
      // close and no surface in the app closes yet.
      expect(chip.disabled).toBe(false);
      expect(chip.hasAttribute('disabled')).toBe(false);
    });

    it('does not toggle when clicked', async () => {
      let toggles = 0;
      const chip = trustChip(
        await bar({ autoTrust: true, trustReaches: false, onToggleTrust: () => (toggles += 1) })
      );
      await act(async () => {
        chip.click();
      });
      expect(toggles).toBe(0);
    });

    it('still SHOWS a persisted 🔒 ask trust — disabling hides capability, not state', async () => {
      // The whole failure mode this guards: quietly presenting the setting as
      // auto-trust (or writing that value) because it cannot take effect. The
      // user's answer to a security question survives our discovery that the
      // CLI ignores it.
      const chip = trustChip(await bar({ autoTrust: false, trustReaches: false }));
      expect(chip.textContent).toBe(en.titlebar.trustOff);
      expect(chip.getAttribute('aria-disabled')).toBe('true');
    });
  });

  describe('when a session will spawn on the Terminal', () => {
    it('is enabled and carries its ordinary hint', async () => {
      const chip = trustChip(await bar({ autoTrust: true, trustReaches: true }));
      expect(chip.getAttribute('aria-disabled')).toBeNull();
      expect(chip.getAttribute('title')).toBe(en.titlebar.trustHint);
    });

    it('toggles on click, in both directions', async () => {
      for (const autoTrust of [true, false]) {
        let toggles = 0;
        const chip = trustChip(
          await bar({ autoTrust, trustReaches: true, onToggleTrust: () => (toggles += 1) })
        );
        await act(async () => {
          chip.click();
        });
        expect(toggles).toBe(1);
        await act(async () => root?.unmount());
        root = null;
        document.body.innerHTML = '';
      }
    });

    it('shows whichever state is stored', async () => {
      expect(trustChip(await bar({ autoTrust: true, trustReaches: true })).textContent).toBe(
        en.titlebar.trustOn
      );
      await act(async () => root?.unmount());
      root = null;
      document.body.innerHTML = '';
      expect(trustChip(await bar({ autoTrust: false, trustReaches: true })).textContent).toBe(
        en.titlebar.trustOff
      );
    });
  });
});
