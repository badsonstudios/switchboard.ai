// @vitest-environment jsdom
// The settings modal (#885).
//
// This file holds the two things that are TRUE OF THE SCREEN rather than of
// any one control:
//
//  1. **The modal contract** — `aria-modal`, a name, Escape, click-away, focus
//     capture and return. It used to be asserted three times, once per
//     absorbed dialog, against three copies of the same nine lines. There is
//     one modal now, so it is pinned once, here, against the thing that
//     implements it.
//  2. **That every absorbed control is actually WIRED** — present, showing the
//     stored value, and writing through the handler it was given. The sections'
//     own test files pin what each control PROMISES; what they cannot see is
//     whether this file forgot to pass one of them a prop, which is the
//     failure mode a "we folded three dialogs into one" change actually has.
//
// Anything about an individual control's behaviour belongs in
// `settings/<Name>Section.test.tsx`, not here.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { initI18nForTests } from '../i18n/test-i18n';
import en from '../../../shared/i18n/locales/en.json';
import { SettingsDialog } from './SettingsDialog';
import { SETTINGS_SECTIONS } from '../lib/settings-sections';
import { builtinThemes } from '../theme/builtin-themes';
import type { PushConfig } from '../../../shared/push';
import type { QuietState } from '../../../shared/quiet-hours';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let root: Root | null = null;
let host: HTMLElement;

const handlers = {
  onClose: vi.fn(),
  onTheme: vi.fn(),
  onLang: vi.fn(),
  onSetTaskLabelSize: vi.fn(),
  onSetQuietWindow: vi.fn(),
  onSetPushPrefs: vi.fn(),
  onSetPushSecret: vi.fn(),
  onTestPush: vi.fn(async () => ({ ok: true })),
  onToggleExperimentalFork: vi.fn(),
  onToggleAutoCheckUpdates: vi.fn(),
  onToggleStatusPolling: vi.fn(),
};

const quiet: QuietState = {
  window: { start: '22:00', end: '07:00' },
  active: false,
  heldCount: 0,
};

const push: PushConfig = {
  prefs: { push: false, service: 'ntfy', webhook: false },
  secrets: {
    'ntfy.topic': false,
    'pushover.token': false,
    'pushover.user': false,
    'webhook.url': false,
  },
  storeAvailable: true,
};

async function render(open = true, over: Record<string, unknown> = {}): Promise<void> {
  await act(async () => {
    root!.render(
      <SettingsDialog
        open={open}
        section={null}
        pref="system"
        themes={builtinThemes}
        lang="en"
        taskLabelSize="full"
        quiet={quiet}
        push={push}
        pushWrite={null}
        experimentalFork={false}
        autoCheckUpdates
        statusPolling
        {...handlers}
        {...over}
      />
    );
  });
}

const dialog = (): HTMLElement | null => host.querySelector<HTMLElement>('[role="dialog"]');
const section = (id: string): HTMLElement | null =>
  host.querySelector<HTMLElement>(`[data-settings-section="${id}"]`);
const item = (id: string): HTMLElement | null =>
  host.querySelector<HTMLElement>(`[data-settings-item="${id}"]`);
const settingsField = (id: string): HTMLInputElement | null =>
  host.querySelector<HTMLInputElement>(`[data-settings-field="${id}"]`);

function button(label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll('button')].find((b) => b.textContent === label);
  if (!found) throw new Error(`no button labelled "${label}"`);
  return found;
}
async function click(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

/** every `data-settings-section` that was asked to scroll into view */
let scrolled: string[] = [];
/**
 * Kept as the DESCRIPTOR, not as `Element.prototype.scrollIntoView`: pulling a
 * prototype method into a variable is `unbound-method` (#255 T4). Putting it
 * back through `defineProperty` is the same restore.
 */
const realScrollIntoView = Object.getOwnPropertyDescriptor(
  Element.prototype,
  'scrollIntoView'
);

beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  // jsdom implements no layout, so `scrollIntoView` does not exist on its own.
  // Stubbed here and RESTORED in afterEach: leaving it installed would hand the
  // next test in this file whichever recorder ran last.
  scrolled = [];
  Element.prototype.scrollIntoView = function (this: Element): void {
    scrolled.push(this.getAttribute('data-settings-section') ?? '?');
  };
  for (const h of Object.values(handlers)) h.mockReset();
  handlers.onTestPush.mockImplementation(async () => ({ ok: true }));
  document.body.innerHTML = '';
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await initI18nForTests();
});

afterEach(async () => {
  if (realScrollIntoView) {
    Object.defineProperty(Element.prototype, 'scrollIntoView', realScrollIntoView);
  }
  if (root) {
    const r = root;
    root = null;
    await act(async () => r.unmount());
  }
});

