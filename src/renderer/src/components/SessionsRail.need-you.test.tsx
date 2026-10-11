// @vitest-environment jsdom
// #1137 — "1 need you" over a group where every row reads Done.
//
// THE INVARIANT: when a group's header says N need you, exactly N of its rows
// carry the needs-you treatment, so the count always leads to something you can
// see. Before this, the header counted the Events window (`needing`) and the
// rows painted the session's STATUS, and the two parted the moment you looked at
// a finished session: looking relaxes its event from `done` to `ready`, which
// takes it out of the count, but the session's status is still `done` — so its
// row stayed lit, identical to the one that really was waiting.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { sessionStore } from '../store/session-store';
import { createRoot, Root } from 'react-dom/client';
import { act } from 'react';
import { SessionsRail } from './SessionsRail';
import { RailGroup, RailSession } from '../model/types';
import type { RailCardStatus } from '../../../shared/sessions';
import { DEFAULT_BOOK } from '../lib/presentation-policy';
import { NO_ORDER } from '../lib/rail-order';
import { initI18nForTests } from '../i18n/test-i18n';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

const noop = (): void => {};

let host: HTMLDivElement;
let root: Root;

const backend: RailGroup = { id: 'g1', name: 'Backend', color: 'var(--status-working)' };

const session = (id: string, status: RailCardStatus): RailSession => ({
  id,
  title: id,
  status,
  folder: `C:\\p\\${id}`,
  groupId: 'g1',
});

async function mount(sessions: RailSession[], needing: string[]): Promise<void> {
  await act(async () => {
    root.render(
      <SessionsRail
        sessions={sessions}
        groups={[backend]}
        needing={new Set<string>(needing)}
        palette={['var(--status-working)']}
        selectedId={null}
        policies={DEFAULT_BOOK}
        pinned={new Set<string>()}
        manualOrder={NO_ORDER}
        onReorder={noop}
        onRename={noop}
        onFocus={noop}
        onDiff={noop}
        onClose={noop}
        onCreateGroup={noop}
        onRenameGroup={noop}
        onRecolorGroup={noop}
        onDeleteGroup={noop}
        onOpenInGroup={noop}
        onMoveToGroup={noop}
        onTogglePin={noop}
        onCycleGroupPolicy={noop}
      />
    );
  });
}

const rowOf = (id: string): HTMLElement =>
  host.querySelector<HTMLElement>(`[data-rail-open="${id}"]`)!.closest<HTMLElement>('.rail-row')!;

const litRows = (): string[] =>
  Array.from(host.querySelectorAll<HTMLElement>('.rail-row[data-needs-you="true"]')).map(
    (r) => r.querySelector<HTMLElement>('[data-rail-open]')!.dataset.railOpen!
  );

const headerText = (): string =>
  host.querySelector<HTMLElement>('[data-rail-group-toggle="g1"]')!.closest('div')!.parentElement!
    .textContent ?? '';

beforeAll(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  await initI18nForTests();
});

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe('a group header and its rows agree about who needs you (#1137)', () => {
  // THE REPORT. Three finished sessions; the user has looked at two of them.
  it('one finished session not yet looked at: the header says 1, and ONE row is lit', async () => {
    await mount([session('a', 'done'), session('b', 'done'), session('c', 'done')], ['b']);
    expect(headerText()).toContain('1 need');
    expect(litRows()).toEqual(['b']);
    // the other two still say what they are, quietly
    for (const id of ['a', 'c']) {
      const word = rowOf(id).querySelector<HTMLElement>('[data-rail-state]')!;
      expect(word.textContent).toBe('done');
      expect(word.style.color).toBe('var(--muted)');
    }
  });

  it('everything looked at: the header is calm and so is every row', async () => {
    await mount([session('a', 'done'), session('b', 'done')], []);
    expect(headerText()).not.toContain('need');
    expect(litRows()).toEqual([]);
  });

  // The #621 direction, held to the same rule: a dismissed ask leaves the count
  // AND stops the row shouting — while the row still says the session is asking.
  it('a dismissed permission ask: not counted, not lit, still labelled', async () => {
    await mount([session('a', 'needs-permission'), session('b', 'needs-input')], ['b']);
    expect(headerText()).toContain('1 need');
    expect(litRows()).toEqual(['b']);
    expect(rowOf('a').dataset.sessionStatus).toBe('needs-permission');
    // off the count, but the word keeps its colour: it is still asking
    expect(rowOf('a').querySelector<HTMLElement>('[data-rail-state]')!.style.color).toBe(
      'var(--status-needs-permission-ink)'
    );
  });

  // A returned review is filed on its AUTHOR, whose own status is usually idle.
  // It is counted, so its row has to be findable.
  it('a session counted for something other than its status is lit too', async () => {
    await mount([session('a', 'idle'), session('b', 'working')], ['a']);
    expect(headerText()).toContain('1 need');
    expect(litRows()).toEqual(['a']);
  });
});

