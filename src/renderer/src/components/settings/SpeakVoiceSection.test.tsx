// @vitest-environment jsdom
// Settings ▸ Notifications: the announcer's voice (#1390). No real OS voice
// anywhere — `speechSynthesis` is a stub, and the empty-list case is the one CI
// actually has.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { initI18nForTests } from '../../i18n/test-i18n';
import type { NotificationPrefs } from '../../../../shared/notifications';
import { setSharedAnnouncer, setVoicePreference, voicePreference } from '../../lib/announcer';
import { SpeakVoiceSection } from './SpeakVoiceSection';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let root: Root | null = null;
let host: HTMLElement;
const g = globalThis as unknown as Record<string, unknown>;

const zira = { name: 'Zira', voiceURI: 'Microsoft Zira', lang: 'en-US' };
const david = { name: 'David', voiceURI: 'Microsoft David', lang: 'en-US' };

function bridge(prefs: NotificationPrefs) {
  let current = { ...prefs };
  const notifications = {
    getPrefs: vi.fn(async () => current),
    setPrefs: vi.fn(async (p: Partial<NotificationPrefs>) => {
      current = { ...current, ...p };
      if (current.speakVoice === '') delete current.speakVoice;
      return current;
    }),
  };
  g.switchboard = { notifications };
  return notifications;
}

/** a stub engine whose voice list can arrive late, like Chromium's */
function engine(initial: unknown[]) {
  let voices = initial;
  const listeners = new Set<() => void>();
  g.speechSynthesis = {
    pending: false,
    speak: () => {},
    getVoices: () => voices,
    addEventListener: (_t: string, cb: () => void) => listeners.add(cb),
    removeEventListener: (_t: string, cb: () => void) => listeners.delete(cb),
  };
  return {
    arrive(next: unknown[]) {
      voices = next;
      for (const cb of listeners) cb();
    },
  };
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

async function render(): Promise<void> {
  await act(async () => {
    root!.render(<SpeakVoiceSection open />);
  });
  await settle();
}

const picker = (): HTMLSelectElement =>
  host.querySelector<HTMLSelectElement>('[data-settings-field="speak-voice"]')!;
const options = (): string[] => [...picker().options].map((o) => o.textContent ?? '');

async function pick(value: string): Promise<void> {
  await act(async () => {
    picker().value = value;
    picker().dispatchEvent(new Event('change', { bubbles: true }));
  });
  await settle();
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
  delete g.speechSynthesis;
  setSharedAnnouncer(null);
  setVoicePreference(null);
});

describe('SpeakVoiceSection (#1390)', () => {
  it('with no voices at all it offers System default and still works', async () => {
    bridge({ enabled: true });
    await render();
    expect(options()).toEqual(['System default']);
    expect(picker().value).toBe('');
    expect(picker().disabled).toBe(false);
  });

  it('lists the voices once they arrive late (voiceschanged)', async () => {
    const e = engine([]);
    bridge({ enabled: true });
    await render();
    expect(options()).toEqual(['System default']);
    await act(async () => e.arrive([zira, david]));
    expect(options()).toEqual(['System default', 'Zira (en-US)', 'David (en-US)']);
  });

  it('choosing a voice stores its voiceURI and hands it to the announcer at once', async () => {
    engine([zira, david]);
    const api = bridge({ enabled: true });
    await render();
    await pick('Microsoft David');
    expect(api.setPrefs).toHaveBeenCalledWith({ speakVoice: 'Microsoft David' });
    expect(picker().value).toBe('Microsoft David');
    expect(voicePreference()).toBe('Microsoft David');
    await pick('');
    expect(api.setPrefs).toHaveBeenLastCalledWith({ speakVoice: '' });
    expect(voicePreference()).toBeNull();
  });

  it('a stored voice that is not on this machine is shown as missing, with the fallback said', async () => {
    engine([zira]);
    bridge({ enabled: true, speakVoice: 'Microsoft David' });
    await render();
    expect(picker().value).toBe('Microsoft David');
    expect(options()).toContain('Microsoft David (not on this computer)');
    expect(host.querySelector('[data-speak-voice-fell-back]')).not.toBeNull();
  });

  it('before the voice list loads, a stored voice is shown as itself, not yet as missing', async () => {
    const e = engine([]);
    bridge({ enabled: true, speakVoice: 'Microsoft David' });
    await render();
    expect(picker().value).toBe('Microsoft David');
    expect(options()).toEqual(['System default', 'Microsoft David']);
    expect(host.querySelector('[data-speak-voice-fell-back]')).toBeNull();
    await act(async () => e.arrive([zira, david]));
    expect(options()).toEqual(['System default', 'Zira (en-US)', 'David (en-US)']);
    expect(picker().value).toBe('Microsoft David');
  });

  it('a refused write puts the picker and the announcer back', async () => {
    engine([zira, david]);
    const api = bridge({ enabled: true, speakVoice: 'Microsoft Zira' });
    api.setPrefs.mockImplementationOnce(async () => {
      throw new Error('gone');
    });
    await render();
    await pick('Microsoft David');
    expect(picker().value).toBe('Microsoft Zira');
    expect(voicePreference()).toBe('Microsoft Zira');
  });

  it('Preview speaks one sample sentence through the shared announcer', async () => {
    bridge({ enabled: true });
    const said: string[] = [];
    setSharedAnnouncer({ play: () => true, say: (text) => (said.push(text), true) });
    await render();
    const btn = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Preview')!;
    await act(async () => {
      btn.click();
    });
    expect(said).toEqual(['This is how your announcements will sound.']);
  });

  it('with no bridge the picker is disabled, not dead', async () => {
    await render();
    expect(picker().disabled).toBe(true);
  });
});
