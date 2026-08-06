// @vitest-environment jsdom
// The session tab strip, and the name it says (#264).
//
// lib/card-title holds the RULES (order, empty-is-absent, folder last segment).
// What it cannot see is whether this tab is subscribed to anything: the bug was
// that `IdentityTab` read `props.api.title`, a value dockview is handed once at
// `addPanel` and that nothing ever calls `setTitle` to update. So the rail
// renamed, the record renamed, the card header renamed (#250) — and the tab
// above it, plus the confirmation you get for closing it, went on saying the
// name the session was born with.
//
// The second case is the one that was red: a rename arriving AFTER mount, with
// the panel api untouched, exactly as it arrives in the app.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import i18next from 'i18next';
import ICU from 'i18next-icu';
import { initReactI18next } from 'react-i18next';
import en from '../i18n/locales/en.json';
import { IdentityTab, type CardParams } from './SessionGrid';
import { sessionStore } from '../store/session-store';
import type { IDockviewPanelProps } from 'dockview-react';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let root: Root | null = null;
let host: HTMLElement;
const close = vi.fn();

/** A panel's props, with only the two things this tab touches: the birth-time
 *  title dockview keeps, and `close()`. */
function panelProps(
  birthTitle: string | undefined,
  params: Partial<CardParams> | undefined
): IDockviewPanelProps<CardParams> {
  return {
    api: { title: birthTitle, close },
    params,
  } as unknown as IDockviewPanelProps<CardParams>;
}

async function mount(
  birthTitle: string | undefined,
  params: Partial<CardParams> | undefined
): Promise<void> {
  await act(async () => {
    root!.render(<IdentityTab {...panelProps(birthTitle, params)} />);
  });
}

/** the name on the tab: everything in it that is not the ✕ */
function tabText(): string {
  const all = host.textContent ?? '';
  const btn = host.querySelector('button')?.textContent ?? '';
  return (btn ? all.replace(btn, '') : all).trim();
}

function rename(cardId: string, title: string): Promise<void> {
  return act(async () => {
    sessionStore.setSessions([{ id: cardId, title, folder: 'C:\\Projects\\acme' }]);
  });
}

describe('the session tab follows a rename (issue 264)', () => {
  beforeEach(async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    document.body.innerHTML = '';
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    close.mockReset();
    sessionStore.setSessions([]);
    if (!i18next.isInitialized) {
      // ICU, like the app (i18n/index.ts) — the close confirmation's `{title}`
      // is an ICU placeholder and i18next's own syntax would leave it verbatim
      await i18next
        .use(ICU)
        .use(initReactI18next)
        .init({
          lng: 'en',
          resources: { en: { translation: en } },
          interpolation: { escapeValue: false },
        });
    }
  });

  afterEach(async () => {
    if (root) {
      const r = root;
      root = null;
      await act(async () => r.unmount());
    }
    vi.unstubAllGlobals();
    sessionStore.setSessions([]);
  });

  it('shows the store name over the one the panel was born with', async () => {
    await rename('c1', 'renamed');
    await mount('at-birth', { cardId: 'c1', title: 'at-birth', folder: 'C:\\Projects\\acme' });
    expect(tabText()).toBe('renamed');
  });

  it('re-renders when the rename lands after the tab is already up', async () => {
    // THE REGRESSION. Nothing about the panel changes here — `props.api.title`
    // is still 'at-birth' — so only a store subscription can move this text.
    await rename('c1', 'at-birth');
    await mount('at-birth', { cardId: 'c1', title: 'at-birth', folder: 'C:\\Projects\\acme' });
    expect(tabText()).toBe('at-birth');

    await rename('c1', 'renamed-live');
    expect(tabText()).toBe('renamed-live');
  });

  it('keeps the birth-time title while the store has no answer yet', async () => {
    // a card's tab mounts before the first `setSessions` lands
    await mount('at-birth', { cardId: 'c1', title: 'at-birth', folder: 'C:\\Projects\\acme' });
    expect(tabText()).toBe('at-birth');
  });

  it('leaves a derived tab alone — no cardId, so the store has nothing to say', async () => {
    // the diff panel's tab. It is the same component, and its dockview title is
    // the only name it has ever had
    await rename('c1', 'renamed');
    await mount('Changes — acme', { folder: 'C:\\Projects\\acme' });
    expect(tabText()).toBe('Changes — acme');
  });

  it('confirms the close under the CURRENT name, and honours a cancel', async () => {
    const confirm = vi.fn().mockReturnValue(false);
    vi.stubGlobal('confirm', confirm);
    await rename('c1', 'at-birth');
    await mount('at-birth', { cardId: 'c1', title: 'at-birth', folder: 'C:\\Projects\\acme' });
    await rename('c1', 'renamed-live');

    await act(async () => {
      host.querySelector('button')!.click();
    });
    expect(confirm).toHaveBeenCalledWith(
      'Close "renamed-live"? This ends the session and removes the card.'
    );
    expect(close).not.toHaveBeenCalled(); // it said no
  });

  it('closes a derived tab without asking — nothing ends with it', async () => {
    const confirm = vi.fn().mockReturnValue(true);
    vi.stubGlobal('confirm', confirm);
    await mount('Changes — acme', { folder: 'C:\\Projects\\acme' });

    await act(async () => {
      host.querySelector('button')!.click();
    });
    expect(confirm).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });
});
