// @vitest-environment jsdom
// The title bar's left / top switch (#1143).
//
// What a click MEANS is `placementClick`'s, and is tested there. This file is
// about what the switch tells you before you click: which half is lit, that
// neither is when the list is put away, and that each half's tooltip says what
// that particular click is about to do — the same button hides, shows or moves
// the list depending on the state it is in.
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import i18next from 'i18next';
import { initI18nForTests } from '../i18n/test-i18n';
import { SessionsPlacementSwitch } from './SessionsPlacementSwitch';
import type { SessionsPlacement } from '../lib/sessions-placement';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let root: Root | null = null;

async function mount(
  placement: SessionsPlacement,
  hidden: boolean,
  clicks: SessionsPlacement[] = []
): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <SessionsPlacementSwitch
        placement={placement}
        hidden={hidden}
        onClick={(p) => clicks.push(p)}
        binding="Ctrl+B"
      />
    );
  });
  return host;
}

const half = (host: HTMLElement, p: SessionsPlacement): HTMLButtonElement =>
  host.querySelector<HTMLButtonElement>(`[data-placement="${p}"]`)!;

beforeAll(async () => {
  await initI18nForTests();
});

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '';
});

afterEach(async () => {
  if (root) {
    const r = root;
    root = null;
    await act(async () => r.unmount());
  }
});

describe('the left / top switch (issue 1143)', () => {
  it('lights the half the list is in, and only that one', async () => {
    const host = await mount('top', false);
    expect(half(host, 'top').getAttribute('aria-pressed')).toBe('true');
    expect(half(host, 'left').getAttribute('aria-pressed')).toBe('false');
  });

  it('lights neither half while the list is put away', async () => {
    const host = await mount('top', true);
    expect(half(host, 'top').getAttribute('aria-pressed')).toBe('false');
    expect(half(host, 'left').getAttribute('aria-pressed')).toBe('false');
  });

  it('says what each click would do: hide on the lit half, move on the other', async () => {
    const host = await mount('left', false);
    expect(half(host, 'left').title).toBe(
      i18next.t('titlebar.placementHide.left', { binding: 'Ctrl+B' })
    );
    expect(half(host, 'top').title).toBe(i18next.t('titlebar.placementMove.top'));
  });

  it('says "show" on both halves while the list is put away', async () => {
    const host = await mount('left', true);
    expect(half(host, 'left').title).toBe(
      i18next.t('titlebar.placementShow.left', { binding: 'Ctrl+B' })
    );
    expect(half(host, 'top').title).toBe(
      i18next.t('titlebar.placementShow.top', { binding: 'Ctrl+B' })
    );
  });

  it('reports which half was clicked and decides nothing itself', async () => {
    const clicks: SessionsPlacement[] = [];
    const host = await mount('left', false, clicks);
    await act(async () => half(host, 'top').click());
    await act(async () => half(host, 'left').click());
    expect(clicks).toEqual(['top', 'left']);
  });
});
