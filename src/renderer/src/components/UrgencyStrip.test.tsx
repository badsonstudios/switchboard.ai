// @vitest-environment jsdom
// The component half of the urgency lamp's contrast promise (#267).
//
// tokens.drift.test.ts measures the RULES — `color: var(--lamp-ink)` over 12%
// (15% under the pointer) of `var(--lamp-hue)` mixed into `var(--panel2)`, for
// every ramp position in every shipped theme. Two things it cannot see are
// decided here:
//
//   1. WHICH pair each lamp receives. Swap the two lines in UrgencyStrip and a
//      needing lamp writes the raw hue on a wash of itself — the #221 defect
//      verbatim — with the whole drift suite still green.
//   2. WHAT IS BEHIND THE WASH. The rules mix into `var(--panel2)` because the
//      strip paints `--panel2`; move the strip onto some other surface and
//      every ratio the drift test computes becomes a fiction while staying
//      perfectly green. Same guard, and the same reason, as CollapsedStrip's.
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import ICU from 'i18next-icu';
import en from '../i18n/locales/en.json';
import { UrgencyStrip } from './UrgencyStrip';
import { RailSession } from '../model/types';
import { presentStatus, STATUS_TOKENS } from '../lib/rail-view';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

// ALL of them, not just the last: a test that mounts twice would otherwise
// leave a live root behind, and this component arms a setTimeout for the lamp
// beat — so a stray timer would outlive the test that created it the day one of
// these passes a non-empty urgency map.
let roots: Root[] = [];
const noop = (): void => {};

/** one session in whatever status is under test, and the lamp it produces */
async function mountLamp(status: string): Promise<HTMLElement> {
  const sessions: RailSession[] = [{ id: 'c1', title: 'switchboard', status }];
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => {
    root.render(
      <UrgencyStrip
        sessions={sessions}
        urgency={new Map<string, number>()}
        activeCardId="c1"
        onFocus={noop}
        onExpire={noop}
      />
    );
  });
  return host.querySelector<HTMLElement>('[data-urgency-lamp]')!;
}

beforeAll(async () => {
  if (!i18next.isInitialized) {
    await i18next
      .use(ICU)
      .use(initReactI18next)
      .init({
        lng: 'en',
        resources: { en: { translation: en } },
        interpolation: { escapeValue: false },
      });
  }
});

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  const mounted = roots;
  roots = [];
  await act(async () => {
    for (const r of mounted) r.unmount();
  });
  document.body.innerHTML = '';
});

describe('the urgency lamp hands the rules the pair they promise', () => {
  it.each(STATUS_TOKENS)('paints %s with that status’s ink, never its hue', async (token) => {
    const el = await mountLamp(token);
    expect(el.style.getPropertyValue('--lamp-ink')).toBe(`var(--status-${token}-ink)`);
    expect(el.style.getPropertyValue('--lamp-hue')).toBe(`var(--status-${token})`);
    expect(el.dataset.status).toBe(token);
  });

  it('folds the two statuses the ramp has no position for', async () => {
    // `starting` and `suspended` are real session states with no hue of their
    // own; both must still arrive as a real PAIR, or the lamp washes with an
    // undefined property and writes an undefined colour on it
    expect((await mountLamp('starting')).dataset.status).toBe(presentStatus('starting').token);
    const suspended = await mountLamp('suspended');
    expect(suspended.dataset.status).toBe('idle');
    expect(suspended.style.getPropertyValue('--lamp-ink')).toBe('var(--status-idle-ink)');
    expect(suspended.style.getPropertyValue('--lamp-hue')).toBe('var(--status-idle)');
    // suspended is not idle, and the lamp has to keep saying so — the fainter
    // dot ring is keyed off this attribute
    expect(suspended.dataset.suspended).toBe('true');
  });

  it('fails open on a status nobody has heard of', async () => {
    // §4: our blind spot reads as quiet, never as an alarm — and it is still a
    // real pair, so the lamp paints rather than resolving to nothing
    const el = await mountLamp('compacting');
    expect(el.dataset.status).toBe('idle');
    expect(el.style.getPropertyValue('--lamp-hue')).toBe('var(--status-idle)');
    expect(el.style.getPropertyValue('--lamp-ink')).toBe('var(--status-idle-ink)');
  });

  it('never writes a colour of its own — the stylesheet owns every state', async () => {
    // an inline `color` or `background` beats the :hover and state rules on
    // specificity, which is how the lamp would quietly leave the audit
    const el = await mountLamp('needs-permission');
    expect(el.style.color).toBe('');
    expect(el.style.background).toBe('');
    expect(el.style.backgroundColor).toBe('');
  });

  it('carries the session’s name, not only a colour', async () => {
    // legible before any colour is read (§5.20) — and it is what makes the lamp
    // TEXT, so its states owe 4.5:1 rather than 1.4.11's 3:1
    const el = await mountLamp('crashed');
    expect(el.querySelector('.urgency-name')?.textContent).toBe('switchboard');
  });
});

describe('the strip is the surface a lamp’s wash is measured against', () => {
  it('stays on --panel2', async () => {
    const el = await mountLamp('needs-permission');
    const strip = document.querySelector<HTMLElement>('[data-testid="urgency-strip"]')!;
    expect(strip.style.background).toBe('var(--panel2)');
    expect(strip.contains(el)).toBe(true);
  });

  it('paints nothing between itself and a lamp', async () => {
    // the lamps live in a scroller inside the strip. If that scroller ever
    // takes a background of its own, the wash sits on THAT, and `--panel2` in
    // the rules becomes a colour nobody sees through the lamp.
    const el = await mountLamp('needs-permission');
    const strip = document.querySelector<HTMLElement>('[data-testid="urgency-strip"]')!;
    for (let n = el.parentElement; n && n !== strip; n = n.parentElement) {
      expect(n.style.background, 'a layer between the strip and the lamp paints').toBe('');
      expect(n.style.backgroundColor).toBe('');
    }
  });
});
