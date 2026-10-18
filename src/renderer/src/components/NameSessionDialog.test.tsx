// @vitest-environment jsdom
// "Name the new session" (#1282).
//
// What only a RENDERED dialog can answer: the field opens with the suggestion
// selected, Enter and OK both start with exactly what is in the field (trimmed),
// Escape / Cancel / click-away start nothing, a blank name cannot be OK'd, and
// the "taken" warning shows main's answer — and only for the text it answers.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { createRoot, Root } from 'react-dom/client';
import { act } from 'react';
import { NameSessionDialog, NAME_CHECK_MS } from './NameSessionDialog';
import { initI18nForTests } from '../i18n/test-i18n';
import { modalDepth, resetModalLayersForTest } from '../lib/modal-layer';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let host: HTMLDivElement;
let root: Root;
let confirmed: string[];
let cancelled: number;
let check: ReturnType<typeof vi.fn<(name: string) => Promise<string | null>>>;

async function mount(initial = 'app-2', folder = 'C:\\work\\app'): Promise<void> {
  await act(async () => {
    root.render(
      <NameSessionDialog
        folder={folder}
        initial={initial}
        check={check}
        onConfirm={(n) => confirmed.push(n)}
        onCancel={() => (cancelled += 1)}
      />
    );
  });
}

const input = (): HTMLInputElement => host.querySelector<HTMLInputElement>('[data-name-session-input]')!;
const ok = (): HTMLButtonElement => host.querySelector<HTMLButtonElement>('[data-name-session-ok]')!;
const note = (): HTMLElement => host.querySelector<HTMLElement>('[role="status"]')!;

async function type(value: string): Promise<void> {
  await act(async () => {
    const valueProp = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    valueProp?.set?.call(input(), value);
    input().dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function key(el: Element, k: string): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  });
}
async function click(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}
/** past the typing pause, and let the check's promise land */
async function settle(): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(NAME_CHECK_MS + 1);
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeAll(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  await initI18nForTests();
});

beforeEach(() => {
  vi.useFakeTimers();
  confirmed = [];
  cancelled = 0;
  check = vi.fn((name: string) => Promise.resolve(name === 'taken' ? 'taken-2' : name));
  resetModalLayersForTest();
  document.body.innerHTML = '';
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
});

describe('NameSessionDialog (#1282)', () => {
  it('opens pre-filled with the suggestion, focused and selected, and says which folder', async () => {
    await mount('app-2', 'C:\\work\\app');
    expect(input().value).toBe('app-2');
    expect(document.activeElement).toBe(input());
    expect(input().selectionStart).toBe(0);
    expect(input().selectionEnd).toBe('app-2'.length);
    expect(host.textContent).toContain('Name the new session');
    expect(host.textContent).toContain('C:\\work\\app');
    expect(host.querySelector('[role="dialog"]')?.getAttribute('aria-modal')).toBe('true');
    expect(modalDepth()).toBe(1);
  });

  it('OK with no edits starts exactly the name shown — and asks main nothing', async () => {
    await mount('app-2');
    await click(ok());
    expect(confirmed).toEqual(['app-2']);
    await settle();
    expect(check).not.toHaveBeenCalled();
    expect(note().textContent).toBe('');
  });

  it('Enter is OK, with the typed name trimmed', async () => {
    await mount();
    await type('  my review  ');
    await key(input(), 'Enter');
    expect(confirmed).toEqual(['my review']);
  });

  it('the Enter that commits an IME composition is not OK', async () => {
    await mount();
    await act(async () => {
      input().dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true })
      );
    });
    expect(confirmed).toEqual([]);
  });

  it('Escape, Cancel and click-away start nothing', async () => {
    await mount();
    await key(input(), 'Escape');
    expect(cancelled).toBe(1);
    await click(host.querySelector('[data-name-session-cancel]')!);
    expect(cancelled).toBe(2);
    const scrim = host.firstElementChild!;
    await act(async () => {
      scrim.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(cancelled).toBe(3);
    // …but a press INSIDE the dialog is not a click-away
    await act(async () => {
      input().dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(cancelled).toBe(3);
    expect(confirmed).toEqual([]);
  });

  it('a blank name cannot be OK’d, by button or by Enter', async () => {
    await mount();
    await type('   ');
    expect(ok().disabled).toBe(true);
    await key(input(), 'Enter');
    await click(ok());
    expect(confirmed).toEqual([]);
    expect(note().dataset.nameSessionNote).toBe('blank');
  });

  it('a taken name is WARNED about, with main’s answer, and OK still works', async () => {
    await mount();
    await type('taken');
    await settle();
    expect(check).toHaveBeenCalledWith('taken');
    expect(note().dataset.nameSessionNote).toBe('taken');
    expect(note().textContent).toContain('taken-2');
    expect(ok().disabled).toBe(false);
    await click(ok());
    // the typed name goes; main is the one that makes it taken-2
    expect(confirmed).toEqual(['taken']);
  });

  it('a free name typed after a taken one clears the warning', async () => {
    await mount();
    await type('taken');
    await settle();
    await type('fresh');
    // not yet checked: the old warning does not hang under the new text
    expect(note().dataset.nameSessionNote).toBeUndefined();
    await settle();
    expect(note().textContent).toBe('');
  });

  it('a slow answer for text since replaced is never shown', async () => {
    let release: (v: string) => void = () => {};
    check.mockImplementationOnce(() => new Promise<string | null>((r) => (release = r)));
    await mount();
    await type('taken');
    await act(async () => {
      vi.advanceTimersByTime(NAME_CHECK_MS + 1);
    });
    await type('other');
    await act(async () => {
      release('taken-2');
      await Promise.resolve();
    });
    expect(note().textContent).not.toContain('taken-2');
  });

  it('a check that fails is no warning, never a blocked OK (fail-open)', async () => {
    check.mockImplementation(() => Promise.reject(new Error('bridge gone')));
    await mount();
    await type('anything');
    await settle();
    expect(note().textContent).toBe('');
    await click(ok());
    expect(confirmed).toEqual(['anything']);
  });

  it('keys stay in the dialog: nothing behind it hears them', async () => {
    const behind = vi.fn();
    document.addEventListener('keydown', behind);
    await mount();
    await key(input(), 'a');
    document.removeEventListener('keydown', behind);
    expect(behind).not.toHaveBeenCalled();
  });
});
