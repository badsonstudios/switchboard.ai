// @vitest-environment jsdom
// "Add an AI" (E40 item 09, #1292): the dialog's contract.
//
//  • the house modal shape: labelled, Escape closes it (and only it), focus is
//    taken and Tab wraps inside;
//  • From the list: the catalog, a search, a "Runs local models" filter, and
//    install instructions; "Check for new AIs" is the only network call and
//    only the button makes it;
//  • Something else: Test reports what the agent said, a refusal is the field
//    error, and Add is enabled only after a passing Test of the program now in
//    the boxes.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { initI18nForTests } from '../../i18n/test-i18n';
import en from '../../../../shared/i18n/locales/en.json';
import type { AiListItem, AisSnapshot, CatalogEntry } from '../../../../shared/ais';
import { resetModalLayersForTest } from '../../lib/modal-layer';
import { AddAiDialog } from './AddAiDialog';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let root: Root | null = null;
let host: HTMLElement;
const g = globalThis as { switchboard?: unknown };
const onClose = vi.fn();

const entry = (id: string, over: Partial<CatalogEntry> = {}): CatalogEntry => ({
  id,
  name: id,
  maker: 'Maker',
  description: '',
  engine: 'acp',
  install: { kind: 'command', command: `npm i -g ${id}` },
  detectCommand: id,
  runsLocalModels: false,
  ...over,
});
const items: AiListItem[] = [
  { kind: 'catalog', entry: entry('gemini', { name: 'Gemini CLI', maker: 'Google' }), registered: false, detection: { installed: true, login: 'unknown', probedAt: 1 } },
  { kind: 'catalog', entry: entry('opencode', { name: 'OpenCode', runsLocalModels: true }), registered: false, detection: { installed: false, login: 'unknown', probedAt: 1 } },
  { kind: 'catalog', entry: entry('goose', { name: 'goose', runsLocalModels: true, install: { kind: 'link', url: 'https://block.github.io/goose/' } }), registered: false, detection: { installed: false, login: 'unknown', probedAt: 1 } },
];
const snapshot: AisSnapshot = { items, default: { id: 'claude-code', fellBack: false }, detecting: false };

function stub(over: Record<string, unknown> = {}) {
  const custom = {
    test: vi.fn(async () => ({ ok: true, agentName: 'fake-acp', agentVersion: '0.0.0', protocolVersion: 1, ms: 20 })),
    add: vi.fn(async () => ({ ok: true, ai: { id: 'custom:mine', name: 'Mine', command: 'mine', args: [], addedAt: 1 } })),
    remove: vi.fn(),
  };
  const ais = {
    list: vi.fn(async () => items),
    default: vi.fn(async () => snapshot.default),
    onChanged: vi.fn(() => () => undefined),
    lastRegistryCheck: vi.fn(async () => null),
    checkRegistry: vi.fn(async () => ({
      ok: true,
      fetchedAt: Date.UTC(2026, 9, 16, 12),
      total: 42,
      diff: { added: [{ id: 'new-one', name: 'New One', version: '1', distributions: ['npx'] }], changed: [], removed: [] },
    })),
    custom,
    ...over,
  };
  g.switchboard = { ais, files: { openExternal: vi.fn(async () => true) } };
  return { ais, custom };
}

