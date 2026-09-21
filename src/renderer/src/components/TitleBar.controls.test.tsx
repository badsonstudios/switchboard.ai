// @vitest-environment jsdom
// What the title bar carries, and what it no longer does (#885 / #879).
//
// WHY THIS IS AN ASSERTION AND NOT A COMMENT
// ------------------------------------------
// The bar overflowed because controls arrived one at a time and nobody was
// counting. #885 took eight off it and the arithmetic is tight: ~983px of
// content in a 1009px bar at the width CI uses, with about 26px to spare. One
// chip back and it overflows again, and the failure mode is nasty and remote —
// a wrapped chip makes the bar taller, and in a short window those pixels come
// straight out of the conversation (`always-visible-notices.test.ts` carries
// that mechanism in full).
//
// So this file states BOTH halves, and it has to be both:
//
//  • the eight are GONE — otherwise the fix could be reverted silently;
//  • the five fast off-switches are STILL THERE — otherwise "I deleted the
//    wrong one" is a green test. Burying labels, sounds, speak, auto-trust or
//    notifications would break the very case they were made chips for (§5.11
//    litmus #4: the person who needs it off needs it off NOW, mid screen-share,
//    without hunting), and that would be a regression #885 CAUSED rather than a
//    tidy-up.
//
// The e2e half — that the row actually fits at 1024px and the page does not
// scroll sideways — is `e2e/chrome.spec.ts`. This is the cheap, fast half.
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { initI18nForTests } from '../i18n/test-i18n';
import en from '../../../shared/i18n/locales/en.json';
import { TitleBar } from './chrome';
import { UNKNOWN_BUILD_IDENTITY } from '../../../shared/build-identity';
import { builtinThemes } from '../theme/builtin-themes';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let root: Root | null = null;
let host: HTMLElement;
const noop = (): void => {};

async function bar(): Promise<void> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <TitleBar
        version="0.0.0-test"
        identity={UNKNOWN_BUILD_IDENTITY}
        onOpenAbout={noop}
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
        autoTrust={false}
        trustReaches
        onToggleTrust={noop}
        autoLabels
        onCycleLabels={noop}
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
  });
}

const labels = (): string[] =>
  [...host.querySelectorAll('button')].map((b) => b.textContent?.trim() ?? '');

beforeAll(async () => {
  await initI18nForTests();
});

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '';
});

afterEach(async () => {
  if (root) {
    const r = root;
    root = null;
    await act(async () => r.unmount());
  }
});

/** the eight that left, by the exact label each one carried */
const MOVED_TO_SETTINGS: ReadonlyArray<[string, string]> = [
  ['theme: system', en.theme.system],
  ['theme: nordic', en.theme.nordic],
  ['theme: daylight', en.theme.daylight],
  ['theme: high contrast', en.theme['high-contrast']],
  ['theme: soft contrast', en.theme['soft-contrast']],
  ['language: en', en.language.en],
  ['language: pseudo', en.language.pseudo],
  ['the experimental fork switch', en.titlebar.forkOff],
];

/** Four of the five that stayed, by the `data-testid` each one carries. The
 *  fifth — notifications — has no testId and is checked by its words below. */
const FAST_OFF_SWITCHES: ReadonlyArray<[string, string]> = [
  ['task labels', 'auto-labels'],
  ['session sounds', 'session-sounds'],
  ['spoken announcements', 'speak-announcements'],
  ['folder trust', 'auto-trust'],
];

describe('the eight controls #885 moved into Settings', () => {
  it.each(MOVED_TO_SETTINGS)('%s is no longer on the bar', async (_what, label) => {
    await bar();
    expect(
      labels(),
      'a control that moved into Settings is back on the title bar. The row ' +
        'has ~26px of slack at the 1024px CI uses; one more chip and it ' +
        'overflows again (#879)'
    ).not.toContain(label);
  });

  it('really is checking labels that exist somewhere — the fork chip proves it', async () => {
    // Guard against the whole list passing because `labels()` returned nothing
    // useful. Every string above is a real translation, and one of them (the
    // fork chip's OFF state) is the default the bar used to render.
    await bar();
    expect(labels().length).toBeGreaterThan(5);
    for (const [, label] of MOVED_TO_SETTINGS) expect(label.length).toBeGreaterThan(0);
  });

  it('offers no theme at all — not even one of the four, quietly left behind', async () => {
    await bar();
    for (const th of builtinThemes) {
      const name = (en.theme as Record<string, string>)[th.nameKey.replace('theme.', '')];
      expect(labels(), `${th.id} is still a title-bar chip`).not.toContain(name);
    }
  });
});

describe('the fast off-switches, which must NOT have moved', () => {
  it.each(FAST_OFF_SWITCHES)('%s is still one click away', async (_what, testId) => {
    await bar();
    expect(
      host.querySelector(`[data-testid="${testId}"]`),
      'a fast off-switch left the title bar. §5.11 litmus #4: the person who ' +
        'needs it off needs it off NOW, mid screen-share, without hunting — ' +
        'burying one of these is a regression, not a tidy-up'
    ).not.toBeNull();
  });

  it('notifications too, which has no testId but does have words', async () => {
    await bar();
    expect(labels()).toContain(en.titlebar.notifOff);
  });
});
