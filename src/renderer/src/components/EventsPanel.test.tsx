// @vitest-environment jsdom
// The events panel's update notice (P2-E19-04).
//
// The panel's rows, ordering and a11y are covered by `a11y-surfaces.test.tsx`
// and `feed.spec.ts`; this file is only about the one non-modal surface the
// update feature owns — and about the distinction that makes it honest:
//
//   • **installed** — the post-update handshake. News, dismissible, no action.
//   • **available** — the offer is still standing after the dialog was closed
//     without being answered. That is the item's "the persistent update
//     available affordance remains", and it is the panel's job because a
//     modal that reopens itself is not an affordance, it is a nag.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { initI18nForTests } from '../i18n/test-i18n';
import en from '../i18n/locales/en.json';
import { EventsPanel } from './EventsPanel';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let root: Root | null = null;
let host: HTMLElement;

const handlers = {
  onUpdateNow: vi.fn(),
  onDismissUpdateNotice: vi.fn(),
};

async function render(
  notice: { kind: 'installed' | 'available'; version: string } | null
): Promise<void> {
  await act(async () => {
    root!.render(
      <EventsPanel
        sessions={[]}
        events={[]}
        queueEvents={[]}
        visited={new Set<number>()}
        onFocus={() => {}}
        onVisit={() => {}}
        queueBinding="Ctrl+Space"
        updateNotice={notice}
        {...handlers}
      />
    );
  });
}

const notice = (): HTMLElement | null => host.querySelector<HTMLElement>('[data-events-notice]');
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

describe('the update notice', () => {
  it('shows nothing at all when there is no notice', async () => {
    await render(null);
    expect(notice()).toBeNull();
    // …and the panel still says it is empty, rather than looking occupied
    expect(host.textContent).toContain(en.events.empty);
  });

  it('the post-update handshake names the version and only offers "got it"', async () => {
    await render({ kind: 'installed', version: '0.2.0' });
    expect(notice()?.getAttribute('data-events-notice')).toBe('installed');
    expect(notice()?.textContent).toContain('0.2.0');
    // Nothing to do — the update already happened.
    expect(() => button(en.events.updateNow)).toThrow();
    await click(button(en.events.gotIt));
    expect(handlers.onDismissUpdateNotice).toHaveBeenCalled();
  });

  it('a standing offer keeps a way back INTO the dialog', async () => {
    await render({ kind: 'available', version: '0.2.0' });
    expect(notice()?.getAttribute('data-events-notice')).toBe('available');
    expect(notice()?.textContent).toContain('0.2.0');
    await click(button(en.events.updateNow));
    expect(handlers.onUpdateNow).toHaveBeenCalled();
    expect(handlers.onDismissUpdateNotice).not.toHaveBeenCalled();
  });

  it('the offer can be waved away without answering it', async () => {
    await render({ kind: 'available', version: '0.2.0' });
    await click(button(en.events.notNow));
    expect(handlers.onDismissUpdateNotice).toHaveBeenCalled();
    expect(handlers.onUpdateNow).not.toHaveBeenCalled();
  });

  it('is made of real buttons, like everything else the a11y sweep touched', async () => {
    // The panel's standing rule: a control is a <button>, not a div with a
    // click handler. Both notices, both flavours.
    for (const kind of ['installed', 'available'] as const) {
      await render({ kind, version: '0.2.0' });
      const controls = notice()!.querySelectorAll('button');
      expect(controls.length, kind).toBeGreaterThan(0);
      for (const b of controls) expect(b.textContent?.trim()).toBeTruthy();
    }
  });
});
