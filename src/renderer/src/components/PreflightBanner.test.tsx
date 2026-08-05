// @vitest-environment jsdom
// The preflight warning actually reaching a screen reader (issue 222).
//
// "claude CLI not found" is the message that explains why nothing in the app
// will start. It was rendered only once the answer came back and carried no
// live region, so it was announced to nobody — a warning that, for a
// screen-reader user, did not exist. DESIGN §5.26.
//
// What this holds: the region is in the document BEFORE there is anything to
// say, the words then land inside that same region rather than arriving with a
// freshly inserted one (which is the part a `role="status"` alone does not
// buy), and an empty region paints nothing.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act, StrictMode } from 'react';
import { createRoot, Root } from 'react-dom/client';
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from '../i18n/locales/en.json';
import { PreflightBanner } from './PreflightBanner';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

const WARNING = en.preflight.missingCli;

let root: Root | null = null;
let host: HTMLElement;

function region(): HTMLElement | null {
  return host.querySelector<HTMLElement>('[role="status"]');
}

/** render (or re-render) the banner exactly as App does */
async function render(shown: boolean, strict = false): Promise<void> {
  const tree = strict ? (
    <StrictMode>
      <PreflightBanner shown={shown} />
    </StrictMode>
  ) : (
    <PreflightBanner shown={shown} />
  );
  await act(async () => {
    root!.render(tree);
  });
}

describe('the preflight warning is announced (issue 222)', () => {
  beforeEach(async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    document.body.innerHTML = '';
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    if (!i18next.isInitialized) {
      await i18next.use(initReactI18next).init({
        lng: 'en',
        resources: { en: { translation: en } },
        interpolation: { escapeValue: false },
      });
    }
  });

  afterEach(async () => {
    if (root) {
      const r = root;
      root = null;
      await act(async () => r.unmount());
    }
  });

  it('has its live region up before the preflight answer lands', async () => {
    // preflight is an IPC round-trip that spawns `claude --version`; the app
    // renders long before it answers, and this is the frame that decides
    // whether the warning will ever be heard
    await render(false);
    expect(region()).not.toBeNull();
    expect(region()?.textContent).toBe('');
  });

  it('says the warning when the CLI is missing', async () => {
    await render(true);
    expect(region()?.textContent).toBe(WARNING);
  });

  it('puts the words INTO the region that was already there', async () => {
    // the whole point of the fix: a live region inserted together with its text
    // is announced by almost nothing. Node identity is what proves the region
    // was not replaced — swap the component back to a conditional render and
    // this is the assertion that fails
    await render(false);
    const before = region();
    expect(before).not.toBeNull();

    await render(true);
    expect(region()).toBe(before);
    expect(before?.textContent).toBe(WARNING);
  });

  it('lands its words as a second mutation even when it mounts already missing the CLI', async () => {
    // App's whole tree is behind a `!uiReady` gate, so this can mount with
    // `shown` already true — and inserting a live region that ALREADY holds its
    // text is the silent case this issue exists to kill. What a screen reader
    // actually watches is the mutation stream, so that is what is asserted: the
    // region arrives, and the words arrive afterwards, INTO it.
    const seen: MutationRecord[] = [];
    const obs = new MutationObserver((records) => seen.push(...records));
    obs.observe(host, { childList: true, subtree: true, characterData: true });
    await render(true);
    seen.push(...obs.takeRecords());
    obs.disconnect();

    const el = region();
    expect(el?.textContent).toBe(WARNING);
    const arrived = seen.findIndex((r) => [...r.addedNodes].includes(el as Node));
    const spoke = seen.findIndex(
      (r) => r.target === el && [...r.addedNodes].some((n) => n.textContent === WARNING)
    );
    expect(arrived, 'the region was never inserted on its own').toBeGreaterThanOrEqual(0);
    expect(spoke, 'the words came WITH the region — nothing would announce them').toBeGreaterThan(
      arrived
    );
  });

  it('keeps the region through StrictMode double-rendering', async () => {
    await render(false, true);
    const before = region();
    await render(true, true);
    expect(host.querySelectorAll('[role="status"]')).toHaveLength(1);
    expect(region()).toBe(before);
    expect(region()?.textContent).toBe(WARNING);
  });

  it('paints nothing while it has nothing to say', async () => {
    // an always-mounted region must not become an always-visible orange strip:
    // the fill lives on .preflight-banner (#206) and is applied only with the
    // words, so an empty region is a zero-height box
    await render(false);
    expect(region()?.className).toBe('');
    expect(region()?.hasChildNodes()).toBe(false);

    await render(true);
    expect(region()?.className).toBe('preflight-banner');
  });

  it('goes quiet again — and keeps its region — when the CLI turns up', async () => {
    await render(true);
    const shownRegion = region();
    await render(false);
    expect(region()).toBe(shownRegion);
    expect(region()?.textContent).toBe('');
    expect(region()?.className).toBe('');
  });
});

describe('the app renders the banner unconditionally (issue 222)', () => {
  // Half of the fix lives in App.tsx — where the old
  // `{!preflightOk && <PreflightBanner />}` is exactly the mistake being
  // undone. The component's own one-commit deferral (tested above) means a
  // conditional render would no longer be SILENT, but it would still put the
  // region up only at the moment it matters, instead of from the first frame.
  // Read out of the source because App itself is not mountable here.
  it('never puts the banner behind a && in App.tsx', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const app = fs.readFileSync(path.join(__dirname, '..', 'App.tsx'), 'utf8');
    const sites = app.match(/[^\n]*<PreflightBanner[^\n]*/g) ?? [];
    expect(sites, 'App.tsx must render the preflight banner').toHaveLength(1);
    expect(sites[0]).toContain('shown=');
    expect(sites[0]).not.toMatch(/&&|\?/);
  });
});
