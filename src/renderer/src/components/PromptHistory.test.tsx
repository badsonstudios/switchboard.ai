// @vitest-environment jsdom
// The list of prompts you sent (#1203): a row goes to the prompt, "Use again"
// puts it back in the prompt box, and the panel behaves as a dialog.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { initI18nForTests } from '../i18n/test-i18n';
import { PromptHistory } from './PromptHistory';
import type { PromptEntry } from '../lib/prompt-history';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let root: Root | null = null;
let host: HTMLElement;
const onJump = vi.fn<(seq: number) => void>();
const onRecall = vi.fn<(text: string) => void>();
const onClose = vi.fn<(returnFocus: boolean) => void>();

const PROMPTS: PromptEntry[] = [
  { seq: 30, text: 'Write the release notes', recall: 'Write the release notes', command: false },
  // a command's LABEL is short; what it puts back is the whole command
  { seq: 20, text: '/next-item 1203', recall: '/next-item 1203 and the whole briefing', command: true },
  { seq: 10, text: 'Fix the tail-pin gesture', recall: 'Fix the tail-pin gesture', command: false },
];

async function mount(prompts: PromptEntry[] = PROMPTS, truncated = false): Promise<void> {
  await act(async () => {
    root!.render(
      <PromptHistory
        prompts={prompts}
        truncated={truncated}
        onJump={onJump}
        onRecall={onRecall}
        onClose={onClose}
      />
    );
  });
}
const rows = (): HTMLElement[] => [...host.querySelectorAll<HTMLElement>('[data-prompt-history-row]')];
const texts = (): string[] => rows().map((r) => r.querySelector('.prompt-history-text')!.textContent ?? '');
const filter = (): HTMLInputElement => host.querySelector<HTMLInputElement>('[data-prompt-history-filter]')!;
async function type(value: string): Promise<void> {
  await act(async () => {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    descriptor?.set?.call(filter(), value);
    filter().dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeAll(async () => {
  await initI18nForTests();
});
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '';
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  onJump.mockReset();
  onRecall.mockReset();
  onClose.mockReset();
});
afterEach(async () => {
  const r = root;
  root = null;
  await act(async () => r?.unmount());
});

describe('the prompt list (#1203)', () => {
  it('lists the prompts in the order given (newest first), each with two buttons', async () => {
    await mount();
    expect(texts()).toEqual(['Write the release notes', '/next-item 1203', 'Fix the tail-pin gesture']);
    for (const r of rows()) {
      const buttons = [...r.querySelectorAll('button')];
      expect(buttons).toHaveLength(2);
      // side by side, never one inside the other
      expect(buttons[0].contains(buttons[1])).toBe(false);
    }
  });

  it('a row GOES to that prompt', async () => {
    await mount();
    await act(async () => rows()[2].querySelector<HTMLElement>('[data-prompt-history-jump]')!.click());
    expect(onJump).toHaveBeenCalledWith(10);
    expect(onRecall).not.toHaveBeenCalled();
  });

  it('Use again hands back the prompt’s text, and does not jump', async () => {
    await mount();
    await act(async () => rows()[0].querySelector<HTMLElement>('[data-prompt-history-recall]')!.click());
    expect(onRecall).toHaveBeenCalledWith('Write the release notes');
    expect(onJump).not.toHaveBeenCalled();
  });

  it('Use again gives back the WHOLE prompt, not the label the row shows', async () => {
    await mount();
    await act(async () => rows()[1].querySelector<HTMLElement>('[data-prompt-history-recall]')!.click());
    expect(onRecall).toHaveBeenCalledWith('/next-item 1203 and the whole briefing');
  });

  it('leaving it by keyboard closes it; moving within it, or to its own button, does not', async () => {
    await mount();
    const opener = document.createElement('button');
    opener.setAttribute('data-prompt-history-open', '');
    const elsewhere = document.createElement('button');
    document.body.append(opener, elsewhere);
    const leave = async (to: Element | null): Promise<void> => {
      await act(async () => {
        filter().dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: to }));
      });
    };
    await leave(rows()[0].querySelector('button'));
    await leave(opener);
    await leave(null); // the window lost focus: not a choice
    expect(onClose).not.toHaveBeenCalled();
    await leave(elsewhere);
    expect(onClose.mock.calls).toEqual([[false]]);
  });

  it('each Use again says WHICH prompt, for someone who cannot see the row beside it', async () => {
    await mount();
    const names = rows().map(
      (r) => r.querySelector('[data-prompt-history-recall]')!.getAttribute('aria-label')
    );
    expect(names[0]).toBe('Use again: Write the release notes');
    expect(new Set(names).size).toBe(3);
  });

  it('is a named dialog, and the filter has the keyboard as it opens', async () => {
    await mount();
    const panel = host.querySelector('[role="dialog"]')!;
    expect(panel.getAttribute('aria-label')).toBe('Previous prompts');
    expect(document.activeElement).toBe(filter());
  });

  it('typing narrows the list; nothing matching says so in words', async () => {
    await mount();
    await type('notes');
    expect(texts()).toEqual(['Write the release notes']);
    await type('zebra');
    expect(rows()).toHaveLength(0);
    expect(host.querySelector('[data-prompt-history-empty]')!.textContent).toContain('zebra');
  });

  it('no prompts yet: says so, rather than an empty box', async () => {
    await mount([]);
    expect(host.querySelector('[data-prompt-history-empty]')!.textContent).toBe(
      'You have not sent this session a prompt yet.'
    );
  });

  it('Escape closes it, and the key goes no further', async () => {
    await mount();
    const outer = vi.fn();
    // further OUT than the app's own root: where a window-level shortcut listens
    document.body.addEventListener('keydown', outer);
    await act(async () => {
      filter().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    // "never mind": the keyboard is to go back to the button
    expect(onClose.mock.calls).toEqual([[true]]);
    expect(outer).not.toHaveBeenCalled();
  });

  it('a press outside closes it; a press inside, or on its own button, does not', async () => {
    await mount();
    const opener = document.createElement('button');
    opener.setAttribute('data-prompt-history-open', '');
    const elsewhere = document.createElement('div');
    document.body.append(opener, elsewhere);
    const press = async (el: Element): Promise<void> => {
      await act(async () => {
        el.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      });
    };
    await press(filter());
    await press(opener);
    expect(onClose).not.toHaveBeenCalled();
    await press(elsewhere);
    // the press put the keyboard where the user wanted it: do not take it back
    expect(onClose.mock.calls).toEqual([[false]]);
  });

  it('says when older prompts are not listed, and only then', async () => {
    await mount(PROMPTS, true);
    expect(host.querySelector('[data-prompt-history-truncated]')!.textContent).toContain(
      'further back are not listed'
    );
    await mount(PROMPTS, false);
    expect(host.querySelector('[data-prompt-history-truncated]')).toBeNull();
  });
});
