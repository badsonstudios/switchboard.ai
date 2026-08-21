// The renderer's half of #526: the four labels reach main, and reach it again
// when the language changes.
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import i18next from 'i18next';
import { initI18nForTests } from '../i18n/test-i18n';
import { contextMenuLabels, publishContextMenuLabels } from './context-menu-labels';
import type { ContextMenuLabels } from '../../../shared/context-menu';

beforeAll(async () => {
  await initI18nForTests();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await i18next.changeLanguage('en');
});

describe('contextMenuLabels', () => {
  it('resolves the four catalogue keys — a missing one would come back as its key', () => {
    expect(contextMenuLabels(i18next)).toEqual({
      cut: 'Cut',
      copy: 'Copy',
      paste: 'Paste',
      selectAll: 'Select All',
    });
  });

  it('follows the language — pseudo proves the strings are not baked in', async () => {
    await i18next.changeLanguage('pseudo');
    const l = contextMenuLabels(i18next);
    // pseudolocalized, so: still four strings, none of them the English one
    expect(l.paste).not.toBe('Paste');
    expect(l.paste.length).toBeGreaterThan(0);
  });
});

describe('publishContextMenuLabels', () => {
  // Typed to the bridge call's real signature. A bare `vi.fn()` records
  // `any[]`, and the language test below reads `send.mock.calls[1][0].paste` —
  // on an `any` that member access is unchecked, so a rename of the field
  // would keep passing as `undefined !== 'Paste'` (#255 T4).
  function bridge() {
    const setContextMenuLabels = vi.fn<(labels: ContextMenuLabels) => void>();
    vi.stubGlobal('window', { switchboard: { setContextMenuLabels } });
    return setContextMenuLabels;
  }

  it('publishes once immediately — a window that opens first still gets words', () => {
    const send = bridge();
    const off = publishContextMenuLabels(i18next);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toEqual({
      cut: 'Cut',
      copy: 'Copy',
      paste: 'Paste',
      selectAll: 'Select All',
    });
    off();
  });

  it('republishes on a language change, and stops after unsubscribe', async () => {
    const send = bridge();
    const off = publishContextMenuLabels(i18next);
    await i18next.changeLanguage('pseudo');
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0].paste).not.toBe('Paste');
    off();
    await i18next.changeLanguage('en');
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('fails open when there is no bridge at all', () => {
    vi.stubGlobal('window', {});
    // main holds English defaults; a missing preload must cost a language, not
    // a menu — and must never throw into the boot path (PHILOSOPHY §3)
    expect(() => publishContextMenuLabels(i18next)()).not.toThrow();
  });
});
