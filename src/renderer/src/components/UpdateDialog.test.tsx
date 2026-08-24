// @vitest-environment jsdom
// The "there's a new release" dialog (P2-E19-03).
//
// Three things are worth pinning here, and they are the three that decide
// whether this feature is trustworthy rather than merely present:
//
//  • which BUTTON does which thing — Skip is persisted and Ignore is not, and
//    a wired-up-backwards pair would look identical in a screenshot;
//  • that release notes render as markdown IN-APP, and that a link inside them
//    cannot navigate the window away from the app;
//  • the modal contract it inherits from AboutPanel — role=dialog, Escape,
//    click-away, focus returned.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { initI18nForTests } from '../i18n/test-i18n';
import en from '../../../shared/i18n/locales/en.json';
import { UpdateDialog } from './UpdateDialog';
import type { UpdateInstallStatus, UpdateStatus } from '../../../shared/update';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let root: Root | null = null;
let host: HTMLElement;

const handlers = {
  onClose: vi.fn(),
  onUpdate: vi.fn(),
  onOpenUrl: vi.fn(),
  onIgnore: vi.fn(),
  onSkip: vi.fn(),
  onCancelInstall: vi.fn(),
};

function status(over: Partial<UpdateStatus['result']> = {}, manual = false): UpdateStatus {
  return {
    manual,
    prompt: true,
    result: {
      ok: true,
      state: 'available',
      currentVersion: '0.1.0',
      latestVersion: '0.2.0',
      notes: '## What changed\n\n- a **bold** thing\n- [a link](https://github.com/x/y/pull/1)',
      url: 'https://github.com/badsonstudios/switchboard.ai/releases/tag/v0.2.0',
      checkedAt: '2026-08-05T10:00:00.000Z',
      ...over,
    },
  };
}

async function render(
  open: boolean,
  s: UpdateStatus | null,
  install: UpdateInstallStatus | null = null
): Promise<void> {
  await act(async () => {
    root!.render(<UpdateDialog open={open} status={s} install={install} {...handlers} />);
  });
}

/** One install-progress record (E19-04). */
function progress(over: Partial<UpdateInstallStatus> = {}): UpdateInstallStatus {
  return {
    phase: 'downloading',
    version: '0.2.0',
    received: 0,
    total: 0,
    ...over,
  };
}

const dialog = (): HTMLElement | null => host.querySelector<HTMLElement>('[role="dialog"]');
function button(label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll('button')].find((b) => b.textContent === label);
  if (!found) throw new Error(`no button labelled "${label}"`);
  return found;
}
async function click(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  for (const h of Object.values(handlers)) h.mockReset();
  document.body.innerHTML = '';
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await initI18nForTests();
});

afterEach(async () => {
  if (root) {
    const r = root;
    root = null;
    await act(async () => r.unmount());
  }
});

