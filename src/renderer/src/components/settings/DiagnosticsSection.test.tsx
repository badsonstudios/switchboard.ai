// @vitest-environment jsdom
// What the Diagnostics section PROMISES (#923). Whether it is wired into the
// modal is `SettingsDialog.test.tsx`'s job.
//
// The promise worth pinning here is not the tick box — it is the sentence. This
// is the one screen where someone decides whether to switch on a thing called
// "capture", and E21's hard constraint is that the capture is local-only:
// durations and action names, never prompt text, file names or session content.
// That guarantee has to be readable at the moment of the decision, not in a
// manual page nobody has open, so it is asserted like any other behaviour.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { initI18nForTests } from '../../i18n/test-i18n';
import { DiagnosticsSection } from './DiagnosticsSection';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let root: Root | null = null;
let host: HTMLElement;

const handlers = { onTogglePerfCapture: vi.fn(), onRevealCapture: vi.fn() };

async function render(over: Record<string, unknown> = {}): Promise<void> {
  await act(async () => {
    root!.render(<DiagnosticsSection perfCapture={false} {...handlers} {...over} />);
  });
}

const field = (id: string): HTMLInputElement | null =>
  host.querySelector<HTMLInputElement>(`[data-settings-field="${id}"]`);
const item = (id: string): HTMLElement | null =>
  host.querySelector<HTMLElement>(`[data-settings-item="${id}"]`);

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

describe('the Diagnostics section (#923)', () => {
  it('says the capture stays on this computer, where the decision is made', async () => {
    // The user-visible half of E21's hard constraint. `perf-capture.test.ts`
    // asserts the file actually keeps this promise; this asserts we make it
    // somewhere the person choosing can read it.
    await render();
    const blurb = item('perf-capture')?.textContent ?? '';
    expect(blurb).toMatch(/stays on this computer/i);
    expect(blurb).toMatch(/never anything you typed/i);
  });

  it('says it costs something, rather than presenting a free switch', async () => {
    // It is off by default BECAUSE it costs speed, and a switch whose downside
    // is unstated invites "why not just leave it on?".
    await render();
    expect(item('perf-capture')?.textContent ?? '').toMatch(/costs a little speed/i);
  });

  it('writes through immediately — there is no Save button on this screen', async () => {
    await render({ perfCapture: false });
    await act(async () => {
      field('perf-capture')!.click();
    });
    expect(handlers.onTogglePerfCapture).toHaveBeenCalledWith(true);
  });

  it('reads the stored value rather than its own state', async () => {
    await render({ perfCapture: true });
    expect(field('perf-capture')?.checked).toBe(true);
  });

  it('offers the file, and says what it holds and for how long', async () => {
    // The whole point of P2-E21-02 is that the owner can attach this to an
    // issue, so "where is it" must be answerable from the screen that made it.
    await render({ hasCapture: true });
    const text = item('perf-capture-file')?.textContent ?? '';
    expect(text).toMatch(/one file you can attach/i);
    expect(text).toMatch(/working day/i);
  });

  it('reveals the file on click', async () => {
    await render({ hasCapture: true });
    await act(async () => {
      item('perf-capture-file')!.querySelector('button')!.click();
    });
    expect(handlers.onRevealCapture).toHaveBeenCalled();
  });
});
