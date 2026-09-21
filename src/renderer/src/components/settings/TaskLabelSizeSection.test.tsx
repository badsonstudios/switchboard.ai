// @vitest-environment jsdom
// The task-label-size SECTION of the settings modal (#877, moved by #885).
//
// `TaskLabelSizeDialog.test.tsx` re-pointed, not rewritten. The modal contract
// it used to assert — Escape, click-away, aria-modal, the Done button — is
// `SettingsDialog.test.tsx`'s now: one modal, pinned once.
//
// The line counts themselves are pinned in `shared/task-label-size.test.ts`,
// and the clamp that consumes them is CSS. What is worth pinning here is what
// the CONTROL promises:
//
//  • it offers every size in the shared vocabulary — so a size added to that
//    list can never be one this section silently fails to offer;
//  • exactly one is checked, and it is the stored one, not the first;
//  • picking writes through IMMEDIATELY — there is no Save button to press,
//    which is only safe if the change really does leave on the click.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { initI18nForTests } from '../../i18n/test-i18n';
import { TaskLabelSizeSection } from './TaskLabelSizeSection';
import { TASK_LABEL_SIZES, type TaskLabelSize } from '../../../../shared/task-label-size';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let root: Root | null = null;
let host: HTMLElement;

const handlers = { onSet: vi.fn() };

async function render(size: TaskLabelSize = 'full'): Promise<void> {
  await act(async () => {
    root!.render(<TaskLabelSizeSection size={size} {...handlers} />);
  });
}

const radio = (size: string): HTMLInputElement =>
  host.querySelector<HTMLInputElement>(`[data-task-label-size="${size}"]`)!;

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

describe('the task-label-size section', () => {
  it('offers every size in the shared vocabulary, each with a name and a note', async () => {
    await render();
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
    await render('medium');
    const checked = TASK_LABEL_SIZES.filter((s) => radio(s).checked);
    expect(checked).toEqual(['medium']);
  });

  it('writes the pick through at once — there is no Save button to press', async () => {
    await render('full');
    await act(async () => {
      radio('compact').click();
    });
    expect(handlers.onSet).toHaveBeenCalledWith('compact');
  });

  it('names its group, so a screen reader does not read three unrelated questions', async () => {
    await render();
    const group = host.querySelector('[role="radiogroup"]');
    expect(group).not.toBeNull();
    expect(group?.getAttribute('aria-label')).toBe('Task label size');
  });

  it('gives its radios a unique name, so the group is one choice not three', async () => {
    await render();
    const names = new Set(TASK_LABEL_SIZES.map((s) => radio(s).name));
    expect(names.size).toBe(1);
    // And each `for` binds to a real id in THIS section (#654) — a literal id
    // could be taken by earlier content with the same name.
    for (const size of TASK_LABEL_SIZES) {
      const el = radio(size);
      expect(el.id).not.toBe('');
      expect(el.closest('label')?.getAttribute('for')).toBe(el.id);
    }
  });
});
