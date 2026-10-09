// @vitest-environment jsdom
// The context meter under the prompt box (#715).
//
// What it promises: the figure is the one the SESSION gave; it is asked for
// when the card appears, at both ends of a turn, when the model changes, and
// now and then while a turn runs; the three states are told apart by more than
// colour; and when the session gives no answer there is no meter, never 0%.
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { initI18nForTests } from '../i18n/test-i18n';
import type { ControlVerdict } from '../../../shared/control';
import { CONTEXT_POLL_MS, CONTEXT_RETRY_MS, CONTEXT_SETTLE_MS, ContextMeter } from './ContextMeter';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let root: Root | null = null;
let host: HTMLElement;
/** what the "session" answers next; `null` is no answer at all */
let answer: Record<string, unknown> | null;
let calls: string[];

const USAGE = { percentage: 19, totalTokens: 38913, maxTokens: 200000, autoCompactAt: 167000 };

function installBridge(withChannel = true): void {
  (window as unknown as { switchboard: unknown }).switchboard = {
    sessions: withChannel
      ? {
          contextUsage: (id: string): Promise<ControlVerdict> => {
            calls.push(id);
            return Promise.resolve(
              answer
                ? { ok: true, response: answer }
                : { ok: false, reason: 'timed-out', message: 'no answer' }
            );
          },
        }
      : {},
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await act(async () => Promise.resolve());
}

async function mount(
  props: { liveId?: string; working?: boolean; model?: string | null; refresh?: number } = {}
): Promise<void> {
  if (!root) {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  }
  await act(async () => {
    root!.render(
      <ContextMeter
        liveId={props.liveId ?? 'live-1'}
        working={props.working ?? false}
        model={'model' in props ? props.model : 'claude-opus-5-5'}
        refresh={props.refresh}
      />
    );
  });
  await settle();
}

const meter = (): HTMLElement | null =>
  host.querySelector<HTMLElement>('[data-testid="composer-context"]');

beforeAll(async () => {
  await initI18nForTests();
});

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '';
  answer = { ...USAGE };
  calls = [];
  installBridge();
});

afterEach(async () => {
  vi.useRealTimers();
  if (root) {
    const r = root;
    root = null;
    await act(async () => r.unmount());
  }
});

describe('what the meter shows (issue 715)', () => {
  it('the figure the SESSION gave, asked for the composer’s own session', async () => {
    await mount({ liveId: 'live-7' });
    expect(calls).toEqual(['live-7']);
    expect(meter()!.textContent).toBe('context 19%');
    expect(meter()!.getAttribute('aria-valuenow')).toBe('19');
    expect(meter()!.getAttribute('role')).toBe('meter');
    expect(meter()!.getAttribute('aria-label')).toBe('Context used');
  });

  it('the bar is as long as the figure', async () => {
    await mount();
    const fill = meter()!.querySelector<HTMLElement>('.context-meter-fill')!;
    expect(fill.style.inlineSize).toBe('19%');
  });

  it('the hover gives the counts, and where Claude Code compacts on its own', async () => {
    await mount();
    const title = meter()!.getAttribute('title')!;
    expect(title).toContain('19% full');
    expect(title).toContain('38,913 of 200,000 tokens');
    expect(title).toContain('compacts the conversation on its own at about 167,000');
  });

  it('says nothing about compaction when the session gave no such point', async () => {
    answer = { ...USAGE, autoCompactAt: null };
    await mount();
    expect(meter()!.getAttribute('title')).not.toContain('compacts');
  });

  it('with no counts, the hover still says the figure and claims no more', async () => {
    answer = { percentage: 33, totalTokens: null, maxTokens: null, autoCompactAt: null };
    await mount();
    expect(meter()!.getAttribute('title')).toBe("This session's context is 33% full.");
  });
});

describe('the three states', () => {
  it('plain below 60', async () => {
    answer = { ...USAGE, percentage: 59 };
    await mount();
    expect(meter()!.dataset.contextLevel).toBe('normal');
    expect(meter()!.getAttribute('title')).not.toContain('Compact');
  });

  it('filling from 60: marked, and the hover points at Compact and Clear', async () => {
    answer = { ...USAGE, percentage: 60 };
    await mount();
    expect(meter()!.dataset.contextLevel).toBe('filling');
    expect(meter()!.getAttribute('title')).toContain('filling up: Compact or Clear');
  });

  it('nearly full from 80', async () => {
    answer = { ...USAGE, percentage: 80 };
    await mount();
    expect(meter()!.dataset.contextLevel).toBe('nearly-full');
    expect(meter()!.getAttribute('title')).toContain('nearly full');
  });

  it('the state is in the NUMBER too, never colour alone', async () => {
    answer = { ...USAGE, percentage: 86 };
    await mount();
    expect(meter()!.querySelector('.context-meter-number')!.textContent).toBe('context 86%');
    expect(meter()!.getAttribute('aria-valuetext')).toContain('86 percent');
  });
});

