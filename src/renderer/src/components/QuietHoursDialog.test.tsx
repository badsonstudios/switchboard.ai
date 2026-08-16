// @vitest-environment jsdom
// The quiet-hours dialog (P2-E14-05b, §5.9).
//
// The evaluator's matrix is unit-tested in main (`rules.quiet.test.ts`); what
// is worth pinning here is what the DIALOG promises:
//
//  • both ends go together — half a window is not a window, so the write is
//    one call carrying both, or a null that clears both;
//  • an ambiguous pair (start === end) is refused ON SCREEN with a reason,
//    rather than accepted into a control that silently does nothing;
//  • the status line is MAIN's answer, never the renderer's arithmetic —
//    including "cannot tell" when the bridge answered nothing at all;
//  • it says the webhook keeps going, because that is the surprising half of
//    the decision and the user should not have to find out from a dashboard.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { initI18nForTests } from '../i18n/test-i18n';
import { QuietHoursDialog } from './QuietHoursDialog';
import type { QuietState } from '../../../shared/suppressed';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let root: Root | null = null;
let host: HTMLElement;

const handlers = { onClose: vi.fn(), onSet: vi.fn() };

const state = (over: Partial<QuietState> = {}): QuietState => ({
  window: { start: '22:00', end: '07:00' },
  active: false,
  heldCount: 0,
  ...over,
});

async function render(open: boolean, s: QuietState | null = state()): Promise<void> {
  await act(async () => {
    root!.render(<QuietHoursDialog open={open} state={s} {...handlers} />);
  });
}

const dialog = (): HTMLElement | null => host.querySelector<HTMLElement>('[role="dialog"]');
const field = (name: string): HTMLInputElement =>
  host.querySelector<HTMLInputElement>(`[data-quiet-field="${name}"]`)!;
const status = (): string =>
  host.querySelector<HTMLElement>('[data-quiet-status]')?.textContent ?? '';

async function type(el: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
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

describe('the quiet-hours dialog', () => {
  it('renders nothing when closed', async () => {
    await render(false);
    expect(dialog()).toBeNull();
  });

  it('opens seeded with the configured window', async () => {
    await render(true);
    expect(field('enabled').checked).toBe(true);
    expect(field('start').value).toBe('22:00');
    expect(field('end').value).toBe('07:00');
  });

  it('offers a sane default window when none is configured', async () => {
    await render(true, state({ window: null }));
    expect(field('enabled').checked).toBe(false);
    // The boxes are not empty: a user ticking the box gets 22:00–07:00 rather
    // than having to invent two times before anything happens.
    expect(field('start').value).toBe('22:00');
    expect(field('end').value).toBe('07:00');
  });

  it('ticking the box writes BOTH ends in one call', async () => {
    await render(true, state({ window: null }));
    await click(field('enabled'));
    expect(handlers.onSet).toHaveBeenCalledWith({ start: '22:00', end: '07:00' });
  });

  it('unticking clears the window entirely, not one end of it', async () => {
    await render(true);
    await click(field('enabled'));
    expect(handlers.onSet).toHaveBeenCalledWith(null);
  });

  it('editing a time writes the whole window through', async () => {
    await render(true);
    await type(field('start'), '23:30');
    expect(handlers.onSet).toHaveBeenLastCalledWith({ start: '23:30', end: '07:00' });
  });

  it('refuses an identical pair on screen instead of writing a zero-length window', async () => {
    await render(true);
    await type(field('end'), '22:00');
    expect(handlers.onSet).not.toHaveBeenCalled();
    expect(host.querySelector('[data-quiet-problem="same"]')).not.toBeNull();
  });

  it('writes nothing while quiet hours are OFF, however the times are edited', async () => {
    // Otherwise typing in the boxes would silently switch the feature on.
    await render(true, state({ window: null }));
    await type(field('start'), '23:30');
    expect(handlers.onSet).not.toHaveBeenCalled();
  });

  it("says the window is open right now when MAIN says so, and how much it has held", async () => {
    await render(true, state({ active: true, heldCount: 3 }));
    expect(status()).toContain('on right now');
    expect(status()).toContain('3 notifications held');
  });

  it('says so honestly when the bridge answered nothing', async () => {
    // Not an empty form pretending to work — #444's lesson, one aisle over.
    await render(true, null);
    expect(status()).toMatch(/cannot tell/i);
  });

  it('names the webhook exception, which is the surprising half of the decision', async () => {
    await render(true);
    expect(dialog()!.textContent).toMatch(/webhook/i);
    expect(dialog()!.textContent).toMatch(/phone push/i);
  });

  it('is a modal a keyboard can leave', async () => {
    await render(true);
    expect(dialog()!.getAttribute('aria-modal')).toBe('true');
    await act(async () => {
      dialog()!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      );
    });
    expect(handlers.onClose).toHaveBeenCalled();
  });
});
