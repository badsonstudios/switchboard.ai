// @vitest-environment jsdom
// A session waiting on you says so, on the row, the pill and a group's box
// (#1351, treatment A). The owner, 2026-10-18: "If an AI session stops and it's
// waiting on me for anything — a gate, a question, an approval — I want it to
// say it's waiting for me. It should not say 'calm' or 'done'."
//
// The rule is `lib/rail-view` (`waitState`, `waitPaint`, `waitRollup`), and
// rail-view.test.ts pins it. This file pins that each surface PAINTS it: the
// wash in the state's colour, the edge in the same colour, and the word.
// The tab's half is in IdentityTab.test.tsx; the ratios are tokens.drift.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import type React from 'react';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { initI18nForTests } from '../i18n/test-i18n';
import { SessionRow } from './SessionRow';
import { StripPill } from './StripPill';
import { StripGroupEntry } from './StripGroupEntry';
import { RailSession } from '../model/types';
import { sessionStore } from '../store/session-store';
import { WAIT_WASH } from '../lib/rail-view';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let root: Root | null = null;
const noop = (): void => {};

const session = (status: string): RailSession => ({
  id: 'c1',
  title: 'billing',
  status: status as RailSession['status'],
});

async function render(node: React.ReactNode): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(node);
  });
  return host;
}

const mountRow = (status: string, needsYou = false): Promise<HTMLElement> =>
  render(
    <SessionRow
      session={session(status)}
      needsYou={needsYou}
      selected={false}
      pinned={false}
      waiting={0}
      depth={undefined}
      editing={false}
      draft=""
      onDraftChange={noop}
      onFocus={noop}
      onClose={noop}
      onRename={noop}
      onStartRename={noop}
      onEndRename={noop}
    />
  ).then((h) => h.querySelector<HTMLElement>('.rail-row')!);

const mountPill = (status: string, needsYou = false): Promise<HTMLElement> =>
  render(
    <StripPill
      session={session(status)}
      needsYou={needsYou}
      selected={false}
      pinned={false}
      waiting={0}
      nested={false}
      folded={false}
      flash={false}
      onFocus={noop}
    />
  ).then((h) => h.querySelector<HTMLElement>('[data-strip-pill]')!);

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

// [status, the state, the list's word, the strip's word, the ramp it is painted in]
const STATES = [
  ['needs-permission', 'approval', 'approval', 'approval', 'needs-permission'],
  ['needs-input', 'question', 'question', 'question', 'needs-input'],
  ['done', 'waiting', 'waiting for you', 'waiting', 'waiting'],
] as const;

describe('the row in the left list', () => {
  it.each(STATES)('%s: washed, an edge in its colour, and the word "%s"', async (status, state, word, _pill, token) => {
    // NOT counted: a dismissed ask is still asking, a looked-at finished turn
    // is still waiting — the wash is the state's, not the count's
    const r = await mountRow(status, false);
    expect(r.dataset.waitState).toBe(state);
    expect(r.style.background).toBe(`color-mix(in srgb, var(--status-${token}) ${WAIT_WASH}%, transparent)`);
    const bar = r.querySelector<HTMLElement>('[data-accent-bar]')!;
    expect(bar.style.background).toBe(`var(--status-${token})`);
    const said = r.querySelector<HTMLElement>('[data-rail-state]')!;
    expect(said.textContent).toBe(word);
    expect(said.style.color).toBe(`var(--status-${token}-ink)`);
    // the ring in the same colour
    expect(r.querySelector('.ai-badge')!.getAttribute('data-ring')).toBe(token);
    // and the COUNT is still the count's: not lit
    expect(r.dataset.needsYou).toBe('false');
  });

  it('a calm session (no turn yet) is unwashed and says "calm"', async () => {
    const r = await mountRow('idle');
    expect(r.dataset.waitState).toBeUndefined();
    expect(r.style.background).toBe('transparent');
    expect(r.querySelector('[data-rail-state]')!.textContent).toBe('calm');
  });

  it('a working one is unwashed and says "working"', async () => {
    const r = await mountRow('working');
    expect(r.dataset.waitState).toBeUndefined();
    expect(r.querySelector('[data-rail-state]')!.textContent).toBe('working');
  });

  it('"done", "idle" and "calm" never describe a session that is waiting on you', async () => {
    for (const [status] of STATES) {
      const text = (await mountRow(status)).querySelector('[data-rail-state]')!.textContent;
      expect(['done', 'idle', 'calm', 'needs you', 'needs input']).not.toContain(text);
      await act(async () => root!.unmount());
      root = null;
    }
  });

  describe("a Direct session's question is a question, not an approval", () => {
    // main holds it as a `can_use_tool` request, under `needs-permission`
    beforeEach(() => {
      sessionStore.addPendingPermission({
        requestId: 'stream:c1:q',
        sessionId: 'live-c1',
        cardId: 'c1',
        tool: 'AskUserQuestion',
        input: {},
      });
    });
    afterEach(() => sessionStore.removePendingPermission('stream:c1:q'));

    it('says "question", in the question colour, with no clock and no approval pulse', async () => {
      const r = await mountRow('needs-permission', true);
      expect(r.dataset.waitState).toBe('question');
      expect(r.querySelector('[data-rail-state]')!.textContent).toBe('question');
      expect(r.querySelector<HTMLElement>('[data-rail-state]')!.style.color).toBe('var(--status-needs-input-ink)');
      expect(r.querySelector('.ai-badge')!.getAttribute('data-ring')).toBe('needs-input');
      expect(r.dataset.needsApproval).toBeUndefined();
    });

    it('and so does its pill', async () => {
      const p = await mountPill('needs-permission', true);
      expect(p.dataset.waitState).toBe('question');
      expect(p.querySelector('[data-strip-pill-state]')!.textContent).toBe('question');
    });
  });

  describe('an approval says how long it has left', () => {
    const NOW = 1_800_000_000_000;
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
      sessionStore.addPendingPermission({
        requestId: 'stream:c1:1',
        sessionId: 'live-c1',
        cardId: 'c1',
        tool: 'Bash',
        input: {},
        deadline: NOW + 252_000,
      });
    });
    afterEach(() => {
      sessionStore.removePendingPermission('stream:c1:1');
      vi.useRealTimers();
    });

    it('"approval · <5m", a bound the ten-second beat can keep true', async () => {
      const r = await mountRow('needs-permission', true);
      expect(r.querySelector('[data-rail-state]')!.textContent).toBe('approval · <5m');
      await act(async () => {
        vi.advanceTimersByTime(200_000);
      });
      expect(r.querySelector('[data-rail-state]')!.textContent).toBe('approval · <60s');
    });
  });
});

