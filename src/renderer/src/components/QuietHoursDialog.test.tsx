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
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { initI18nForTests } from '../i18n/test-i18n';
import { QuietHoursDialog } from './QuietHoursDialog';
import type { QuietState } from '../../../shared/quiet-hours';

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
    // Kept as the DESCRIPTOR: `PropertyDescriptor.set` is declared a METHOD in
    // lib.es5.d.ts, so pulling it out into a variable is `unbound-method`
    // (#255 T4). Calling through it with an explicit `this` is the same write.
    const valueProp = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    valueProp?.set?.call(el, value);
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

  it('says why when a time box has been cleared, rather than refusing in silence', async () => {
    // `<input type="time">` can be emptied. Found in review: the checkbox sprang
    // back with nothing on screen — the exact failure the "same times" message
    // exists to prevent, one branch over.
    await render(true, state({ window: null }));
    await type(field('start'), '');
    expect(host.querySelector('[data-quiet-problem="missing"]')).not.toBeNull();
    // …and turning quiet hours ON is refused rather than silently doing nothing
    await click(field('enabled'));
    expect(handlers.onSet).not.toHaveBeenCalled();
  });

  it('rejects a time main would reject, rather than writing one that vanishes', async () => {
    // The renderer used to carry its own looser regex, so `99:99` was written
    // here and dropped there — the field reverting with no explanation.
    await render(true);
    await type(field('end'), '99:99');
    expect(handlers.onSet).not.toHaveBeenCalled();
  });

  // ── the seeding blocker (found in review) ────────────────────────────────
  //
  // `App` fetches the state when the dialog opens, so `props.state` is null on
  // the first render. Seeding the drafts then showed 22:00-07:00 over somebody
  // else's configured window — and the write-through would then send that
  // default as the OTHER end the moment they nudged one field, silently moving
  // a time they never touched.
  describe('seeding when main answers late', () => {
    it('waits for the answer instead of showing defaults over a real window', async () => {
      await render(true, null); // main has not answered yet
      await render(true, state({ window: { start: '23:00', end: '06:00' } }));
      expect(field('start').value).toBe('23:00');
      expect(field('end').value).toBe('06:00');
    });

    it('and then a nudge to one end leaves the other alone', async () => {
      await render(true, null);
      await render(true, state({ window: { start: '23:00', end: '06:00' } }));
      await type(field('end'), '05:00');
      expect(handlers.onSet).toHaveBeenLastCalledWith({ start: '23:00', end: '05:00' });
    });

    it('does not re-seed on later answers, which would eat what is being typed', async () => {
      await render(true, null);
      await render(true, state({ window: { start: '23:00', end: '06:00' } }));
      await type(field('start'), '21:00');
      // the write triggers a re-read in App; main answers with the OLD window
      // for a frame. The draft must survive it.
      await render(true, state({ window: { start: '23:00', end: '06:00' } }));
      expect(field('start').value).toBe('21:00');
    });

    it('never eats a keystroke that beat the answer', async () => {
      // One IPC round trip is not long, but it is long enough for someone who
      // opened this to change one number and started typing at once — and a
      // form that swallows the first thing you type is one you stop trusting.
      await render(true, null);
      await type(field('start'), '21:00');
      await render(true, state({ window: { start: '23:00', end: '06:00' } }));
      expect(field('start').value).toBe('21:00');
    });

    it('re-seeds on the NEXT opening', async () => {
      await render(true, state({ window: { start: '23:00', end: '06:00' } }));
      await render(false, null);
      await render(true, null);
      await render(true, state({ window: { start: '01:00', end: '02:00' } }));
      expect(field('start').value).toBe('01:00');
    });
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

  it('its fields carry no id rendered content could name (#654)', async () => {
    // `PushSetupDialog.test.tsx` carries the argument in full; the mechanism is
    // identical and so is the fix. A literal `id` is a NAME rendered content
    // can plant, and IDREFs resolve to the first element in tree order — so a
    // `quiet-field-start` planted EARLIER than this dialog takes this label
    // away from this field. `App.tsx` renders this dialog before `SessionGrid`,
    // so the feed and the viewer never were earlier: prophylaxis against a
    // reorder, not a live fix. `React.useId()` is not random either — it is
    // deterministic for a given render tree — so what it removes is a STABLE,
    // PUBLISHED name, not the possibility of a collision. The closure is the
    // `<label>` tag in `markdown.tsx`; this is defence-in-depth.
    await render(true);
    const ids = [...host.querySelectorAll('[id]')].map((el) => el.id);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(id).not.toMatch(/quiet-field-/);
    // the label still binds — the string changed, the wiring did not
    expect(field('start').labels?.length).toBe(1);
    expect(field('end').labels?.length).toBe(1);
    // …and the string belongs to the TREE: one more `useId` caller ahead of it
    // and every id in the dialog moves.
    const Ahead = (): React.JSX.Element => <i data-ahead={React.useId()} />;
    await act(async () => {
      root!.render(
        <>
          <Ahead />
          <QuietHoursDialog open state={state()} {...handlers} />
        </>
      );
    });
    const shifted = [...host.querySelectorAll('[id]')].map((el) => el.id);
    expect(shifted.length).toBe(ids.length);
    expect(shifted.filter((id) => ids.includes(id))).toEqual([]);
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
