// @vitest-environment jsdom
// "See what it was told" (#1295): the exact text, read-only and copyable;
// Escape closes it and focus goes back; a briefing that is gone says so and
// never crashes.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { createRoot, Root } from 'react-dom/client';
import { act } from 'react';
import { BriefingDialog } from './BriefingDialog';
import { initI18nForTests } from '../i18n/test-i18n';
import type { AiSwitchMark, BriefingTextResult } from '../../../shared/ai-switch';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

const MARK: AiSwitchMark = {
  kind: 'ai-switch',
  id: 'm1',
  from: { providerId: 'claude-code', name: 'Claude Code' },
  to: { providerId: 'codex', name: 'Codex' },
  at: '2026-10-16T10:00:00.000Z',
  briefed: true,
  turnsSummarised: 2,
  briefingRef: 'card-1/m1',
};
// two spaces, a tab and a trailing newline: a viewer that trimmed or
// re-flowed would change these bytes
const EXACT = '# Briefed continuation from Claude Code to Codex\n\n  indented\ttab\n';

let host: HTMLDivElement;
let root: Root;
let closed: number;
let answer: Promise<BriefingTextResult> | undefined;
const asked: string[] = [];

beforeAll(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  await initI18nForTests();
});

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  closed = 0;
  asked.length = 0;
  answer = Promise.resolve({ ok: true, text: EXACT });
  (window as unknown as { switchboard: unknown }).switchboard = {
    sessions: {
      briefingText: (ref: string) => {
        asked.push(ref);
        return answer;
      },
    },
  };
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  delete (window as unknown as { switchboard?: unknown }).switchboard;
});

async function open(): Promise<HTMLElement> {
  await act(async () => {
    root.render(<BriefingDialog mark={MARK} briefingRef="card-1/m1" onClose={() => closed++} />);
  });
  return host.querySelector('[data-testid="briefing-dialog"]') as HTMLElement;
}

describe('BriefingDialog', () => {
  it('shows the exact bytes, names both AIs, and is a labelled modal dialog', async () => {
    const d = await open();
    expect(asked).toEqual(['card-1/m1']);
    expect(d.getAttribute('role')).toBe('dialog');
    expect(d.getAttribute('aria-modal')).toBe('true');
    expect(d.textContent).toContain('What Codex was told');
    expect(d.textContent).toContain('conversation with Claude Code');
    expect(host.querySelector('[data-briefing-text]')?.textContent).toBe(EXACT);
    expect(document.activeElement).toBe(d);
  });

  it('Escape closes it and gives focus back', async () => {
    const before = document.createElement('button');
    document.body.appendChild(before);
    before.focus();
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      cb(0);
      return 0;
    });
    const d = await open();
    act(() => {
      d.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(closed).toBe(1);
    expect(document.activeElement).toBe(before);
    raf.mockRestore();
    before.remove();
  });

  it('Copy puts the same bytes on the clipboard', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await open();
    await act(async () => {
      (host.querySelector('[data-briefing-copy]') as HTMLButtonElement).click();
    });
    expect(writeText).toHaveBeenCalledWith(EXACT);
    expect(host.querySelector('[data-briefing-copy]')?.textContent).toBe('Copied');
  });

  it.each([
    ['gone', () => Promise.resolve({ ok: false, reason: 'gone' } as BriefingTextResult)],
    ['a rejection', () => Promise.reject(new Error('ipc down'))],
    ['a refusal object', () => Promise.resolve({ __ipcRefused: true } as unknown as BriefingTextResult)],
  ])('%s: "no longer available", Copy disabled, no crash', async (_what, make) => {
    answer = make();
    await open();
    expect(host.querySelector('[data-briefing-gone]')?.textContent).toBe('The briefing text is no longer available.');
    expect((host.querySelector('[data-briefing-copy]') as HTMLButtonElement).disabled).toBe(true);
  });
});
