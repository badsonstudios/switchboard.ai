// @vitest-environment jsdom
// #877 — the rail row's task label: where it sits, how much room it gets, and
// what a screen reader is told about it.
//
// The row used to show EITHER the task label or the session's state on line 2,
// never both. So the moment a session needed you — the one moment you most want
// to know WHICH piece of work is asking — the row stopped saying. This item
// moved the state up beside the name and gave the label lines of its own.
//
// Four properties, and the last two are the ones with teeth:
//
//   • the state word is on the row ALONGSIDE the name, in the same `status.*`
//     vocabulary the card header's pill uses — two surfaces describing one
//     session differently is a support question nobody can answer;
//   • the label gets its own space, and an em dash HOLDS that space open when
//     there is no label yet, so the row does not reflow when one lands;
//   • ⚠️ the label reaches a SCREEN READER even when the session needs you.
//     `aria-label` replaces the element's contents outright, so a label that is
//     not folded into it is readable to the eye and to nobody else — and this
//     is invisible from the pixels, which is why it is asserted here;
//   • ⚠️ the line budget comes from the PROP, not a constant in this file. The
//     clamp is what makes "full / medium / compact" mean anything, and a row
//     that ignored the setting would look correct in every screenshot.
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { createRoot, Root } from 'react-dom/client';
import { act } from 'react';
import { SessionsRail } from './SessionsRail';
import { RailSession } from '../model/types';
import { DEFAULT_BOOK } from '../lib/presentation-policy';
import { DEFAULT_FOCUS_BOOK } from '../lib/focus-policy';
import { NO_ORDER } from '../lib/rail-order';
import { initI18nForTests } from '../i18n/test-i18n';
import { loadUiState, uiDelete } from '../lib/ui-state';
import { LABEL_LINES } from '../../../shared/task-label-size';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

const noop = (): void => {};

let host: HTMLDivElement;
let root: Root;

const session = (over: Partial<RailSession> = {}): RailSession => ({
  id: 'card-a',
  title: 'switchboard',
  status: 'idle',
  folder: 'C:\\p\\card-a',
  ...over,
});

async function mount(
  sessions: RailSession[],
  labelLines?: number,
  needing = new Set<string>()
): Promise<void> {
  await act(async () => {
    root.render(
      <SessionsRail
        sessions={sessions}
        groups={[]}
        needing={needing}
        palette={['var(--status-working)']}
        selectedId={null}
        policies={DEFAULT_BOOK}
        focusPolicies={DEFAULT_FOCUS_BOOK}
        pinned={new Set<string>()}
        manualOrder={NO_ORDER}
        labelLines={labelLines}
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
        onSetSessionPolicy={noop}
        onSetSessionFocusPolicy={noop}
        onCycleGroupPolicy={noop}
      />
    );
  });
}

/** the row button — the thing a screen reader reads as "the row" */
const row = (cardId: string): HTMLElement =>
  host.querySelector<HTMLElement>(`[data-rail-open="${cardId}"]`)!;
const rowName = (cardId: string): string => row(cardId).getAttribute('aria-label') ?? '';
/** the clamped label span — the LAST child of the row button's stack */
const labelSpan = (cardId: string): HTMLElement =>
  row(cardId).lastElementChild as HTMLElement;

beforeAll(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  await initI18nForTests();
});

beforeEach(async () => {
  uiDelete(['railCollapsed', 'railWidth']);
  await loadUiState();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe('the rail row task label (#877)', () => {
  it('puts the state beside the name, in the card header vocabulary', async () => {
    await mount([session({ status: 'working' })]);
    expect(row('card-a').textContent).toContain('working');
    expect(row('card-a').textContent).toContain('switchboard');
  });

  it('shows the label in its own space below the name', async () => {
    await mount([session({ taskLabel: 'Wire up the stream transport' })]);
    expect(labelSpan('card-a').textContent).toBe('Wire up the stream transport');
  });

  it('holds the space open with an em dash when there is no label yet', async () => {
    // §5.11: a label arrives late, or never. A row that grew a line when one
    // landed would shuffle every row beneath it at an arbitrary moment.
    await mount([session()]);
    expect(labelSpan('card-a').textContent).toBe('—');
  });

  it('clamps to the number of lines it is given', async () => {
    for (const size of ['full', 'medium', 'compact'] as const) {
      await mount([session({ taskLabel: 'a'.repeat(200) })], LABEL_LINES[size]);
      expect(labelSpan('card-a').style.webkitLineClamp, size).toBe(String(LABEL_LINES[size]));
      expect(labelSpan('card-a').style.display).toBe('-webkit-box');
    }
  });

  it('falls back to the default budget when given no prop', async () => {
    // An older caller, or one mounted before main answers — either way the row
    // shows the DEFAULT amount rather than one line or none.
    await mount([session({ taskLabel: 'x' })]);
    expect(labelSpan('card-a').style.webkitLineClamp).toBe(String(LABEL_LINES.full));
  });

  it('announces the label even on a row that needs you', async () => {
    // ⚠️ THE REGRESSION THIS ITEM FIXED. The ask leads, because that is the
    // demand; the label follows as the detail. Before #877 the label was
    // dropped outright in exactly this case.
    await mount(
      [session({ status: 'needs-permission', taskLabel: 'Wire up the stream transport' })],
      undefined,
      new Set(['card-a'])
    );
    const name = rowName('card-a');
    expect(name).toContain('switchboard');
    expect(name).toContain('Wire up the stream transport');
  });

  it('announces the label on a quiet row too, and says nothing extra without one', async () => {
    await mount([session({ taskLabel: 'Wire up the stream transport' })]);
    expect(rowName('card-a')).toContain('Wire up the stream transport');

    await mount([session()]);
    // The em dash is a layout spacer, not something to read out.
    expect(rowName('card-a')).not.toContain('—,');
  });
});
