// @vitest-environment jsdom
// Settings → Advanced → Testing (#1331): what the picker promises.
//
//  • every attached screen is a row a person can tell apart (number, name,
//    native size, where it sits), the primary merged with the default;
//  • picking a row names a SCREEN id to main (null for the primary) — never a
//    path or a value — and shows what main answers;
//  • a saved choice for a screen that is not attached is its own ticked row
//    saying "not attached — tests run on the primary until it is back";
//  • a hotplug push replaces the list;
//  • FAIL-OPEN: a failed write keeps the selection and says so inline; a file
//    that cannot be read disables the control; no bridge, nothing drawn.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { initI18nForTests } from '../../i18n/test-i18n';
import en from '../../../../shared/i18n/locales/en.json';
import type {
  TestDisplaySetResult,
  TestDisplayState,
  TestScreen,
} from '../../../../shared/test-display';
import { TestDisplaySection } from './TestDisplaySection';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let root: Root | null = null;
let host: HTMLElement;
const g = globalThis as { switchboard?: unknown };

const PRIMARY: TestScreen = { id: 1, number: 1, name: 'DELL U2723QE', width: 3840, height: 2160, position: 'primary', primary: true };
const LEFT: TestScreen = { id: 7, number: 2, name: 'LG ULTRAFINE', width: 3840, height: 2160, position: 'left', primary: false };
const RIGHT: TestScreen = { id: 9, number: 3, name: '', width: 1920, height: 1080, position: 'right', primary: false };

const FILE = 'C:\\Users\\someone\\.switchboard-e2e.env';
const state = (over: Partial<TestDisplayState> = {}): TestDisplayState => ({
  screens: [PRIMARY, LEFT, RIGHT],
  saved: { kind: 'none' },
  file: FILE,
  ...over,
});

function stub(initial: TestDisplayState, set?: (id: number | null) => Promise<TestDisplaySetResult>) {
  let push: ((s: TestDisplayState) => void) | null = null;
  const testDisplay = {
    get: vi.fn(async () => initial),
    set: vi.fn(
      set ??
        (async (id: number | null) => ({
          ok: true as const,
          state: state({
            saved: id === null ? { kind: 'none' } : { kind: 'attached', value: `id:${id}`, screenId: id },
          }),
        }))
    ),
    onChanged: vi.fn((cb: (s: TestDisplayState) => void) => {
      push = cb;
      return () => undefined;
    }),
  };
  g.switchboard = { testDisplay };
  return { testDisplay, push: (s: TestDisplayState) => act(async () => push?.(s)) };
}

