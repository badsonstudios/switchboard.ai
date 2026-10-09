// @vitest-environment jsdom
// The effort chip beside the model chip (#1115).
//
// The claims: it shows what the SESSION says it is on; it offers the levels the
// CLI listed for this model; a choice is set and, when it took, remembered for
// the card; a choice that did not take leaves the chip on the level really in
// force and says why; a model with no effort levels gets no chip; and a bridge
// with no effort channel is no chip, never an error.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { initI18nForTests } from '../i18n/test-i18n';
import { EFFORT_RETRY_MS, EffortChip, effortKey, resetEffortRestores } from './EffortChip';
import { uiDelete, uiGet, uiSet } from '../lib/ui-state';
import type { ControlVerdict } from '../../../shared/control';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let root: Root | null = null;
let host: HTMLElement;
/** what the "session" is on, and what it lists */
let applied: string | null;
let levels: string[];
let calls: Array<[string, ...unknown[]]>;
/** what the next setEffort answers; `null` means "do what a real one does" */
let setAnswer: ControlVerdict | null;

const ok = (response: Record<string, unknown>): ControlVerdict => ({ ok: true, response });

function installBridge(): void {
  (window as unknown as { switchboard: unknown }).switchboard = {
    sessions: {
      effort: (id: string) => {
        calls.push(['effort', id]);
        return Promise.resolve(ok({ effort: applied, levels: applied === null ? [] : levels }));
      },
      setEffort: (id: string, level: string) => {
        calls.push(['setEffort', id, level]);
        if (setAnswer) return Promise.resolve(setAnswer);
        applied = level;
        return Promise.resolve(ok({ effort: level }));
      },
    },
  };
}

async function mount(
  props: { liveId?: string; cardId?: string; model?: string | null; working?: boolean } = {}
): Promise<void> {
  if (!root) {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  }
  await act(async () => {
    root!.render(
      <EffortChip
        liveId={props.liveId ?? 'live-1'}
        cardId={'cardId' in props ? props.cardId : 'card-1'}
        model={props.model ?? 'claude-opus-5-5'}
        working={props.working}
      />
    );
  });
  // the effect's promise chain: the read, and possibly a restore after it
  for (let i = 0; i < 4; i++) await act(async () => Promise.resolve());
}

const chip = (): HTMLSelectElement | null =>
  host.querySelector<HTMLSelectElement>('[data-testid="composer-effort"]');
const notice = (): HTMLElement | null =>
  host.querySelector<HTMLElement>('[data-testid="composer-effort-notice"]');

async function choose(value: string): Promise<void> {
  const el = chip()!;
  await act(async () => {
    el.value = value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  for (let i = 0; i < 3; i++) await act(async () => Promise.resolve());
}

beforeAll(async () => {
  await initI18nForTests();
});

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '';
  applied = 'medium';
  levels = ['low', 'medium', 'high', 'xhigh', 'max'];
  calls = [];
  setAnswer = null;
  uiDelete([effortKey('card-1')]);
  resetEffortRestores();
  installBridge();
});

afterEach(async () => {
  if (root) {
    const r = root;
    root = null;
    await act(async () => r.unmount());
  }
  uiDelete([effortKey('card-1')]);
});

describe('what the chip shows (issue 1115)', () => {
  it('the level the SESSION says it is on, asked for the composer’s own session', async () => {
    applied = 'high';
    await mount({ liveId: 'live-7' });
    expect(chip()!.value).toBe('high');
    expect(calls[0]).toEqual(['effort', 'live-7']);
  });

  it('offers exactly the levels the CLI listed, in its order, in words', async () => {
    levels = ['low', 'medium', 'high'];
    await mount();
    expect(Array.from(chip()!.options).map((o) => o.value)).toEqual(['low', 'medium', 'high']);
    expect(chip()!.options[1].textContent).toBe('effort: medium');
  });

  it('a level it has no word for is shown by its own name, not dropped', async () => {
    levels = ['low', 'ludicrous'];
    applied = 'ludicrous';
    await mount();
    expect(chip()!.value).toBe('ludicrous');
    expect(chip()!.options[1].textContent).toBe('effort: ludicrous');
  });

  it('has a name a screen reader can say', async () => {
    await mount();
    expect(chip()!.getAttribute('aria-label')).toBe('How hard the model thinks');
  });

  it('is not there at all for a model with no effort levels', async () => {
    applied = null;
    await mount();
    expect(chip()).toBeNull();
  });

  it('asks again when the session’s model changes: both answers depend on it', async () => {
    await mount({ model: 'claude-opus-5-5' });
    expect(chip()).not.toBeNull();
    applied = null; // the new model has no effort levels
    await mount({ model: 'claude-haiku-4-5' });
    expect(calls.filter((c) => c[0] === 'effort')).toHaveLength(2);
    expect(chip()).toBeNull();
  });
});