// #1202 — an approval runs out, so the row waiting on one is marked for the
// pulse, and says how long is left. Marked by the SAME set the count reads.
describe('a session waiting on an approval is marked, with its clock (#1202)', () => {
  const NOW = 1_800_000_000_000;
  const hold = (cardId: string, leftMs: number): void =>
    sessionStore.addPendingPermission({
      requestId: `stream:${cardId}:1`,
      sessionId: `live-${cardId}`,
      cardId,
      tool: 'Bash',
      input: {},
      deadline: NOW + leftMs,
    });
  const marked = (): string[] =>
    Array.from(host.querySelectorAll<HTMLElement>('.rail-row[data-needs-approval="true"]')).map(
      (r) => r.querySelector<HTMLElement>('[data-rail-open]')!.dataset.railOpen!
    );

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    for (const r of sessionStore.getState().pendingPermissions) {
      sessionStore.removePendingPermission(r.requestId);
    }
    vi.useRealTimers();
  });

  it('only the row that is counted AND on needs-permission; a question is not', async () => {
    hold('a', 200_000);
    await mount(
      [session('a', 'needs-permission'), session('b', 'needs-input'), session('c', 'done')],
      ['a', 'b', 'c']
    );
    expect(litRows()).toEqual(['a', 'b', 'c']);
    expect(marked()).toEqual(['a']);
    expect(rowOf('a').dataset.approvalUrgent).toBeUndefined();
    expect(rowOf('a').title).toContain('Waiting for your approval. In less than 4 minutes');
  });

  it('a DISMISSED ask is not marked: the pulse never claims what the count dropped', async () => {
    hold('a', 200_000);
    await mount([session('a', 'needs-permission')], []);
    expect(marked()).toEqual([]);
    expect(rowOf('a').title).toBe('');
  });

  it('the last minute is urgent, and arrives on time without a re-render from outside', async () => {
    hold('a', 90_000);
    await mount([session('a', 'needs-permission')], ['a']);
    expect(rowOf('a').dataset.approvalUrgent).toBeUndefined();
    await act(async () => {
      vi.advanceTimersByTime(31_000);
    });
    expect(rowOf('a').dataset.approvalUrgent).toBe('true');
    expect(rowOf('a').title).toContain('In less than 60 seconds');
  });

  it('answered: the mark goes with the status, at once', async () => {
    hold('a', 200_000);
    await mount([session('a', 'needs-permission')], ['a']);
    expect(marked()).toEqual(['a']);
    await act(async () => sessionStore.removePendingPermission('stream:a:1'));
    await mount([session('a', 'working')], []);
    expect(marked()).toEqual([]);
  });

  it('a CLOSED group carries it on its header; an open one leaves it to the rows', async () => {
    hold('a', 30_000);
    await mount([session('a', 'needs-permission'), session('b', 'idle')], ['a']);
    // the HEADER: it is all a closed group shows, and where the pointer rests
    const card = (): HTMLElement =>
      host.querySelector<HTMLElement>('[data-group-card="g1"] .rail-head')!;
    expect(card().dataset.needsApproval).toBeUndefined();
    await act(async () => {
      host.querySelector<HTMLElement>('[data-rail-group-toggle="g1"]')!.click();
    });
    expect(card().dataset.needsApproval).toBe('true');
    expect(card().dataset.approvalUrgent).toBe('true');
    expect(card().title).toContain('Waiting for your approval');
  });
});
