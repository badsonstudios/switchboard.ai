// @vitest-environment jsdom
// Settings → AIs (E40 item 09, #1292): what the tab promises.
//
//  • Found / Not found follow detection, and a row with no answer yet says
//    "checking…", never "not found";
//  • every state is in WORDS (login, version, unknown), never colour only;
//  • Make default and the picker write through `ais.setDefault`; a fallback
//    says which AI was chosen and which one new sessions use instead;
//  • Log in runs the AI's own sign-in, and a "not from here" answer shows the
//    AI's own reason (Claude's terminal instruction);
//  • install = SHOWN: a command to copy, or the maker's page through the house
//    `openExternal`, never a raw anchor;
//  • a custom AI is removed only after an inline confirm;
//  • FAIL-OPEN: a failed call keeps the last snapshot with a notice.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { initI18nForTests } from '../../i18n/test-i18n';
import en from '../../../../shared/i18n/locales/en.json';
import type { AiListItem, AisSnapshot, CatalogEntry, DetectionResult } from '../../../../shared/ais';
import { resetAisStoreForTests } from '../../lib/ais-store';
import { resetModalLayersForTest } from '../../lib/modal-layer';
import { AisSection } from './AisSection';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let root: Root | null = null;
let host: HTMLElement;
const g = globalThis as { switchboard?: unknown };

const det = (over: Partial<DetectionResult> = {}): DetectionResult => ({ installed: true, login: 'unknown', probedAt: 1, ...over });
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

const ITEMS: AiListItem[] = [
  {
    kind: 'catalog',
    entry: entry('claude-code', { name: 'Claude Code', maker: 'Anthropic', engine: 'native', providerId: 'claude-code', icon: 'claude-code.svg' }),
    providerId: 'claude-code',
    registered: true,
    detection: det({ login: 'logged-out', version: '2.1.288' }),
  },
  {
    kind: 'catalog',
    entry: entry('codex-acp', { name: 'Codex', maker: 'OpenAI', providerId: 'codex' }),
    providerId: 'codex',
    registered: false,
    detection: det(),
  },
  { kind: 'catalog', entry: entry('gemini', { name: 'Gemini CLI' }), registered: false, detection: det({ installed: false }) },
  { kind: 'catalog', entry: entry('cursor', { name: 'Cursor', install: { kind: 'link', url: 'https://cursor.com/docs/cli/acp' } }), registered: false, detection: det({ installed: false }) },
  { kind: 'catalog', entry: entry('goose', { name: 'goose' }), registered: false },
  {
    kind: 'catalog',
    entry: entry('slow', { name: 'Slow' }),
    registered: false,
    detection: det({ installed: 'unknown', detail: 'it did not answer in time' }),
  },
  {
    kind: 'provider',
    entry: { id: 'fake-acp', name: 'Fake ACP' },
    providerId: 'fake-acp',
    registered: true,
    detection: det({ login: 'logged-in', account: 'me@example.com', plan: 'max', version: '0.0.0' }),
  },
  {
    kind: 'custom',
    entry: { id: 'custom:mine', name: 'Mine', command: 'mine', args: [], addedAt: 1 },
    providerId: 'custom:mine',
    registered: true,
    detection: det(),
  },
];

function stub(over: Record<string, unknown> = {}) {
  let push: ((s: AisSnapshot) => void) | null = null;
  const ais = {
    list: vi.fn(async () => ITEMS),
    default: vi.fn(async () => ({ id: 'claude-code', fellBack: false })),
    setDefault: vi.fn(async (id: string) => ({ ok: true, default: { id, chosen: id, fellBack: false } })),
    lookAgain: vi.fn(async () => ({ items: ITEMS, default: { id: 'claude-code', fellBack: false }, detecting: false })),
    login: vi.fn(async () => ({ supported: false, reason: 'Claude Code signs in from a terminal: run `claude auth login` there.' })),
    checkRegistry: vi.fn(),
    lastRegistryCheck: vi.fn(async () => null),
    custom: { add: vi.fn(), remove: vi.fn(async () => true), test: vi.fn() },
    onChanged: vi.fn((cb: (s: AisSnapshot) => void) => {
      push = cb;
      return () => undefined;
    }),
    ...over,
  };
  const files = { openExternal: vi.fn(async () => true) };
  g.switchboard = { ais, files };
  return { ais, files, push: (s: AisSnapshot) => act(async () => push?.(s)) };
}