describe('choosing a level', () => {
  it('sets it on the session, shows it, and remembers it for the card', async () => {
    await mount();
    await choose('xhigh');
    expect(calls).toContainEqual(['setEffort', 'live-1', 'xhigh']);
    expect(chip()!.value).toBe('xhigh');
    expect(uiGet<string>(effortKey('card-1'), '')).toBe('xhigh');
    expect(notice()).toBeNull();
  });

  it('⚠️ a level that did not take leaves the chip where the session really is, and says why', async () => {
    await mount();
    setAnswer = {
      ok: false,
      reason: 'refused',
      message: 'the session did not take "max"; it is still on "medium"',
    };
    await choose('max');
    expect(chip()!.value).toBe('medium');
    expect(notice()!.textContent).toContain('still on "medium"');
    expect(notice()!.getAttribute('role')).toBe('status');
    // and nothing is remembered for a choice that never happened
    expect(uiGet<string>(effortKey('card-1'), '')).toBe('');
  });

  it('a channel that fails outright is said too, and the chip is usable again', async () => {
    await mount();
    (
      window as unknown as { switchboard: { sessions: { setEffort: () => Promise<never> } } }
    ).switchboard.sessions.setEffort = () => Promise.reject(new Error('gone'));
    await choose('high');
    expect(chip()!.value).toBe('medium');
    expect(notice()).not.toBeNull();
    expect(chip()!.disabled).toBe(false);
  });

  it('the next good choice clears the complaint', async () => {
    await mount();
    setAnswer = { ok: false, reason: 'timed-out', message: 'nobody answered' };
    await choose('max');
    expect(notice()).not.toBeNull();
    setAnswer = null;
    await choose('high');
    expect(notice()).toBeNull();
    expect(chip()!.value).toBe('high');
  });

  it('with no card to remember it for, it still sets it', async () => {
    await mount({ cardId: undefined });
    await choose('low');
    expect(chip()!.value).toBe('low');
  });
});

describe('putting a remembered level back when the card’s session starts again', () => {
  it('sets the remembered level on the new session, once', async () => {
    uiSet(effortKey('card-1'), 'high');
    await mount({ liveId: 'live-2' }); // comes up on the default, `medium`
    expect(calls).toContainEqual(['setEffort', 'live-2', 'high']);
    expect(chip()!.value).toBe('high');
    // a re-read (the model chip repainting, say) does not set it again
    await mount({ liveId: 'live-2', model: 'claude-opus-5-5[1m]' });
    expect(calls.filter((c) => c[0] === 'setEffort')).toHaveLength(1);
  });

  it('does not fight a level this model does not have', async () => {
    uiSet(effortKey('card-1'), 'xhigh');
    levels = ['low', 'medium', 'high'];
    await mount();
    expect(calls.some((c) => c[0] === 'setEffort')).toBe(false);
    expect(chip()!.value).toBe('medium');
  });

  it('a remembered level that will not go back is not shown as in force', async () => {
    uiSet(effortKey('card-1'), 'high');
    setAnswer = { ok: false, reason: 'refused', message: 'no' };
    await mount();
    expect(chip()!.value).toBe('medium');
  });
});

