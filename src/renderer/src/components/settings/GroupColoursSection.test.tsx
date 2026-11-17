// @vitest-environment jsdom
// Settings ▸ Appearance ▸ Group colours (#1599): the setting, its store, the
// colour a card is drawn in, and the rail following it live. The contrast of
// the neutral colour in every theme and style is `tokens.drift.test.ts`'s.
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { initI18nForTests } from '../../i18n/test-i18n';
import { GroupColoursSection } from './GroupColoursSection';
import {
  GROUP_COLOURS_KEY,
  NEUTRAL_GROUP_COLOUR,
  drawnGroupColour,
  groupColoursOf,
  initGroupColours,
  resetGroupColoursForTests,
  useGroupColours,
} from '../../lib/group-colours';
import { uiDelete, uiGet, uiSet } from '../../lib/ui-state';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let root: Root | null = null;
let host: HTMLElement;

/** stands in for the rail: what it reads, and the colour it draws a group in */
function Reader(): React.JSX.Element {
  const on = useGroupColours();
  return <nav data-group-colours={on ? 'on' : 'off'} data-drawn={drawnGroupColour('group', '#3aa675', on)} />;
}

async function mount(): Promise<void> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <>
        <GroupColoursSection />
        <Reader />
      </>
    );
  });
}

const box = (): HTMLInputElement => host.querySelector<HTMLInputElement>('[data-settings-field="groupColours"] input, input[data-settings-field="groupColours"]')!;
const nav = (): HTMLElement => host.querySelector('nav')!;

beforeAll(async () => {
  await initI18nForTests();
});

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '';
  uiDelete([GROUP_COLOURS_KEY]);
  resetGroupColoursForTests();
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
});

describe('group colours (#1599)', () => {
  it('is ON unless it was turned off: a missing or strange stored value keeps colour', () => {
    expect(groupColoursOf(undefined)).toBe(true);
    expect(groupColoursOf('off')).toBe(true);
    expect(groupColoursOf(true)).toBe(true);
    expect(groupColoursOf(false)).toBe(false);
  });

  it('only a group you made loses its colour; automatic groups and "No group" keep their tokens', () => {
    expect(drawnGroupColour('group', '#3aa675', true)).toBe('#3aa675');
    expect(drawnGroupColour('group', '#3aa675', false)).toBe(NEUTRAL_GROUP_COLOUR);
    expect(drawnGroupColour('auto', 'var(--auto-ink)', false)).toBe('var(--auto-ink)');
    expect(drawnGroupColour('ungrouped', 'var(--muted)', false)).toBe('var(--muted)');
  });

  it('the neutral is the theme grey the contrast test measures', () => {
    expect(NEUTRAL_GROUP_COLOUR).toBe('var(--group-frame)');
  });

  it('the checkbox turns it off and on live, stores only the switch, and the group colour comes back exactly', async () => {
    await mount();
    expect(box().checked).toBe(true);
    expect(nav().getAttribute('data-drawn')).toBe('#3aa675');
    await act(async () => box().click());
    expect(nav().getAttribute('data-group-colours')).toBe('off');
    expect(nav().getAttribute('data-drawn')).toBe(NEUTRAL_GROUP_COLOUR);
    expect(uiGet(GROUP_COLOURS_KEY, undefined)).toBe(false);
    expect(host.querySelector('[data-group-colours-hint]')!.textContent).toMatch(/kept/);
    await act(async () => box().click());
    expect(nav().getAttribute('data-drawn')).toBe('#3aa675');
    expect(uiGet(GROUP_COLOURS_KEY, undefined)).toBe(true);
  });

  it('reads what was stored when the window starts', () => {
    uiSet(GROUP_COLOURS_KEY, false);
    initGroupColours();
    let seen: boolean | undefined;
    function Probe(): null {
      seen = useGroupColours();
      return null;
    }
    host = document.createElement('div');
    root = createRoot(host);
    act(() => root!.render(<Probe />));
    expect(seen).toBe(false);
  });
});
