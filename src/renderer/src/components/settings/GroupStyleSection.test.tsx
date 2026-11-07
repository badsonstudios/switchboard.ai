// @vitest-environment jsdom
// Settings ▸ Appearance ▸ Group style (#1556): the setting, its store, and the
// rail following it live.
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { initI18nForTests } from '../../i18n/test-i18n';
import en from '../../../../shared/i18n/locales/en.json';
import { GroupStyleSection } from './GroupStyleSection';
import {
  AVAILABLE_GROUP_STYLES,
  DEFAULT_GROUP_STYLE,
  GROUP_STYLE_KEY,
  GROUP_STYLES,
  groupStyleNumber,
  groupStyleOf,
  initGroupStyle,
  resetGroupStyleForTests,
  useGroupStyle,
} from '../../lib/group-style';
import { uiDelete, uiGet, uiSet } from '../../lib/ui-state';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let root: Root | null = null;
let host: HTMLElement;

/** stands in for the rail: what it reads, where it reads it */
function Reader(): React.JSX.Element {
  return <nav data-group-style={useGroupStyle()} />;
}

async function mount(): Promise<void> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <>
        <GroupStyleSection />
        <Reader />
      </>
    );
  });
}

const radios = (): HTMLInputElement[] =>
  Array.from(host.querySelectorAll<HTMLInputElement>('[data-group-style-option]'));
const railStyle = (): string | null => host.querySelector('nav')!.getAttribute('data-group-style');

beforeAll(async () => {
  await initI18nForTests();
});

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '';
  uiDelete([GROUP_STYLE_KEY]);
  resetGroupStyleForTests();
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
});

describe('the group style values (#1556)', () => {
  it("defaults to option 4, the folder tab (Dan's pick)", () => {
    expect(DEFAULT_GROUP_STYLE).toBe('folder');
    expect(groupStyleNumber('folder')).toBe(4);
  });

  it("numbers the styles the way the mockup does, with Classic unnumbered", () => {
    expect(GROUP_STYLES).toHaveLength(9);
    expect(groupStyleNumber('classic')).toBeUndefined();
    expect(GROUP_STYLES.map(groupStyleNumber).slice(1)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('reads every built style as itself, and anything else as the default', () => {
    for (const s of AVAILABLE_GROUP_STYLES) expect(groupStyleOf(s)).toBe(s);
    expect(groupStyleOf(undefined)).toBe('folder');
    expect(groupStyleOf('nonsense')).toBe('folder');
  });

  it('offers all nine', () => {
    expect([...AVAILABLE_GROUP_STYLES]).toEqual([...GROUP_STYLES]);
  });

  it('has words for every style, built or not', () => {
    const words = en.groupStyle as Record<string, string>;
    for (const s of GROUP_STYLES) {
      expect(words[s], s).toBeTruthy();
      expect(words[`${s}Note`], s).toBeTruthy();
    }
  });
});

describe('Settings ▸ Appearance ▸ Group style (#1556)', () => {
  it('offers the built styles in order, with the folder tab ticked by default', async () => {
    await mount();
    expect(radios().map((r) => r.dataset.groupStyleOption)).toEqual([...AVAILABLE_GROUP_STYLES]);
    expect(radios().find((r) => r.checked)?.dataset.groupStyleOption).toBe('folder');
    expect(host.textContent).toContain('4 · Folder tab');
    expect(host.textContent).toContain('Classic');
  });

  it('switches the list at once and stores the choice', async () => {
    await mount();
    expect(railStyle()).toBe('folder');
    const classic = radios().find((r) => r.dataset.groupStyleOption === 'classic')!;
    await act(async () => classic.click());
    expect(railStyle()).toBe('classic');
    expect(uiGet<unknown>(GROUP_STYLE_KEY, undefined)).toBe('classic');
    expect(radios().find((r) => r.checked)?.dataset.groupStyleOption).toBe('classic');
  });

  it('comes back as it was stored', async () => {
    uiSet(GROUP_STYLE_KEY, 'classic');
    initGroupStyle();
    await mount();
    expect(railStyle()).toBe('classic');
  });
});