async function render(open = true): Promise<void> {
  await act(async () => {
    root!.render(<AddAiDialog open={open} snapshot={snapshot} onClose={onClose} />);
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

const dialog = (): HTMLElement | null => document.querySelector<HTMLElement>('[data-ai-add-dialog]');
const rows = (): string[] => [...document.querySelectorAll<HTMLElement>('[data-ai-add-row]')].map((r) => r.dataset.aiAddRow!);
function button(label: string): HTMLButtonElement {
  const b = [...dialog()!.querySelectorAll('button')].find((x) => x.textContent === label);
  if (!b) throw new Error(`no button "${label}"`);
  return b;
}
async function click(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}
async function type(el: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const valueProp = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    valueProp?.set?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function key(el: Element, k: string, shiftKey = false): Promise<KeyboardEvent> {
  const e = new KeyboardEvent('keydown', { key: k, shiftKey, bubbles: true, cancelable: true });
  await act(async () => {
    el.dispatchEvent(e);
  });
  return e;
}
const field = (k: string): HTMLInputElement => document.querySelector<HTMLInputElement>(`[data-ai-custom-field="${k}"]`)!;

beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  onClose.mockReset();
  resetModalLayersForTest();
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
  delete g.switchboard;
});

describe('the modal shape', () => {
  it('renders nothing when closed', async () => {
    stub();
    await render(false);
    expect(dialog()).toBeNull();
  });

  it('is a labelled modal, portalled out of its host, with the keyboard', async () => {
    stub();
    await render();
    expect(dialog()!.getAttribute('aria-label')).toBe(en.ais.add.title);
    expect(dialog()!.getAttribute('aria-modal')).toBe('true');
    expect(host.contains(dialog())).toBe(false);
    expect(document.activeElement).toBe(dialog());
  });

  it('Escape closes it, and does not travel on to the Settings window behind', async () => {
    stub();
    const outer = vi.fn();
    host.addEventListener('keydown', outer);
    await render();
    await key(dialog()!, 'Escape');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();
  });

  it('Tab wraps from the last stop to the first, and back', async () => {
    stub();
    await render();
    const stops = [...dialog()!.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled])')].filter(
      (el) => !el.closest('[hidden]') && el.tabIndex !== -1
    );
    const last = stops[stops.length - 1];
    last.focus();
    const e = await key(last, 'Tab');
    expect(e.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(stops[0]);
    const back = await key(stops[0], 'Tab', true);
    expect(back.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(last);
  });

  it('two tabs, the arrow keys move between them', async () => {
    stub();
    await render();
    const list = dialog()!.querySelector<HTMLElement>('[data-ai-add-tab="list"]')!;
    expect(list.getAttribute('aria-selected')).toBe('true');
    await key(list, 'ArrowRight');
    const custom = dialog()!.querySelector<HTMLElement>('[data-ai-add-tab="custom"]')!;
    expect(custom.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(custom);
    expect(dialog()!.querySelector<HTMLElement>('[data-ai-add-panel="list"]')!.hidden).toBe(true);
  });
});

describe('From the list', () => {
  it('lists the catalog, marks what is installed, and shows how to install the rest', async () => {
    stub();
    await render();
    expect(rows()).toEqual(['gemini', 'opencode', 'goose']);
    const gem = document.querySelector('[data-ai-add-row="gemini"]')!;
    expect(gem.querySelector('[data-ai-add-installed]')!.textContent).toBe(en.ais.add.installedMark);
    expect(document.querySelector('[data-ai-add-row="opencode"] code')!.textContent).toBe('npm i -g opencode');
    expect(document.querySelector('[data-ai-add-row="goose"] [data-ai-install="link"]')).not.toBeNull();
    // and it says plainly that this installs nothing
    expect(dialog()!.textContent).toContain('Adding from this list does not install anything');
  });

  it('the Runs local models filter, and the search', async () => {
    stub();
    await render();
    await click(document.querySelector('[data-ai-add-local]')!);
    expect(rows()).toEqual(['opencode', 'goose']);
    await type(document.querySelector<HTMLInputElement>('[data-ai-add-search]')!, 'goo');
    expect(rows()).toEqual(['goose']);
  });

  it('the registry is NOT fetched on open; only the button fetches it', async () => {
    const { ais } = stub();
    await render();
    expect(ais.checkRegistry).not.toHaveBeenCalled();
    expect(ais.lastRegistryCheck).toHaveBeenCalled();
    expect(document.querySelector('[data-ai-registry-result]')!.textContent).toBe(en.ais.add.registryNever);
    await click(button(en.ais.add.checkRegistry));
    expect(ais.checkRegistry).toHaveBeenCalledTimes(1);
    const text = document.querySelector('[data-ai-registry-result]')!.textContent;
    expect(text).toContain('42 AIs in the registry: 1 new, 0 updated and 0 gone');
    expect(text).toContain('New: New One.');
    expect(text).toContain('Last checked');
  });

  it('a failed check says why', async () => {
    stub({ checkRegistry: vi.fn(async () => ({ ok: false, error: 'offline' })) });
    await render();
    await click(button(en.ais.add.checkRegistry));
    expect(document.querySelector('[data-ai-registry-result]')!.textContent).toBe('Could not check: offline');
  });
});

describe('Something else', () => {
  async function fill(name: string, command: string, args: string): Promise<void> {
    await click(dialog()!.querySelector('[data-ai-add-tab="custom"]')!);
    await type(field('name'), name);
    await type(field('command'), command);
    await type(field('args'), args);
  }

  it('Add is off until Test passes; Test reports the agent; Add sends the draft', async () => {
    const { custom } = stub();
    await render();
    await fill('Mine', 'C:/Program Files/mine/mine.exe', 'acp --verbose');
    expect(button(en.ais.add.addButton).disabled).toBe(true);
    await click(button(en.ais.add.test));
    expect(custom.test).toHaveBeenCalledWith({ name: 'Mine', command: 'C:/Program Files/mine/mine.exe', args: ['acp', '--verbose'] });
    const result = document.querySelector<HTMLElement>('[data-ai-custom-result]')!;
    expect(result.dataset.aiCustomResult).toBe('ok');
    expect(result.textContent).toContain('✓ Started it and it answered: fake-acp 0.0.0, protocol 1.');
    // the mockup's "N models found" is not something Test can know; it says so
    expect(result.textContent).toContain('it cannot list the AI’s models');
    expect(button(en.ais.add.addButton).disabled).toBe(false);
    await click(button(en.ais.add.addButton));
    expect(custom.add).toHaveBeenCalledWith({ name: 'Mine', command: 'C:/Program Files/mine/mine.exe', args: ['acp', '--verbose'] });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('changing the program after a Test turns Add back off; renaming does not', async () => {
    stub();
    await render();
    await fill('Mine', 'mine', '');
    await click(button(en.ais.add.test));
    expect(button(en.ais.add.addButton).disabled).toBe(false);
    await type(field('name'), 'Renamed');
    expect(button(en.ais.add.addButton).disabled).toBe(false);
    await type(field('args'), '--other');
    expect(button(en.ais.add.addButton).disabled).toBe(true);
    expect(document.querySelector<HTMLElement>('[data-ai-custom-result]')!.dataset.aiCustomResult).toBe('none');
  });

  it('a refused input is the field error, and Add stays off', async () => {
    stub({
      custom: {
        test: vi.fn(async () => ({ ok: false, error: 'The command may not contain any of: ( ) % ! ^ " < > & |', ms: 0 })),
        add: vi.fn(),
        remove: vi.fn(),
      },
    });
    await render();
    await fill('Bad', 'a&b', '');
    await click(button(en.ais.add.test));
    const result = document.querySelector<HTMLElement>('[data-ai-custom-result]')!;
    expect(result.dataset.aiCustomResult).toBe('failed');
    expect(result.textContent).toContain('✗ The command may not contain any of');
    expect(field('command').getAttribute('aria-invalid')).toBe('true');
    expect(field('command').getAttribute('aria-describedby')).toContain(result.id);
    expect(button(en.ais.add.addButton).disabled).toBe(true);
  });

  it('an Add that main refuses is shown, and the dialog stays open', async () => {
    stub({
      custom: {
        test: vi.fn(async () => ({ ok: true, protocolVersion: 1, ms: 1 })),
        add: vi.fn(async () => ({ ok: false, error: 'An AI with that name is already set up.' })),
        remove: vi.fn(),
      },
    });
    await render();
    await fill('Dup', 'dup', '');
    await click(button(en.ais.add.test));
    expect(document.querySelector('[data-ai-custom-result]')!.textContent).toContain('an ACP agent, protocol 1');
    await click(button(en.ais.add.addButton));
    expect(document.querySelector('[data-ai-custom-result]')!.textContent).toContain('✗ An AI with that name is already set up.');
    expect(onClose).not.toHaveBeenCalled();
  });
});