describe('when it asks', () => {
  it('again when a turn starts and when it ends', async () => {
    await mount({ working: false });
    await mount({ working: true });
    answer = { ...USAGE, percentage: 44 };
    await mount({ working: false });
    expect(calls).toHaveLength(3);
    expect(meter()!.textContent).toBe('context 44%');
  });

  it('now and then WHILE a turn runs, and not while nothing is running', async () => {
    vi.useFakeTimers();
    await mount({ working: true });
    expect(calls).toHaveLength(1);
    answer = { ...USAGE, percentage: 31 };
    await act(async () => void vi.advanceTimersByTime(CONTEXT_POLL_MS + 10));
    await settle();
    expect(calls).toHaveLength(2);
    expect(meter()!.textContent).toBe('context 31%');

    await mount({ working: false });
    const idle = calls.length;
    await act(async () => void vi.advanceTimersByTime(CONTEXT_POLL_MS * 3));
    await settle();
    expect(calls).toHaveLength(idle);
  });

  it('again when the model changes: the window is a different size', async () => {
    await mount({ model: 'claude-opus-5-5' });
    answer = { percentage: 18, totalTokens: 35607, maxTokens: 200000, autoCompactAt: 167000 };
    await mount({ model: 'haiku' });
    expect(calls).toHaveLength(2);
    expect(meter()!.textContent).toBe('context 18%');
  });

  it('after Compact or Clear: at once, and once more shortly after, with no turn needed', async () => {
    // the two things that EMPTY the window. The first read can beat the command
    // to the session and come back with the old figure; the second cannot.
    vi.useFakeTimers();
    answer = { ...USAGE, percentage: 91 };
    await mount({ refresh: 0 });
    expect(calls).toHaveLength(1);
    await mount({ refresh: 1 });
    expect(calls).toHaveLength(2);
    expect(meter()!.textContent).toBe('context 91%'); // too early: still the old figure
    answer = { ...USAGE, percentage: 4 };
    await act(async () => void vi.advanceTimersByTime(CONTEXT_SETTLE_MS + 10));
    await settle();
    expect(calls).toHaveLength(3);
    expect(meter()!.textContent).toBe('context 4%');
  });

  it('a bridge that THROWS instead of rejecting draws nothing and throws nothing', async () => {
    (window as unknown as { switchboard: unknown }).switchboard = {
      sessions: {
        contextUsage: () => {
          throw new Error('bridge exploded');
        },
      },
    };
    await mount();
    expect(meter()).toBeNull();
  });

  it('a different session starts from nothing, not from the last one’s figure', async () => {
    await mount({ liveId: 'live-1' });
    expect(meter()).not.toBeNull();
    answer = null;
    await mount({ liveId: 'live-2' });
    expect(meter()).toBeNull();
  });
});

describe('when there is no answer', () => {
  it('⚠️ no meter at all, never 0%', async () => {
    answer = null;
    await mount();
    expect(meter()).toBeNull();
  });

  it('an answer with no usable figure is no meter either', async () => {
    answer = { percentage: 'lots' };
    await mount();
    expect(meter()).toBeNull();
  });

  it('asks once more a little later (a session still starting), and only once', async () => {
    vi.useFakeTimers();
    answer = null;
    await mount();
    expect(calls).toHaveLength(1);
    answer = { ...USAGE };
    await act(async () => void vi.advanceTimersByTime(CONTEXT_RETRY_MS + 10));
    await settle();
    expect(calls).toHaveLength(2);
    expect(meter()!.textContent).toBe('context 19%');

    // and a session that never answers is not asked for ever
    answer = null;
    await mount({ liveId: 'live-9' });
    await act(async () => void vi.advanceTimersByTime(CONTEXT_RETRY_MS + 10));
    await settle();
    const after = calls.filter((c) => c === 'live-9').length;
    await act(async () => void vi.advanceTimersByTime(CONTEXT_RETRY_MS * 5));
    await settle();
    expect(calls.filter((c) => c === 'live-9')).toHaveLength(after);
    expect(after).toBe(2);
  });

  it('a read that fails mid-session KEEPS the last figure: the window did not empty', async () => {
    await mount({ working: false });
    answer = null;
    await mount({ working: true });
    expect(meter()!.textContent).toBe('context 19%');
  });

  it('a bridge with no such channel draws nothing and throws nothing', async () => {
    installBridge(false);
    await mount();
    expect(meter()).toBeNull();
    expect(calls).toEqual([]);
  });
});
