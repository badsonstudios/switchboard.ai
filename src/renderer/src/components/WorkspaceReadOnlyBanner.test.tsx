// @vitest-environment jsdom
// The read-only notice reaching a POPPED-OUT window (issue 208).
//
// #168 put the notice in the main window's chrome. A popout is its own
// document with none of that chrome in it, so a user who works the whole run in
// one — which is what popping out is for — was told nothing at all, which is
// the exact silent data loss #168 exists to prevent.
//
// What this holds: the notice follows a popout in and out, says the same words
// as the main window, and appears only when there is something to say. The
// popouts here are real iframes — a separate document AND a separate window
// object, which is what a portal into another window actually needs.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act, StrictMode } from 'react';
import { createRoot, Root } from 'react-dom/client';
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from '../i18n/locales/en.json';
import { WorkspaceReadOnlyBanner } from './WorkspaceReadOnlyBanner';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

const TITLE = en.workspace.readOnlyTitle;

/** a popout: its own window and document, exactly like the real thing */
function openPopout(): Window {
  const frame = document.createElement('iframe');
  document.body.appendChild(frame);
  const win = frame.contentWindow as Window;
  win.document.write('<!doctype html><html><body></body></html>');
  win.document.close();
  return win;
}

/** what SessionGrid publishes when dockview opens or closes a popout */
async function announce(kind: 'added' | 'removed', win: Window): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new CustomEvent(`switchboard:popout-${kind}`, { detail: win }));
  });
}

function noticeIn(win: Window): HTMLElement | null {
  return win.document.body.querySelector<HTMLElement>('[role="status"]');
}

let root: Root | null = null;

/** mount the banner over a workspace that answers `readOnly` when it answers */
async function mountBanner(
  readOnly: boolean | Promise<boolean>,
  strict = false
): Promise<void> {
  (window as unknown as { switchboard: unknown }).switchboard = {
    workspace: { isReadOnly: () => Promise.resolve(readOnly) },
  };
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const tree = strict ? (
    <StrictMode>
      <WorkspaceReadOnlyBanner />
    </StrictMode>
  ) : (
    <WorkspaceReadOnlyBanner />
  );
  await act(async () => {
    root!.render(tree);
  });
}

describe('the read-only notice in a popped-out window (issue 208)', () => {
  beforeEach(async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    document.body.innerHTML = '';
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

  it('says the same thing there as it does in the main window', async () => {
    await mountBanner(true);
    const popout = openPopout();
    await announce('added', popout);

    expect(noticeIn(popout)?.textContent).toContain(TITLE);
    expect(noticeIn(window)?.textContent).toContain(TITLE);
  });

  it('makes room for itself instead of landing under the session', async () => {
    // the notice's slot is the top of the document, and the body flag is what
    // popout.html's stylesheet keys off to shrink dockview's container to fit
    await mountBanner(true);
    const popout = openPopout();
    await announce('added', popout);

    const host = popout.document.body.firstElementChild;
    expect(host?.hasAttribute('data-sb-banner-host')).toBe(true);
    expect(host?.contains(noticeIn(popout))).toBe(true);
    expect(popout.document.body.hasAttribute('data-sb-banner')).toBe(true);
  });

  it('stays out of a popout when the workspace saves normally', async () => {
    await mountBanner(false);
    const popout = openPopout();
    await announce('added', popout);

    expect(noticeIn(popout)).toBeNull();
    expect(popout.document.body.hasAttribute('data-sb-banner')).toBe(false);
  });

  it('reaches every popout, once each', async () => {
    await mountBanner(true);
    const first = openPopout();
    const second = openPopout();
    await announce('added', first);
    await announce('added', second);
    // dockview re-announces a window when the same group is popped out again
    await announce('added', first);

    for (const win of [first, second]) {
      expect(win.document.body.querySelectorAll('[role="status"]')).toHaveLength(1);
      expect(noticeIn(win)?.textContent).toContain(TITLE);
    }
  });

  it('catches a popout that opened before the answer landed', async () => {
    // Why the popouts are tracked whether or not the workspace is read-only:
    // `isReadOnly()` is an IPC round-trip, and at boot a restored popout can
    // open inside it. Gate the subscription on the answer and that window is
    // never heard of again — the one window the user restored on purpose.
    let answer: (ro: boolean) => void = () => {};
    await mountBanner(new Promise<boolean>((resolve) => (answer = resolve)));
    const popout = openPopout();
    await announce('added', popout);
    expect(noticeIn(popout)).toBeNull(); // nothing to say yet

    await act(async () => answer(true));
    expect(noticeIn(popout)?.textContent).toContain(TITLE);
  });

  it('draws one notice per popout under StrictMode', async () => {
    // dev runs every effect twice; a mount/unmount/mount that left two hosts
    // (or removed the only one) would show up here and nowhere else
    await mountBanner(true, true);
    const popout = openPopout();
    await announce('added', popout);

    expect(popout.document.body.querySelectorAll('[data-sb-banner-host]')).toHaveLength(1);
    expect(popout.document.body.hasAttribute('data-sb-banner')).toBe(true);
    expect(noticeIn(popout)?.textContent).toContain(TITLE);
  });

  it('takes itself out again when the window is docked back', async () => {
    await mountBanner(true);
    const popout = openPopout();
    await announce('added', popout);
    await announce('removed', popout);

    expect(noticeIn(popout)).toBeNull();
    expect(popout.document.body.querySelectorAll('[data-sb-banner-host]')).toHaveLength(0);
    // and the layout override goes with it — a re-used window must not keep a
    // flex column with nothing in it
    expect(popout.document.body.hasAttribute('data-sb-banner')).toBe(false);
    // the main window's own notice is untouched by any of this (#168)
    expect(noticeIn(window)?.textContent).toContain(TITLE);
  });
});
