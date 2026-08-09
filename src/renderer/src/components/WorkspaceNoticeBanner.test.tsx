// @vitest-environment jsdom
// The workspace notice: reaching a POPPED-OUT window (issue 208), and the
// failing-save half that has to CLEAR itself again (issue 207).
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
import ICU from 'i18next-icu';
import { initReactI18next } from 'react-i18next';
import type { WorkspaceSaveState } from '../../../shared/workspace';
import en from '../i18n/locales/en.json';
import { WorkspaceNoticeBanner } from './WorkspaceNoticeBanner';
import { addPopoutWindow, removePopoutWindow, resetPopoutWindows } from '../lib/popout-windows';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

const TITLE = en.workspace.readOnlyTitle;
const SAVE_TITLE = en.workspace.saveFailedTitle;
const WS_FILE = '/home/someone/.config/switchboard/workspace.json';

/** a popout: its own window and document, exactly like the real thing */
function openPopout(): Window {
  const frame = document.createElement('iframe');
  document.body.appendChild(frame);
  const win = frame.contentWindow as Window;
  win.document.write('<!doctype html><html><body></body></html>');
  win.document.close();
  return win;
}

/** what SessionGrid tells the shared registry when dockview opens/closes a popout */
async function announce(kind: 'added' | 'removed', win: Window): Promise<void> {
  await act(async () => {
    if (kind === 'added') addPopoutWindow(win);
    else removePopoutWindow(win);
  });
}

function noticeIn(win: Window): HTMLElement | null {
  return win.document.body.querySelector<HTMLElement>('[role="status"]');
}

let root: Root | null = null;
/** main's push channel, captured so a test can be the store changing its mind */
let pushSaveState: ((s: WorkspaceSaveState) => void) | null = null;

interface BridgeOpts {
  readOnly?: boolean | Promise<boolean>;
  /** what `workspace:saveState` answers the mounting window */
  saveState?: WorkspaceSaveState | Promise<WorkspaceSaveState>;
}

/** mount the banner over a workspace that answers what the test asked for */
async function mountBanner(opts: BridgeOpts = {}, strict = false): Promise<void> {
  const { readOnly = false, saveState = { failing: false, file: WS_FILE } } = opts;
  pushSaveState = null;
  (window as unknown as { switchboard: unknown }).switchboard = {
    workspace: {
      isReadOnly: () => Promise.resolve(readOnly),
      saveState: () => Promise.resolve(saveState),
      onSaveStateChanged: (cb: (s: WorkspaceSaveState) => void) => {
        pushSaveState = cb;
        return () => {
          pushSaveState = null;
        };
      },
    },
  };
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const tree = strict ? (
    <StrictMode>
      <WorkspaceNoticeBanner />
    </StrictMode>
  ) : (
    <WorkspaceNoticeBanner />
  );
  await act(async () => {
    root!.render(tree);
  });
}

/** main telling the window saving just started (or stopped) failing */
async function push(failing: boolean): Promise<void> {
  await act(async () => pushSaveState?.({ failing, file: WS_FILE }));
}

beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '';
  resetPopoutWindows(); // module state; outlives a test
  if (!i18next.isInitialized) {
    // ICU, exactly as `i18n/index.ts` initialises it. NOT optional here, and
    // this file learned it the hard way: with an `i18nFormat` plugin installed
    // i18next hands the whole string to ICU and never runs its own `{{…}}`
    // interpolator, so a key written in the wrong dialect renders its
    // placeholder verbatim to the user. A harness without ICU cannot see that
    // — it was green on a banner that said "…failing to write {{file}}".
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

afterEach(async () => {
  if (root) {
    const r = root;
    root = null;
    await act(async () => r.unmount());
  }
  resetPopoutWindows(); // after the unmount, so nothing is subscribed to hear it
});

describe('the read-only notice in a popped-out window (issue 208)', () => {
  it('says the same thing there as it does in the main window', async () => {
    await mountBanner({ readOnly: true });
    const popout = openPopout();
    await announce('added', popout);

    expect(noticeIn(popout)?.textContent).toContain(TITLE);
    expect(noticeIn(window)?.textContent).toContain(TITLE);
  });

  it('makes room for itself instead of landing under the session', async () => {
    // the notice's slot is the top of the document, and the body flag is what
    // popout.html's stylesheet keys off to shrink dockview's container to fit
    await mountBanner({ readOnly: true });
    const popout = openPopout();
    await announce('added', popout);

    const host = popout.document.body.firstElementChild;
    expect(host?.hasAttribute('data-sb-banner-host')).toBe(true);
    expect(host?.contains(noticeIn(popout))).toBe(true);
    expect(popout.document.body.hasAttribute('data-sb-banner')).toBe(true);
  });

  it('stays out of a popout when the workspace saves normally', async () => {
    await mountBanner();
    const popout = openPopout();
    await announce('added', popout);

    expect(noticeIn(popout)).toBeNull();
    expect(popout.document.body.hasAttribute('data-sb-banner')).toBe(false);
  });

  it('reaches every popout, once each', async () => {
    await mountBanner({ readOnly: true });
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
    await mountBanner({ readOnly: new Promise<boolean>((resolve) => (answer = resolve)) });
    const popout = openPopout();
    await announce('added', popout);
    expect(noticeIn(popout)).toBeNull(); // nothing to say yet

    await act(async () => answer(true));
    expect(noticeIn(popout)?.textContent).toContain(TITLE);
  });

  it('draws one notice per popout under StrictMode', async () => {
    // dev runs every effect twice; a mount/unmount/mount that left two hosts
    // (or removed the only one) would show up here and nowhere else
    await mountBanner({ readOnly: true }, true);
    const popout = openPopout();
    await announce('added', popout);

    expect(popout.document.body.querySelectorAll('[data-sb-banner-host]')).toHaveLength(1);
    expect(popout.document.body.hasAttribute('data-sb-banner')).toBe(true);
    expect(noticeIn(popout)?.textContent).toContain(TITLE);
  });

  it('takes itself out again when the window is docked back', async () => {
    await mountBanner({ readOnly: true });
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

// The half #168 never needed: this condition ENDS, so the notice has to as
// well — and it arrives mid-run, so it can only reach the window by a push.
describe('the failing-save notice (issue 207)', () => {
  it('says nothing while saving works', async () => {
    await mountBanner();
    expect(noticeIn(window)?.textContent).toBe('');
    // the live region is there and empty, which is what makes the text below
    // audible when it lands — a role=status that arrives WITH its words is
    // announced by almost nothing
    expect(noticeIn(window)).not.toBeNull();
  });

  it('appears when main says saving started failing, naming the file', async () => {
    await mountBanner();
    await push(true);

    const text = noticeIn(window)?.textContent ?? '';
    expect(text).toContain(SAVE_TITLE);
    // the one actionable fact the renderer cannot work out for itself
    expect(text).toContain(WS_FILE);
  });

  it('goes away again when saving recovers', async () => {
    await mountBanner();
    await push(true);
    expect(noticeIn(window)?.textContent).toContain(SAVE_TITLE);

    await push(false);
    expect(noticeIn(window)?.textContent).toBe('');
    // the region itself stays — it is how the NEXT thing gets announced
    expect(noticeIn(window)).not.toBeNull();
  });

  it('is already up for a window that opens mid-failure', async () => {
    // there is no push to hear: it happened before this window existed. The
    // read at mount is the only thing standing between that user and silence.
    await mountBanner({ saveState: { failing: true, file: WS_FILE } });
    expect(noticeIn(window)?.textContent).toContain(SAVE_TITLE);
  });

  it('ignores an initial read that a push has already overtaken', async () => {
    // the read is a round-trip and saving can start failing inside it; the
    // push is newer by construction, so a late "all fine" must not undo it
    let answer: (s: WorkspaceSaveState) => void = () => {};
    await mountBanner({
      saveState: new Promise<WorkspaceSaveState>((resolve) => (answer = resolve)),
    });
    await push(true);
    expect(noticeIn(window)?.textContent).toContain(SAVE_TITLE);

    await act(async () => answer({ failing: false, file: WS_FILE }));
    expect(noticeIn(window)?.textContent).toContain(SAVE_TITLE);
  });

  it('reaches a popout, and leaves it when saving recovers', async () => {
    await mountBanner();
    const popout = openPopout();
    await announce('added', popout);
    expect(noticeIn(popout)).toBeNull();

    await push(true);
    expect(noticeIn(popout)?.textContent).toContain(SAVE_TITLE);
    expect(popout.document.body.hasAttribute('data-sb-banner')).toBe(true);

    await push(false);
    expect(noticeIn(popout)).toBeNull();
    // the host element and the popout's layout override go too, or the session
    // below keeps making room for a notice that is no longer there
    expect(popout.document.body.querySelectorAll('[data-sb-banner-host]')).toHaveLength(0);
    expect(popout.document.body.hasAttribute('data-sb-banner')).toBe(false);
  });

  it('lets the read-only notice keep the slot', async () => {
    // They cannot really co-occur — a read-only store attempts no writes, so
    // its writes cannot fail — but if they ever did, the permanent condition is
    // the one worth the user's attention.
    await mountBanner({ readOnly: true });
    await push(true);
    const text = noticeIn(window)?.textContent ?? '';
    expect(text).toContain(TITLE);
    expect(text).not.toContain(SAVE_TITLE);
  });

  it('survives a preload that has never heard of the channel', async () => {
    // fail-open: an older preload, or none at all. A missing notice is bad; a
    // renderer that dies drawing one is worse.
    (window as unknown as { switchboard: unknown }).switchboard = { workspace: {} };
    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(<WorkspaceNoticeBanner />);
    });
    expect(noticeIn(window)).not.toBeNull();
    expect(noticeIn(window)?.textContent).toBe('');
  });
});