async function render(): Promise<void> {
  await act(async () => {
    root!.render(<AisSection open />);
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

const row = (key: string): HTMLElement => host.querySelector<HTMLElement>(`[data-ai-row="${key}"]`)!;
const list = (which: string): string[] =>
  [...host.querySelectorAll<HTMLElement>(`[data-ai-list="${which}"] [data-ai-row]`)].map((r) => r.dataset.aiRow!);
function button(within: Element, label: string): HTMLButtonElement {
  const b = [...within.querySelectorAll('button')].find((x) => x.textContent === label);
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

beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  resetAisStoreForTests();
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
  resetAisStoreForTests();
  delete g.switchboard;
});

describe('Found / Not found', () => {
  it('sorts by detection: registered or installed is Found, the rest is Not found', async () => {
    stub();
    await render();
    expect(list('found')).toEqual(['claude-code', 'codex-acp', 'fake-acp', 'custom:mine']);
    expect(list('not-found')).toEqual(['gemini', 'cursor', 'goose', 'slow']);
  });

  it('a row with no answer yet says checking…, never not found', async () => {
    stub();
    await render();
    expect(row('goose').querySelector('[data-ai-status]')!.textContent).toBe(en.ais.checking);
    expect(row('goose').dataset.aiPresence).toBe('checking');
    expect(row('gemini').querySelector('[data-ai-status]')!.textContent).toBe(en.ais.missing);
  });

  it('an unknown answer says it could not tell, and why', async () => {
    stub();
    await render();
    expect(row('slow').textContent).toContain('Could not tell whether it is installed: it did not answer in time');
  });

  it('login, account, plan and version are all words', async () => {
    stub();
    await render();
    const fake = row('fake-acp').querySelector('[data-ai-status]')!.textContent;
    expect(fake).toContain('Logged in as me@example.com');
    expect(fake).toContain('max');
    expect(fake).toContain('version 0.0.0');
    expect(row('claude-code').textContent).toContain('Not logged in');
    // Codex on a base where only its PATH scan ran: installed, the rest unknown
    const codex = row('codex-acp').textContent;
    expect(codex).toContain(en.ais.loginUnknown);
    expect(codex).toContain(en.ais.versionUnknown);
    expect(codex).toContain(en.ais.cannotRun);
  });

  it('uses the AI’s own mark from the renderer origin, and an initial when there is none', async () => {
    stub();
    await render();
    expect(row('claude-code').querySelector('img')!.getAttribute('src')).toBe('ai-icons/claude-code.svg');
    expect(row('fake-acp').querySelector('[data-ai-icon-fallback]')!.textContent).toBe('F');
  });
});

describe('the default', () => {
  it('the picker lists registered AIs only, and writes through setDefault', async () => {
    const { ais } = stub();
    await render();
    const select = host.querySelector<HTMLSelectElement>('[data-ais-default]')!;
    expect([...select.options].map((o) => o.value)).toEqual(['claude-code', 'fake-acp', 'custom:mine']);
    expect(select.value).toBe('claude-code');
    await act(async () => {
      select.value = 'fake-acp';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(ais.setDefault).toHaveBeenCalledWith('fake-acp');
  });

  it('Make default is on every registered row but the default, and moves the tag', async () => {
    const { ais } = stub();
    await render();
    expect([...row('claude-code').querySelectorAll('button')].map((b) => b.textContent)).not.toContain(en.ais.makeDefault);
    expect([...row('codex-acp').querySelectorAll('button')].map((b) => b.textContent)).not.toContain(en.ais.makeDefault);
    await click(button(row('fake-acp'), en.ais.makeDefault));
    expect(ais.setDefault).toHaveBeenCalledWith('fake-acp');
    expect(row('fake-acp').textContent).toContain(en.ais.tagDefault);
    // the pressed button is gone; the keyboard is on its row, not on <body>
    expect(document.activeElement).toBe(row('fake-acp'));
  });

  it('a refused choice is shown, not swallowed', async () => {
    stub({ setDefault: vi.fn(async () => ({ ok: false, error: 'That AI is not set up here.' })) });
    await render();
    await click(button(row('fake-acp'), en.ais.makeDefault));
    expect(host.textContent).toContain('The default did not change: That AI is not set up here.');
  });

  it('a fallback says what was chosen and what new sessions use', async () => {
    const { push } = stub();
    await render();
    await push({ items: ITEMS, default: { id: 'claude-code', chosen: 'custom:gone', fellBack: true }, detecting: false });
    expect(host.querySelector('[data-ais-fell-back]')!.textContent).toBe(
      'You chose custom:gone, which is not set up here right now, so new sessions start on Claude Code.'
    );
  });
});

describe('Log in', () => {
  it('is offered only for a registered AI that is logged out, and shows the AI’s own answer', async () => {
    const { ais } = stub();
    await render();
    expect([...row('fake-acp').querySelectorAll('button')].map((b) => b.textContent)).not.toContain(en.ais.logIn);
    await click(button(row('claude-code'), en.ais.logIn));
    expect(ais.login).toHaveBeenCalledWith('claude-code', undefined);
    expect(row('claude-code').querySelector('[data-ai-login-message]')!.textContent).toBe(
      'Claude Code signs in from a terminal: run `claude auth login` there.'
    );
  });

  it('a failure with no reason is a whole sentence, not a dangling colon', async () => {
    stub({ login: vi.fn(async () => ({ supported: true, ok: false })) });
    await render();
    await click(button(row('claude-code'), en.ais.logIn));
    expect(row('claude-code').querySelector('[data-ai-login-message]')!.textContent).toBe(en.ais.loginFailedNoReason);
    // and the keyboard is still in the tab, on the row
    expect(document.activeElement).toBe(row('claude-code'));
  });

  it('several methods: asks which, and runs that one', async () => {
    const login = vi.fn(async (_id: string, m?: string) => (m ? { supported: true, ok: true } : { supported: true, methods: ['browser', 'device'] }));
    stub({ login });
    await render();
    await click(button(row('claude-code'), en.ais.logIn));
    await click(button(row('claude-code'), 'device'));
    expect(login).toHaveBeenLastCalledWith('claude-code', 'device');
    expect(row('claude-code').textContent).toContain(en.ais.loginDone);
  });
});

describe('install is shown, never run', () => {
  it('a command goes in a box with Copy', async () => {
    stub();
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await render();
    const gem = row('gemini');
    expect(gem.querySelector('code')!.textContent).toBe('npm i -g gemini');
    await click(button(gem, en.ais.copy));
    expect(writeText).toHaveBeenCalledWith('npm i -g gemini');
    expect(gem.textContent).toContain(en.ais.copied);
  });

  it('a page opens through the house openExternal, and there is no raw anchor', async () => {
    const { files } = stub();
    await render();
    await click(button(row('cursor'), en.ais.howToInstall));
    expect(files.openExternal).toHaveBeenCalledWith('https://cursor.com/docs/cli/acp');
    expect(host.querySelector('a')).toBeNull();
  });

  it('there is no password or credential field anywhere', async () => {
    stub();
    await render();
    expect(host.querySelector('input[type="password"]')).toBeNull();
  });
});

describe('Remove, Look again, and failing open', () => {
  it('a custom AI is removed only after the inline confirm', async () => {
    const { ais } = stub();
    await render();
    await click(button(row('custom:mine'), en.ais.remove));
    expect(ais.custom.remove).not.toHaveBeenCalled();
    expect(row('custom:mine').querySelector('[data-ai-remove-confirm]')).not.toBeNull();
    // the keyboard goes to the safe answer, and Keep gives it back to Remove
    expect(document.activeElement).toBe(button(row('custom:mine'), en.ais.removeNo));
    await click(button(row('custom:mine'), en.ais.removeNo));
    expect(document.activeElement).toBe(button(row('custom:mine'), en.ais.remove));
    await click(button(row('custom:mine'), en.ais.remove));
    await click(button(row('custom:mine'), en.ais.removeYes));
    expect(ais.custom.remove).toHaveBeenCalledWith('custom:mine');
    // only custom AIs can be removed
    expect([...row('claude-code').querySelectorAll('button')].map((b) => b.textContent)).not.toContain(en.ais.remove);
  });

  it('Look again asks main, and says Looking… while a run is in flight', async () => {
    const { ais, push } = stub();
    await render();
    await click(button(host, en.ais.lookAgain));
    expect(ais.lookAgain).toHaveBeenCalledTimes(1);
    await push({ items: ITEMS, default: { id: 'claude-code', fellBack: false }, detecting: true });
    // says so, keeps the focus (not disabled), and a second press asks nothing
    const b = button(host, en.ais.looking);
    expect(b.disabled).toBe(false);
    await click(b);
    expect(ais.lookAgain).toHaveBeenCalledTimes(1);
  });

  it('a failed Look again keeps the list on screen with a notice', async () => {
    stub({ lookAgain: vi.fn(async () => Promise.reject(new Error('gone'))) });
    await render();
    await click(button(host, en.ais.lookAgain));
    expect(host.querySelector('[data-ais-notice]')!.textContent).toBe(en.ais.failed);
    expect(list('found').length).toBeGreaterThan(0);
  });

  it('no bridge: the tab still has words, and says the list is not available', async () => {
    await render();
    expect(host.querySelector('[data-ais-notice]')!.textContent).toBe(en.ais.unavailable);
    expect(host.textContent).toContain(en.ais.intro);
  });

  it('+ Add an AI… opens the dialog', async () => {
    stub();
    await render();
    await click(button(host, en.ais.addAi));
    expect(document.querySelector('[data-ai-add-dialog]')).not.toBeNull();
  });
});
