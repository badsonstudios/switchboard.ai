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
import { resetSettingsTabForTests, SettingsDialog } from './SettingsDialog';
import { SETTINGS_SECTIONS, stepSettingsSection } from '../lib/settings-sections';
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
  onSetSessionsPlacement: vi.fn(),
  onSetWorkingLook: vi.fn(),
  onSetContextMeter: vi.fn(),
  onSetQuietWindow: vi.fn(),
  onSetPushPrefs: vi.fn(),
  onSetDispatchRetire: vi.fn(),
  onSetPushSecret: vi.fn(),
  onTestPush: vi.fn(async () => ({ ok: true })),
  onToggleExperimentalFork: vi.fn(),
  onToggleAutoCheckUpdates: vi.fn(),
  onToggleStatusPolling: vi.fn(),
  onTogglePerfCapture: vi.fn(),
  onRevealCapture: vi.fn(),
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
        sessionsPlacement="left"
        workingLook="fill"
        contextMeter="percent"
        dispatchRetire="linger"
        quiet={quiet}
        push={push}
        pushWrite={null}
        experimentalFork={false}
        autoCheckUpdates
        statusPolling
        perfCapture={false}
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
  // which tab was last shown is remembered for the run; not between tests
  resetSettingsTabForTests();
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

  // #1199 — the fourteen settings are in tabs. The owner: "We need to organize
  // the settings a little more, possibly with some tabs."
  describe('tabs (#1199)', () => {
    const tab = (id: string): HTMLButtonElement =>
      host.querySelector<HTMLButtonElement>(`[data-settings-tab="${id}"]`)!;
    const showing = (): string[] =>
      SETTINGS_SECTIONS.filter((id) => section(id)!.hidden === false);
    const key = async (el: Element, k: string): Promise<void> => {
      await act(async () => {
        el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
      });
    };

    it('one tab per section, in order, and exactly one panel showing', async () => {
      await render();
      const tabs = [...host.querySelectorAll<HTMLElement>('[role="tab"]')];
      expect(tabs.map((b) => b.dataset.settingsTab)).toEqual([...SETTINGS_SECTIONS]);
      expect(tabs.map((b) => b.textContent)).toEqual([
        'Appearance',
        'General',
        'Notifications',
        'Sessions',
        'Diagnostics',
        'Advanced',
      ]);
      // it opens on Appearance the first time
      expect(showing()).toEqual(['appearance']);
      expect(tab('appearance').getAttribute('aria-selected')).toBe('true');
    });

    it('every setting is on exactly ONE tab: none dropped, none shown twice', async () => {
      await render();
      const where = (id: string): string[] =>
        [...host.querySelectorAll<HTMLElement>(`[data-settings-item="${id}"]`)].map(
          (el) => el.closest<HTMLElement>('[data-settings-section]')!.dataset.settingsSection!
        );
      expect(where('theme')).toEqual(['appearance']);
      expect(where('context-meter')).toEqual(['appearance']);
      expect(where('language')).toEqual(['general']);
      expect(where('updates')).toEqual(['general']);
      expect(where('status-polling')).toEqual(['general']);
      expect(where('experimental-fork')).toEqual(['advanced']);
      // ...and each panel has something in it
      for (const id of SETTINGS_SECTIONS) {
        expect(section(id)!.textContent.length, id).toBeGreaterThan(0);
      }
    });

    it('a click shows that tab’s panel and hides the rest', async () => {
      await render();
      await click(tab('general'));
      expect(showing()).toEqual(['general']);
      expect(tab('general').getAttribute('aria-selected')).toBe('true');
      expect(tab('appearance').getAttribute('aria-selected')).toBe('false');
    });

    it('each tab names its panel, and each panel its tab', async () => {
      await render();
      for (const id of SETTINGS_SECTIONS) {
        const panel = section(id)!;
        expect(panel.getAttribute('role')).toBe('tabpanel');
        expect(tab(id).getAttribute('aria-controls')).toBe(panel.id);
        expect(panel.getAttribute('aria-labelledby')).toBe(tab(id).id);
      }
    });

    it('is ONE tab stop: the arrow keys move along it, and the panel follows', async () => {
      await render();
      const stops = (): string[] =>
        [...host.querySelectorAll<HTMLElement>('[role="tab"]')]
          .filter((b) => b.tabIndex === 0)
          .map((b) => b.dataset.settingsTab!);
      expect(stops()).toEqual(['appearance']);
      await key(tab('appearance'), 'ArrowRight');
      expect(showing()).toEqual(['general']);
      expect(stops()).toEqual(['general']);
      expect(document.activeElement).toBe(tab('general'));
      // wraps at both ends
      await key(tab('general'), 'ArrowLeft');
      await key(tab('appearance'), 'ArrowLeft');
      expect(showing()).toEqual(['advanced']);
      await key(tab('advanced'), 'Home');
      expect(showing()).toEqual(['appearance']);
      await key(tab('appearance'), 'End');
      expect(showing()).toEqual(['advanced']);
    });

    it('a deep link opens on the tab that owns the section', async () => {
      await render(true, { section: 'attention' });
      expect(showing()).toEqual(['attention']);
      expect(scrolled).toEqual(['attention']);
    });

    it('reopening lands on the tab you were last on, unless a section is asked for', async () => {
      await render();
      await click(tab('sessions'));
      await render(false);
      await render();
      expect(showing()).toEqual(['sessions']);
      await render(false);
      await render(true, { section: 'diagnostics' });
      expect(showing()).toEqual(['diagnostics']);
    });

    it('a panel you leave keeps what was in it', async () => {
      // all six are mounted; the ones not showing are only hidden
      await render();
      const before = item('language');
      await click(tab('general'));
      await click(tab('appearance'));
      expect(item('language')).toBe(before);
    });

    it('the keyboard contract, as a table', () => {
      expect(stepSettingsSection('appearance', 'ArrowRight')).toBe('general');
      expect(stepSettingsSection('appearance', 'ArrowLeft')).toBe('advanced');
      expect(stepSettingsSection('advanced', 'ArrowRight')).toBe('appearance');
      // mirrored when the layout is
      expect(stepSettingsSection('appearance', 'ArrowLeft', true)).toBe('general');
      expect(stepSettingsSection('general', 'Home')).toBe('appearance');
      expect(stepSettingsSection('general', 'End')).toBe('advanced');
      expect(stepSettingsSection('general', 'Enter')).toBeNull();
    });
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

  it('sessions list — shows where it is and writes a pick through', async () => {
    await render(true, { sessionsPlacement: 'top' });
    expect(
      host.querySelector<HTMLInputElement>('[data-sessions-placement="top"]')?.checked
    ).toBe(true);
    expect(
      host.querySelector<HTMLInputElement>('[data-sessions-placement="left"]')?.checked
    ).toBe(false);
    await act(async () => {
      host.querySelector<HTMLInputElement>('[data-sessions-placement="left"]')!.click();
    });
    expect(handlers.onSetSessionsPlacement).toHaveBeenCalledWith('left');
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

  it('the performance capture switch — reads the stored value and writes through (#923)', async () => {
    await render(true, { perfCapture: true });
    expect(settingsField('perf-capture')?.checked).toBe(true);
    await act(async () => {
      settingsField('perf-capture')!.click();
    });
    expect(handlers.onTogglePerfCapture).toHaveBeenCalledWith(false);
  });

  it('the capture switch is OFF by default (#923)', async () => {
    // An instrument that costs speed to run may not arrive switched on, and
    // this is the assertion that the default did not drift.
    await render(true);
    expect(settingsField('perf-capture')?.checked).toBe(false);
  });

  it('says the word ON or OFF, never colour alone (§5.32, #923)', async () => {
    await render(true, { perfCapture: false });
    expect(item('perf-capture')?.textContent ?? '').toMatch(/Off/);
    await render(true, { perfCapture: true });
    expect(item('perf-capture')?.textContent ?? '').toMatch(/On/);
  });

  it('omits the reveal button entirely when the bridge cannot show a file (#923)', async () => {
    // Same fail-open rule as the network preferences above.
    await render(true, { onRevealCapture: undefined });
    expect(item('perf-capture-file')).toBeNull();
    // …and the section survives, because the switch itself is not optional.
    expect(section('diagnostics')).not.toBeNull();
  });

  it('greys the reveal button until a capture exists (#923)', async () => {
    // Unlike a switch, a button that opens a folder genuinely has nothing to do
    // before the first capture — a state worth showing rather than hiding.
    await render(true, { hasCapture: false });
    const button = item('perf-capture-file')?.querySelector('button');
    expect(button?.disabled).toBe(true);

    await render(true, { hasCapture: true });
    expect(item('perf-capture-file')?.querySelector('button')?.disabled).toBe(false);
  });
});
