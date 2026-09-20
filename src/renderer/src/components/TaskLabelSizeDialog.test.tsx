// @vitest-environment jsdom
// The task-label-size dialog (#877).
//
// The line counts themselves are pinned in `shared/task-label-size.test.ts`,
// and the clamp that consumes them is CSS. What is worth pinning here is what
// the DIALOG promises:
//
//  • it offers every size in the shared vocabulary — so a size added to that
//    list can never be one this dialog silently fails to offer;
//  • exactly one is checked, and it is the stored one, not the first;
//  • picking writes through IMMEDIATELY — there is no Save button to press,
//    which is only safe if the change really does leave on the click;
//  • Escape and click-away close without writing anything.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { initI18nForTests } from '../i18n/test-i18n';
import { TaskLabelSizeDialog } from './TaskLabelSizeDialog';
import { TASK_LABEL_SIZES, type TaskLabelSize } from '../../../shared/task-label-size';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let root: Root | null = null;
let host: HTMLElement;

const handlers = { onClose: vi.fn(), onSet: vi.fn() };

async function render(open: boolean, size: TaskLabelSize = 'full'): Promise<void> {
  await act(async () => {
    root!.render(<TaskLabelSizeDialog open={open} size={size} {...handlers} />);
  });
}

const dialog = (): HTMLElement | null => host.querySelector<HTMLElement>('[role="dialog"]');
const radio = (size: string): HTMLInputElement =>
  host.querySelector<HTMLInputElement>(`[data-task-label-size="${size}"]`)!;

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

describe('the task-label-size dialog', () => {
  it('renders nothing when closed', async () => {
    await render(false);
    expect(dialog()).toBeNull();
  });

  it('offers every size in the shared vocabulary, each with a name and a note', async () => {
    await render(true);
    for (const size of TASK_LABEL_SIZES) {
      const el = radio(size);
      expect(el, `no control for ${size}`).not.toBeNull();
      // The LABEL text, not just the input: a radio group whose options are
      // three unexplained words is one you have to try to understand.
      const label = el.closest('label');
      expect(label?.textContent?.trim().length ?? 0, `${size} has no text`).toBeGreaterThan(10);
    }
  });

  it('checks the stored size, and only that one', async () => {
    await render(true, 'medium');
    const checked = TASK_LABEL_SIZES.filter((s) => radio(s).checked);
    expect(checked).toEqual(['medium']);
  });

  it('writes the pick through at once — there is no Save button to press', async () => {
    await render(true, 'full');
    await act(async () => {
      radio('compact').click();
    });
    expect(handlers.onSet).toHaveBeenCalledWith('compact');
    // …and it does NOT close on the pick: the rail behind the dialog reflows on
    // the click, so staying open is how you see what you chose before you
    // commit to it.
    expect(handlers.onClose).not.toHaveBeenCalled();
  });

  it('closes on Escape without writing', async () => {
    await render(true);
    await act(async () => {
      dialog()!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      );
    });
    expect(handlers.onClose).toHaveBeenCalledTimes(1);
    expect(handlers.onSet).not.toHaveBeenCalled();
  });

  it('closes on click-away, but a click INSIDE is not a click-away', async () => {
    await render(true);
    await act(async () => {
      dialog()!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    });
    expect(handlers.onClose).not.toHaveBeenCalled();

    await act(async () => {
      host
        .querySelector('div')!
        .dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    });
    expect(handlers.onClose).toHaveBeenCalledTimes(1);
  });

  it('is a labelled modal, so a screen reader announces what it is', async () => {
    await render(true);
    const d = dialog()!;
    expect(d.getAttribute('aria-modal')).toBe('true');
    expect(d.getAttribute('aria-label')).toBe('Task label size');
    // The group too: three loose radios with no group name read as three
    // unrelated questions.
    expect(host.querySelector('[role="radiogroup"]')).not.toBeNull();
  });

  it('gives its radios a unique name, so the group is one choice not three', async () => {
    await render(true);
    const names = new Set(TASK_LABEL_SIZES.map((s) => radio(s).name));
    expect(names.size).toBe(1);
    // And each `for` binds to a real id in THIS dialog (#654) — a literal id
    // could be taken by earlier content with the same name.
    for (const size of TASK_LABEL_SIZES) {
      const el = radio(size);
      expect(el.id).not.toBe('');
      expect(el.closest('label')?.getAttribute('for')).toBe(el.id);
    }
  });

  it('closes on the Done button', async () => {
    await render(true);
    await click(host.querySelector('button')!);
    expect(handlers.onClose).toHaveBeenCalledTimes(1);
  });
});