describe('once per SESSION, not once per time the card is shown (found in review)', () => {
  it('⚠️ a level changed some other way is not put back when the card is shown again', async () => {
    uiSet(effortKey('card-1'), 'high');
    await mount({ liveId: 'live-3' });
    expect(calls.filter((c) => c[0] === 'setEffort')).toHaveLength(1);

    // the card's tab is switched away from: the chip unmounts, the session lives on
    const r = root!;
    root = null;
    await act(async () => r.unmount());
    // meanwhile the level changes without the chip (the CLI's own command, say)
    applied = 'low';

    await mount({ liveId: 'live-3' });
    expect(chip()!.value).toBe('low');
    expect(calls.filter((c) => c[0] === 'setEffort')).toHaveLength(1);
  });

  it('a restore the session refused is not retried on every visit', async () => {
    uiSet(effortKey('card-1'), 'high');
    setAnswer = { ok: false, reason: 'refused', message: 'no' };
    await mount({ liveId: 'live-4' });
    const r = root!;
    root = null;
    await act(async () => r.unmount());
    await mount({ liveId: 'live-4' });
    expect(calls.filter((c) => c[0] === 'setEffort')).toHaveLength(1);
  });

  it('a NEW session for the same card does get it put back', async () => {
    uiSet(effortKey('card-1'), 'high');
    await mount({ liveId: 'live-5' });
    applied = 'medium'; // the next process comes up on the default
    await mount({ liveId: 'live-6' });
    expect(calls.filter((c) => c[0] === 'setEffort')).toEqual([
      ['setEffort', 'live-5', 'high'],
      ['setEffort', 'live-6', 'high'],
    ]);
  });
});

describe('while the session is in the middle of a turn', () => {
  it('shows the level, cannot be changed, and says when it can', async () => {
    applied = 'high';
    await mount({ working: true });
    expect(chip()!.value).toBe('high');
    expect(chip()!.disabled).toBe(true);
    expect(chip()!.title).toContain('when this turn is over');
  });

  it('is usable again the moment the turn ends', async () => {
    await mount({ working: true });
    await mount({ working: false });
    expect(chip()!.disabled).toBe(false);
  });
});

describe('a first read that nobody answered', () => {
  afterEach(() => vi.useRealTimers());

  it('is asked once more a little later, so a session that was still starting gets its chip', async () => {
    vi.useFakeTimers();
    let asked = 0;
    (
      window as unknown as { switchboard: { sessions: { effort: () => Promise<ControlVerdict> } } }
    ).switchboard.sessions.effort = () => {
      asked++;
      return Promise.resolve(
        asked === 1
          ? { ok: false, reason: 'timed-out', message: 'nobody answered' }
          : ok({ effort: 'medium', levels })
      );
    };
    await mount();
    expect(chip()).toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(EFFORT_RETRY_MS + 10);
    });
    for (let i = 0; i < 4; i++) await act(async () => Promise.resolve());
    expect(asked).toBe(2);
    expect(chip()!.value).toBe('medium');
  });

  it('but only once: a session that will never answer is not asked for ever', async () => {
    vi.useFakeTimers();
    let asked = 0;
    (
      window as unknown as { switchboard: { sessions: { effort: () => Promise<ControlVerdict> } } }
    ).switchboard.sessions.effort = () => {
      asked++;
      return Promise.resolve({ ok: false, reason: 'not-stream', message: 'no channel' });
    };
    await mount();
    for (let round = 0; round < 4; round++) {
      await act(async () => {
        vi.advanceTimersByTime(EFFORT_RETRY_MS + 10);
      });
      for (let i = 0; i < 4; i++) await act(async () => Promise.resolve());
    }
    expect(asked).toBe(2);
  });
});

describe('when there is nobody to ask', () => {
  it('a bridge with no effort channel is no chip, and no error', async () => {
    (window as unknown as { switchboard: unknown }).switchboard = { sessions: {} };
    await mount();
    expect(chip()).toBeNull();
  });

  it('a session that does not answer is no chip', async () => {
    (
      window as unknown as { switchboard: { sessions: { effort: () => Promise<ControlVerdict> } } }
    ).switchboard.sessions.effort = () =>
      Promise.resolve({ ok: false, reason: 'timed-out', message: 'nobody answered' });
    await mount();
    expect(chip()).toBeNull();
  });

  it('a read that throws is no chip', async () => {
    (
      window as unknown as { switchboard: { sessions: { effort: () => Promise<never> } } }
    ).switchboard.sessions.effort = () => Promise.reject(new Error('gone'));
    await mount();
    expect(chip()).toBeNull();
  });
});
