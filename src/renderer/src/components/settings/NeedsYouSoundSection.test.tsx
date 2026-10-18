// @vitest-environment jsdom
// Settings ▸ Notifications: the needs-you cue's switch (#1267). ON by default,
// off with one click, and a row that cannot reach main is disabled rather than
// a box that does nothing.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { initI18nForTests } from '../../i18n/test-i18n';
import type { NotificationPrefs } from '../../../../shared/notifications';
import { setSharedAnnouncer } from '../../lib/announcer';
import { NeedsYouSoundSection } from './NeedsYouSoundSection';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let root: Root | null = null;
let host: HTMLElement;
const g = globalThis as { switchboard?: unknown };

function bridge(prefs: NotificationPrefs) {
  let current = { ...prefs };
  const notifications = {
    getPrefs: vi.fn(async () => current),
    setPrefs: vi.fn(async (p: Partial<NotificationPrefs>) => (current = { ...current, ...p })),
  };
  g.switchboard = { notifications };
  return notifications;
}

async function render(): Promise<void> {
  await act(async () => {
    root!.render(<NeedsYouSoundSection open />);
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

const box = (): HTMLInputElement =>
  host.querySelector<HTMLInputElement>('[data-settings-field="needs-you-sound"]')!;

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
  setSharedAnnouncer(null);
});

describe('NeedsYouSoundSection (#1267)', () => {
  it('shows ON for a workspace that has never said (absent is ON)', async () => {
    bridge({ enabled: true });
    await render();
    expect(box().checked).toBe(true);
    expect(box().disabled).toBe(false);
  });

  it('unticking writes the switch through, and only that field', async () => {
    const api = bridge({ enabled: true, needsYouSound: true });
    await render();
    await act(async () => {
      box().click();
    });
    expect(api.setPrefs).toHaveBeenCalledWith({ needsYouSound: false });
    expect(box().checked).toBe(false);
  });

  it('a write that fails puts the box back: it never claims a setting that was not saved', async () => {
    const api = bridge({ enabled: true, needsYouSound: true });
    api.setPrefs.mockImplementationOnce(async () => {
      throw new Error('gone');
    });
    await render();
    await act(async () => {
      box().click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(box().checked).toBe(true);
  });

  it('with no bridge the box is disabled, not dead', async () => {
    await render();
    expect(box().disabled).toBe(true);
  });

  it('"Play it" plays the needs-you cue', async () => {
    bridge({ enabled: true });
    const played: string[] = [];
    setSharedAnnouncer({ play: (id) => (played.push(id), true), say: () => true });
    await render();
    const btn = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Play it')!;
    await act(async () => {
      btn.click();
    });
    expect(played).toEqual(['needs-you']);
  });
});