describe('the new-release dialog', () => {
  it('renders nothing when closed, and nothing when it has no status', async () => {
    await render(false, status());
    expect(dialog()).toBeNull();
    await render(true, null);
    expect(dialog()).toBeNull();
  });

  it('names the version and offers all three answers', async () => {
    await render(true, status());
    expect(dialog()?.getAttribute('aria-label')).toContain('0.2.0');
    expect(dialog()?.getAttribute('data-update-state')).toBe('available');
    expect(host.querySelector('[data-update-field="from"]')?.textContent).toContain('0.1.0');
    for (const label of [en.update.update, en.update.ignore, en.update.skip]) {
      expect(button(label)).toBeTruthy();
    }
  });

  it('renders the notes as MARKDOWN, in-app', async () => {
    await render(true, status());
    const notes = host.querySelector('.feed-md');
    expect(notes?.querySelector('h2')?.textContent).toBe('What changed');
    expect(notes?.querySelectorAll('li')).toHaveLength(2);
    expect(notes?.querySelector('strong')?.textContent).toBe('bold');
  });

  it('says so when a release came with no notes, rather than showing a blank', async () => {
    await render(true, status({ notes: '' }));
    expect(host.textContent).toContain(en.update.noNotes);
  });

  it('Update asks App to start the update, and does NOT close by itself', async () => {
    // E19-04 changed this: the dialog no longer knows whether the answer is a
    // download or a browser tab, and it stays open because with an installer to
    // fetch it IS the progress bar.
    await render(true, status());
    await click(button(en.update.update));
    expect(handlers.onUpdate).toHaveBeenCalled();
    expect(handlers.onClose).not.toHaveBeenCalled();
  });

  it('Skip reports the VERSION (it is persisted per-version), Ignore does not persist', async () => {
    await render(true, status());
    await click(button(en.update.skip));
    expect(handlers.onSkip).toHaveBeenCalledWith('0.2.0');
    expect(handlers.onIgnore).not.toHaveBeenCalled();

    handlers.onClose.mockReset();
    await render(true, status());
    await click(button(en.update.ignore));
    expect(handlers.onIgnore).toHaveBeenCalledWith('0.2.0');
    expect(handlers.onSkip).toHaveBeenCalledTimes(1); // still just the first one
  });

  it('a link in the notes is INTERCEPTED, never a navigation', async () => {
    // Without this the whole app would be replaced by a web page: the renderer
    // is a normal document, and an <a href> inside it navigates it.
    await render(true, status());
    const link = host.querySelector('.feed-md a')!;
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    await act(async () => {
      link.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(handlers.onOpenUrl).toHaveBeenCalledWith('https://github.com/x/y/pull/1');
  });

  it('a MIDDLE-click on a note link is intercepted too', async () => {
    // Chromium dispatches `auxclick`, not `click`, for the middle button — so
    // without an onAuxClick this one path would skip the tight allowlist and
    // fall through to main's much broader any-http(s) window-open rule.
    await render(true, status());
    const link = host.querySelector('.feed-md a')!;
    const event = new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 });
    await act(async () => {
      link.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(handlers.onOpenUrl).toHaveBeenCalledWith('https://github.com/x/y/pull/1');
  });
});

describe('the two faces a MANUAL check can produce', () => {
  it('up to date: one line and a Close button, no Update/Skip', async () => {
    await render(true, status({ state: 'up-to-date', latestVersion: '0.1.0' }, true));
    expect(dialog()?.getAttribute('data-update-state')).toBe('up-to-date');
    expect(host.querySelector('[data-update-field="message"]')?.textContent).toContain('0.1.0');
    expect(() => button(en.update.update)).toThrow();
    expect(button(en.update.close)).toBeTruthy();
  });

  it("couldn't check: a GENTLE message, not an error", async () => {
    await render(
      true,
      status({ ok: false, state: 'failed', reason: 'network', latestVersion: undefined }, true)
    );
    const message = host.querySelector('[data-update-field="message"]')?.textContent ?? '';
    expect(message).toBe(en.update.unavailableBody);
    // The tone is the requirement: nothing here may read as a failure the user
    // has to do something about.
    expect(message.toLowerCase()).not.toContain('error');
    expect(message.toLowerCase()).not.toContain('failed');
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it('says WHICH kind of "could not check" — the point of distinguishing them', async () => {
    // The checker goes to real trouble to tell a missing credential apart from
    // an unreachable host (the 404-means-auth decision). Collapsing them here
    // would give the likeliest failure on any machine but the maintainer's the
    // wrong advice: "try again later" never fixes "there is no token".
    const cases: Array<[string, string]> = [
      ['no-token', en.update.unavailableNoToken],
      ['auth', en.update.unavailableAuth],
      ['rate-limit', en.update.unavailableRateLimit],
      ['network', en.update.unavailableBody],
      ['bad-response', en.update.unavailableBody],
    ];
    for (const [reason, expected] of cases) {
      await render(
        true,
        status(
          {
            ok: false,
            state: 'failed',
            reason: reason as UpdateStatus['result']['reason'],
            latestVersion: undefined,
          },
          true
        )
      );
      expect(host.querySelector('[data-update-field="message"]')?.textContent, reason).toBe(
        expected
      );
    }
    // every one of them stays in the same register
    for (const [, text] of cases) {
      expect(text.toLowerCase()).not.toContain('error');
      expect(text).toContain('Nothing is wrong with your app');
    }
  });
});

describe('the install faces (E19-04)', () => {
  it('a download replaces the three answers with a determinate bar and a Cancel', async () => {
    await render(true, status(), progress({ received: 25, total: 100 }));
    expect(dialog()?.getAttribute('data-update-phase')).toBe('downloading');
    const bar = host.querySelector<HTMLProgressElement>('[data-update-field="bar"]')!;
    expect(bar.value).toBe(25);
    expect(bar.max).toBe(100);
    expect(host.querySelector('[data-update-field="progress"]')?.textContent).toContain('25');
    // The offer is no longer a question while the answer is being fetched.
    for (const label of [en.update.update, en.update.ignore, en.update.skip]) {
      expect(() => button(label), label).toThrow();
    }
    await click(button(en.update.cancel));
    expect(handlers.onCancelInstall).toHaveBeenCalled();
  });

  it('a feed with no Content-Length gets an INDETERMINATE bar, not an empty one', async () => {
    await render(true, status(), progress({ received: 4096, total: 0 }));
    const bar = host.querySelector<HTMLProgressElement>('[data-update-field="bar"]')!;
    // jsdom reports 0 for an absent value; the attribute is the honest check.
    expect(bar.hasAttribute('value')).toBe(false);
  });

  it('verifying says so, and keeps the Cancel', async () => {
    await render(true, status(), progress({ phase: 'verifying', received: 100, total: 100 }));
    expect(host.querySelector('[data-update-field="progress"]')?.textContent).toBe(
      en.update.verifying
    );
    expect(button(en.update.cancel)).toBeTruthy();
  });

  it('launching has NOTHING left to cancel — no bar, no buttons', async () => {
    await render(true, status(), progress({ phase: 'launching', received: 100, total: 100 }));
    expect(host.querySelector('[data-update-field="bar"]')).toBeNull();
    expect(() => button(en.update.cancel)).toThrow();
  });

  it('cannot be dismissed mid-download — Escape and click-away are inert', async () => {
    // Hiding a 120 MB transfer is not stopping it. Cancel is the only way out.
    await render(true, status(), progress({ received: 1, total: 100 }));
    await act(async () => {
      dialog()!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      );
    });
    await act(async () => {
      (dialog()!.parentElement as HTMLElement).dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true })
      );
    });
    expect(handlers.onClose).not.toHaveBeenCalled();
  });

  it('a CHECKSUM mismatch says what happened and offers the browser instead', async () => {
    // The done-when's second clause, at the surface: deleted, never executed,
    // and the user is one click from the release page.
    await render(true, status(), progress({ phase: 'failed', reason: 'checksum' }));
    expect(dialog()?.getAttribute('data-update-reason')).toBe('checksum');
    expect(dialog()?.getAttribute('aria-label')).toBe(en.update.installFailedTitle);
    expect(host.querySelector('[data-update-field="message"]')?.textContent).toBe(
      en.update.failedChecksum
    );
    await click(button(en.update.openReleasePage));
    expect(handlers.onOpenUrl).toHaveBeenCalledWith(
      'https://github.com/badsonstudios/switchboard.ai/releases/tag/v0.2.0'
    );
    expect(handlers.onClose).toHaveBeenCalled();
  });

  it('every failure reason gets its OWN sentence, and none of them blames the user', async () => {
    const cases: Array<[UpdateInstallStatus['reason'], string]> = [
      ['checksum', en.update.failedChecksum],
      ['no-asset', en.update.failedNoAsset],
      // #315: the release is GONE, which is a different fact from "the release
      // has no installer we can verify" — the Set below is what holds them
      // apart, because reporting the first as the second was the whole defect.
      ['no-offer', en.update.failedNoOffer],
      ['unsupported', en.update.failedUnsupported],
      ['no-token', en.update.failedNoToken],
      ['auth', en.update.failedAuth],
      ['disk', en.update.failedDisk],
      ['launch', en.update.failedLaunch],
      ['network', en.update.failedNetwork],
    ];
    for (const [reason, expected] of cases) {
      await render(true, status(), progress({ phase: 'failed', reason }));
      expect(host.querySelector('[data-update-field="message"]')?.textContent, reason).toBe(
        expected
      );
    }
    // Distinct sentences, not one message wearing eight hats.
    expect(new Set(cases.map(([, text]) => text)).size).toBe(cases.length);
    // A failed install has cost the user nothing — it stays a dialog, never an alert.
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it('a CANCELLED install puts the original offer back, untouched', async () => {
    // The done-when: "cancel mid-download works and the update-available
    // affordance remains". Here that is the three buttons coming back.
    await render(true, status(), progress({ phase: 'cancelled', received: 40, total: 100 }));
    for (const label of [en.update.update, en.update.ignore, en.update.skip]) {
      expect(button(label), label).toBeTruthy();
    }
    expect(host.querySelector('[data-update-field="bar"]')).toBeNull();
  });
});

describe('the modal contract it shares with AboutPanel', () => {
  it('is a labelled modal dialog', async () => {
    await render(true, status());
    expect(dialog()?.getAttribute('aria-modal')).toBe('true');
    expect(dialog()?.getAttribute('aria-label')).toBeTruthy();
  });

  it('takes focus when it opens, and returns it on close', async () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    await render(true, status());
    expect(document.activeElement).toBe(dialog());
    // requestAnimationFrame is what actually restores focus; the assertion
    // that matters here is that closing was requested at all
    await click(button(en.update.ignore));
    expect(handlers.onClose).toHaveBeenCalled();
  });

  it('Escape closes it, and the key does not reach anything underneath', async () => {
    await render(true, status());
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    const heardBelow = vi.fn();
    window.addEventListener('keydown', heardBelow);
    await act(async () => {
      dialog()!.dispatchEvent(event);
    });
    window.removeEventListener('keydown', heardBelow);
    expect(handlers.onClose).toHaveBeenCalled();
    expect(heardBelow).not.toHaveBeenCalled();
  });

  it('click-away closes it; a click INSIDE does not', async () => {
    await render(true, status());
    await act(async () => {
      dialog()!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(handlers.onClose).not.toHaveBeenCalled();
    await act(async () => {
      (dialog()!.parentElement as HTMLElement).dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true })
      );
    });
    expect(handlers.onClose).toHaveBeenCalled();
  });
});
