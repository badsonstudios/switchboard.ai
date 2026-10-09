// @vitest-environment jsdom
// The arrangement buttons in the top bar (#1147).
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { initI18nForTests } from '../i18n/test-i18n';
import { BAR_PRESETS, LayoutPresets } from './LayoutPresets';
import { LAYOUT_PRESETS } from '../lib/layout-presets';
import en from '../../../shared/i18n/locales/en.json';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let root: Root | null = null;
let said: string[] = [];

async function mount(disabled = false): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <LayoutPresets
        disabled={disabled}
        onPreset={(p) => said.push(p)}
        onEqualize={() => said.push('equalize')}
      />
    );
  });
  return host;
}

const buttons = (host: HTMLElement): HTMLElement[] =>
  Array.from(host.querySelectorAll<HTMLElement>('[data-layout-preset]'));

beforeAll(async () => {
  await initI18nForTests();
});

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '';
  said = [];
});

afterEach(async () => {
  if (root) {
    const r = root;
    root = null;
    await act(async () => r.unmount());
  }
});

describe('the arrangement buttons (issue 1147)', () => {
  it('are the four the owner asked for, then "make them even"', async () => {
    const host = await mount();
    expect(buttons(host).map((b) => b.dataset.layoutPreset)).toEqual([
      'columns2',
      'columns3',
      'rows',
      'grid',
      'equalize',
    ]);
  });

  it('leave out only "one place": the bar has room for five', () => {
    expect(LAYOUT_PRESETS.filter((p) => !BAR_PRESETS.includes(p))).toEqual(['single']);
  });

  it('each says in words what its picture means, because a picture alone is not a name', async () => {
    const host = await mount();
    for (const b of buttons(host)) {
      expect(b.getAttribute('aria-label')).toBeTruthy();
      expect(b.title).toBeTruthy();
      // the drawing is decoration to a screen reader
      expect(b.querySelector('svg')!.getAttribute('aria-hidden')).not.toBeNull();
    }
    expect(buttons(host)[0].getAttribute('aria-label')).toBe(en.layout.preset.columns2);
    expect(buttons(host)[4].getAttribute('aria-label')).toBe(en.layout.equalize);
  });

  it('are one named group', async () => {
    const host = await mount();
    const group = host.querySelector('[role="group"]')!;
    expect(group.getAttribute('aria-label')).toBe(en.layout.presetsLabel);
  });

  it('a click asks for that arrangement, once', async () => {
    const host = await mount();
    await act(async () => buttons(host)[1].click());
    await act(async () => buttons(host)[4].click());
    expect(said).toEqual(['columns3', 'equalize']);
  });

  it('with nothing to arrange they stay findable, do nothing, and say why', async () => {
    const host = await mount(true);
    for (const b of buttons(host)) {
      expect(b.getAttribute('aria-disabled')).toBe('true');
      // NOT the `disabled` attribute: that would take it out of the Tab order
      expect(b.hasAttribute('disabled')).toBe(false);
      // still names itself, then gives the reason
      expect(b.title).toContain(en.layout.presetsNothing);
      expect(b.title).toContain(b.getAttribute('aria-label')!);
      await act(async () => b.click());
    }
    expect(said).toEqual([]);
  });
});