describe('the modal contract, declared once for the whole screen', () => {
  it('renders nothing when closed', async () => {
    await render(false);
    expect(dialog()).toBeNull();
  });

  it('is a labelled modal, so a screen reader announces what opened', async () => {
    await render();
    expect(dialog()?.getAttribute('aria-modal')).toBe('true');
    expect(dialog()?.getAttribute('aria-label')).toBe(en.settings.title);
  });

  it('closes on Escape', async () => {
    await render();
    await act(async () => {
      dialog()!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      );
    });
    expect(handlers.onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on a click outside, and not on a click inside', async () => {
    await render();
    await act(async () => {
      dialog()!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    });
    expect(handlers.onClose).not.toHaveBeenCalled();
    await act(async () => {
      // the scrim — the modal's outermost element
      host
        .querySelector('div')!
        .dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    });
    expect(handlers.onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on the Done button', async () => {
    await render();
    await click(button(en.settings.close));
    expect(handlers.onClose).toHaveBeenCalledTimes(1);
  });

  it('takes focus on open, so Escape reaches the handler', async () => {
    await render();
    expect(document.activeElement).toBe(dialog());
  });
});

describe('the sections', () => {
  it('renders every section in the vocabulary', async () => {
    await render();
    for (const id of SETTINGS_SECTIONS) {
      expect(section(id), `no section for ${id}`).not.toBeNull();
    }
  });

  it('scrolls to the section it was opened at', async () => {
    // The palette aliases (quiet hours, phone push, task label size) keep
    // working by landing on the right part of this screen rather than on its
    // top. jsdom has no layout, so `scrollIntoView` does not exist unless we
    // put it there — which is also the only way to observe that it was asked.
    await render(true, { section: 'attention' });
    expect(scrolled).toEqual(['attention']);
  });

  it('does not scroll anywhere when it was opened with no section', async () => {
    await render();
    expect(scrolled).toEqual([]);
  });

  // ⚠️ THE HALF jsdom CANNOT SEE, stated here so the next reader does not think
  // the assertion above covers it. `focus()` also scrolls, and a section that
  // focuses itself on mount takes the modal with it — which is exactly what
  // `PushSection`'s focus rescue did until review caught it: opened with NO
  // section, the modal appeared scrolled down to the credential fields. jsdom
  // has no layout, so nothing here can measure `scrollTop`. The guard is
  // `e2e/chrome.spec.ts` › "Settings opens at the top".
});

// Every absorbed control, checked for the ONE thing its own test file cannot
// see: that this screen actually handed it its props. Each case reads the
// stored value back and then writes through — a control wired to nothing
// passes neither half.
describe('every absorbed control is wired', () => {
  it('theme — shows the stored preference and writes a pick through', async () => {
    await render(true, { pref: 'daylight' });
    expect(item('theme')).not.toBeNull();
    await click(button(en.theme.nordic));
    expect(handlers.onTheme).toHaveBeenCalledWith('nordic');
  });

  it('theme — offers system and every theme the app actually resolved', async () => {
    // Not a hard-coded list: a theme added to the registry and missing from
    // the picker is a theme nobody can choose.
    await render();
    expect(() => button(en.theme.system)).not.toThrow();
    for (const th of builtinThemes) {
      const name = (en.theme as Record<string, string>)[th.nameKey.replace('theme.', '')];
      expect(() => button(name), `no button for ${th.id}`).not.toThrow();
    }
  });

  it('language — writes a pick through', async () => {
    await render();
    await click(button(en.language.pseudo));
    expect(handlers.onLang).toHaveBeenCalledWith('pseudo');
  });

  it('task label size — shows the stored size and writes a pick through', async () => {
    await render(true, { taskLabelSize: 'medium' });
    expect(
      host.querySelector<HTMLInputElement>('[data-task-label-size="medium"]')?.checked
    ).toBe(true);
    await act(async () => {
      host.querySelector<HTMLInputElement>('[data-task-label-size="compact"]')!.click();
    });
    expect(handlers.onSetTaskLabelSize).toHaveBeenCalledWith('compact');
  });

  it('quiet hours — seeds from the state it was given and writes through', async () => {
    await render();
    expect(host.querySelector<HTMLInputElement>('[data-quiet-field="start"]')?.value).toBe('22:00');
    await click(host.querySelector('[data-quiet-field="enabled"]')!);
    expect(handlers.onSetQuietWindow).toHaveBeenCalledWith(null);
  });

  it('phone push — renders the config it was given and writes a switch through', async () => {
    await render();
    expect(host.querySelector('[data-push-field="ntfy.topic"]')).not.toBeNull();
    await act(async () => {
      host.querySelector<HTMLInputElement>('[data-push-field="enable-push"]')!.click();
    });
    expect(handlers.onSetPushPrefs).toHaveBeenCalledWith({ push: true });
  });

  it('the experimental fork switch — reads the stored value and writes through', async () => {
    await render(true, { experimentalFork: true });
    expect(settingsField('experimental-fork')?.checked).toBe(true);
    await act(async () => {
      settingsField('experimental-fork')!.click();
    });
    expect(handlers.onToggleExperimentalFork).toHaveBeenCalled();
  });

  it('automatic update checks — reads the stored value and writes through', async () => {
    await render(true, { autoCheckUpdates: false });
    expect(settingsField('auto-check-updates')?.checked).toBe(false);
    await act(async () => {
      settingsField('auto-check-updates')!.click();
    });
    expect(handlers.onToggleAutoCheckUpdates).toHaveBeenCalledWith(true);
  });

  it('provider status polling — reads the stored value and writes through', async () => {
    await render(true, { statusPolling: true });
    expect(settingsField('status-polling')?.checked).toBe(true);
    await act(async () => {
      settingsField('status-polling')!.click();
    });
    expect(handlers.onToggleStatusPolling).toHaveBeenCalledWith(false);
  });

  // The two that are OPTIONAL, exactly as they were on the About panel: a
  // broken preload bridge must cost this screen nothing rather than render a
  // tick box that writes into the void (the fail-open rule).
  it('omits the network preferences entirely when there is no handler for them', async () => {
    await render(true, {
      onToggleAutoCheckUpdates: undefined,
      onToggleStatusPolling: undefined,
    });
    expect(settingsField('auto-check-updates')).toBeNull();
    expect(settingsField('status-polling')).toBeNull();
    // …and the section is still there, because the fork switch is not optional
    expect(section('advanced')).not.toBeNull();
  });
});