async function render(): Promise<void> {
  await act(async () => {
    root!.render(<TestDisplaySection />);
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

const option = (key: string): HTMLElement =>
  host.querySelector<HTMLElement>(`[data-test-display-option="${key}"]`)!;
const radio = (key: string): HTMLInputElement => option(key).querySelector('input')!;
const keys = (): string[] =>
  [...host.querySelectorAll<HTMLElement>('[data-test-display-option]')].map((o) => o.dataset.testDisplayOption!);
const ticked = (): string[] => keys().filter((k) => radio(k).checked);

async function pick(key: string): Promise<void> {
  await act(async () => {
    radio(key).click();
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
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

describe('the rows', () => {
  it('lists the primary (as the default) and every other screen, each told apart', async () => {
    stub(state());
    await render();
    expect(keys()).toEqual(['primary', '7', '9']);
    expect(option('primary').textContent).toBe(
      'Primary screen (default) — Screen 1 — DELL U2723QE, 3840×2160, primary'
    );
    expect(option('7').textContent).toBe('Screen 2 — LG ULTRAFINE, 3840×2160, to the left');
    // a screen with no name of its own still reads cleanly — no ", ," gap
    expect(option('9').textContent).toBe('Screen 3 — 1920×1080, to the right');
    expect(ticked()).toEqual(['primary']);
  });

  it('says what it is for, in one sentence, and where it is saved', async () => {
    stub(state());
    await render();
    expect(host.textContent).toContain(en.testDisplay.blurb);
    expect(host.querySelector('[data-test-display-file]')!.textContent).toContain(FILE);
  });

  it('ticks the saved screen', async () => {
    stub(state({ saved: { kind: 'attached', value: 'right', screenId: 9 } }));
    await render();
    expect(ticked()).toEqual(['9']);
  });

  it('a saved value naming the primary itself (`1`) ticks the default', async () => {
    stub(state({ saved: { kind: 'attached', value: '1', screenId: null } }));
    await render();
    expect(ticked()).toEqual(['primary']);
  });
});

describe('a saved choice that cannot be used', () => {
  it('a screen that is not attached is its own ticked row, saying so', async () => {
    stub(state({ saved: { kind: 'missing', value: 'id:42' } }));
    await render();
    expect(keys()).toEqual(['primary', '7', '9', 'saved']);
    expect(ticked()).toEqual(['saved']);
    expect(option('saved').textContent).toContain('id:42');
    expect(option('saved').querySelector('[data-test-display-note]')!.textContent).toBe(en.testDisplay.missing);
    expect(en.testDisplay.missing).toMatch(/not attached/i);
    expect(en.testDisplay.missing).toMatch(/primary until it is back/);
  });

  it('a value the tests cannot read says that instead', async () => {
    stub(state({ saved: { kind: 'invalid', value: 'middle' } }));
    await render();
    expect(ticked()).toEqual(['saved']);
    expect(option('saved').querySelector('[data-test-display-note]')!.textContent).toBe(en.testDisplay.invalid);
  });

  it('picking a screen replaces it', async () => {
    const { testDisplay } = stub(state({ saved: { kind: 'missing', value: 'id:42' } }));
    await render();
    await pick('primary');
    expect(testDisplay.set).toHaveBeenCalledWith(null);
    expect(keys()).toEqual(['primary', '7', '9']);
    expect(ticked()).toEqual(['primary']);
  });
});

describe('picking', () => {
  it('names the SCREEN id to main, and shows what main answers', async () => {
    const { testDisplay } = stub(state());
    await render();
    await pick('9');
    expect(testDisplay.set).toHaveBeenCalledTimes(1);
    expect(testDisplay.set).toHaveBeenCalledWith(9);
    expect(ticked()).toEqual(['9']);
    await pick('primary');
    expect(testDisplay.set).toHaveBeenLastCalledWith(null);
    expect(ticked()).toEqual(['primary']);
  });

  it('a failed write keeps the selection and says so inline', async () => {
    const before = state({ saved: { kind: 'attached', value: 'left', screenId: 7 } });
    stub(before, async () => ({ ok: false, problem: 'EACCES: permission denied', state: before }));
    await render();
    await pick('9');
    expect(ticked()).toEqual(['7']);
    const alert = host.querySelector('[role="alert"][data-test-display-problem]')!;
    expect(alert.textContent).toContain('EACCES: permission denied');
    expect(alert.textContent).toContain('left as it was');
  });

  it('a refusal main decides is said in the app’s words, by code', async () => {
    const before = state();
    stub(before, async () => ({ ok: false, problem: 'that screen is not attached any more', code: 'not-attached', state: before }));
    await render();
    await pick('7');
    expect(host.querySelector('[data-test-display-problem]')!.textContent).toBe(
      `Could not save that (${en.testDisplay.code['not-attached']}). The file was left as it was.`
    );
  });

  it('a write that throws is the same inline message, not a crash', async () => {
    stub(state(), async () => {
      throw new Error('bridge gone');
    });
    await render();
    await pick('7');
    expect(host.querySelector('[data-test-display-problem]')!.textContent).toContain('bridge gone');
    expect(ticked()).toEqual(['primary']);
  });

  it('a file that cannot be read is shown, and the control is disabled', async () => {
    const { testDisplay } = stub(state({ readProblem: 'EISDIR: illegal operation on a directory' }));
    await render();
    expect(host.querySelector('[data-test-display-problem]')!.textContent).toContain('EISDIR');
    for (const k of keys()) expect(radio(k).disabled).toBe(true);
    // what is saved is unknown, so nothing is ticked — not even the default
    expect(ticked()).toEqual([]);
    await pick('7');
    expect(testDisplay.set).not.toHaveBeenCalled();
  });
});

describe('screens come and go', () => {
  it('a hotplug push replaces the list — an unplugged screen disappears', async () => {
    const { push } = stub(state({ saved: { kind: 'attached', value: 'right', screenId: 9 } }));
    await render();
    expect(keys()).toEqual(['primary', '7', '9']);
    await push(state({ screens: [PRIMARY, LEFT], saved: { kind: 'missing', value: 'right' } }));
    expect(keys()).toEqual(['primary', '7', 'saved']);
    expect(ticked()).toEqual(['saved']);
    expect(option('saved').textContent).toContain(en.testDisplay.missing);
  });
});

describe('fail-open', () => {
  it('no bridge: nothing is drawn', async () => {
    g.switchboard = {};
    await render();
    expect(host.innerHTML).toBe('');
  });

  it('a get that fails says so, rather than "looking" for ever', async () => {
    g.switchboard = {
      testDisplay: {
        get: vi.fn(async () => {
          throw new Error('no');
        }),
        set: vi.fn(),
        onChanged: vi.fn(() => () => undefined),
      },
    };
    await render();
    expect(keys()).toEqual([]);
    expect(host.textContent).not.toContain(en.testDisplay.loading);
    expect(host.querySelector('[role="alert"][data-test-display-problem]')!.textContent).toMatch(
      /^Could not list your screens \(.*\bno\)\.$/
    );
  });
});