describe('the pill on the strip', () => {
  it.each(STATES)('%s: washed, its edge in its colour, and the word', async (status, state, _list, word, token) => {
    const p = await mountPill(status);
    expect(p.dataset.waitState).toBe(state);
    expect(p.style.background).toBe(`color-mix(in srgb, var(--status-${token}) ${WAIT_WASH}%, transparent)`);
    expect(p.style.border).toContain(`var(--status-${token})`);
    const said = p.querySelector<HTMLElement>('[data-strip-pill-state]')!;
    expect(said.textContent).toBe(word);
    expect(said.style.color).toBe(`var(--status-${token}-ink)`);
    expect(p.querySelector('.ai-badge')!.getAttribute('data-ring')).toBe(token);
  });

  it('a calm pill is not washed', async () => {
    const p = await mountPill('idle');
    expect(p.dataset.waitState).toBeUndefined();
    expect(p.style.background).toBe('var(--rail-card)');
  });
});

describe("a group's box on the strip (#1196's twin)", () => {
  const member = (id: string, status: string): RailSession => ({
    id,
    title: id,
    status: status as RailSession['status'],
    groupId: 'g1',
  });
  const mountGroup = (members: RailSession[]): Promise<HTMLElement> =>
    render(
      <StripGroupEntry
        groupKey="g1"
        kind="group"
        name="Backend"
        color="var(--accent-teal)"
        members={members}
        needing={new Set()}
        waiting={new Map()}
        ordinalOf={new Map()}
        open={false}
        listId="list-g1"
        onToggle={noop}
      />
    ).then((h) => h.querySelector<HTMLElement>('[data-strip-group]')!);

  it('says what is inside, most urgent first, in that state’s colour and wash', async () => {
    const box = await mountGroup([member('a', 'done'), member('b', 'needs-permission'), member('c', 'working')]);
    const summary = box.querySelector<HTMLElement>('[data-strip-group-summary]')!;
    expect(summary.textContent).toBe('1 approval · 1 waiting');
    expect(summary.style.color).toBe('var(--status-needs-permission-ink)');
    expect(summary.style.background).toBe(
      `color-mix(in srgb, var(--status-needs-permission) ${WAIT_WASH}%, transparent)`
    );
    expect(box.dataset.rollupLead).toBe('approval');
    expect(box.style.border).toContain('var(--status-needs-permission)');
    // waiting outranks working: no working look on it
    expect(box.dataset.sessionStatus).toBeUndefined();
  });

  it('plural, and the zeros left out', async () => {
    const box = await mountGroup([member('a', 'needs-input'), member('b', 'needs-input'), member('c', 'idle')]);
    expect(box.querySelector('[data-strip-group-summary]')!.textContent).toBe('2 questions');
  });
});
