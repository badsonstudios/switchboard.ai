// @vitest-environment jsdom
// The session row, drawn WITHOUT the rail around it (#1143).
//
// The row was a closure inside SessionsRail until the sessions strip needed the
// same one in its drop-down lists. Everything the row DOES is already pinned
// through the rail by the SessionsRail.*.test.tsx files, and those are the
// regression net for the move. What they cannot say is the thing the move was
// for: that a second list can mount this row on its own, hand it plain facts,
// and get the rail's row back. That is all this file claims.
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import type React from 'react';
import { act } from 'react';
import i18next from 'i18next';
import { createRoot, Root } from 'react-dom/client';
import { initI18nForTests } from '../i18n/test-i18n';
import { SessionRow } from './SessionRow';
import { RailSession } from '../model/types';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let root: Root | null = null;
const noop = (): void => {};

const SESSION: RailSession = { id: 'c1', title: 'switchboard', status: 'idle' };

type RowProps = React.ComponentProps<typeof SessionRow>;

/** one row with nothing remarkable about it, plus whatever the test says */
async function mountRow(over: Partial<RowProps> = {}): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <SessionRow
        session={SESSION}
        needsYou={false}
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
        {...over}
      />
    );
  });
  return host;
}

const row = (host: HTMLElement): HTMLElement => host.querySelector<HTMLElement>('.rail-row')!;

async function click(el: HTMLElement, type = 'click'): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent(type, { bubbles: true }));
  });
}

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

describe('the session row on its own (issue 1143)', () => {
  it('draws the name, the state word and the held-open label line', async () => {
    const host = await mountRow();
    expect(host.querySelector('[data-rail-title="c1"]')!.textContent).toBe('switchboard');
    expect(host.querySelector('[data-rail-state="c1"]')!.textContent).toBe(
      i18next.t('status.idle')
    );
    expect(host.querySelector('[data-rail-label="c1"]')!.textContent).toBe('—');
    expect(row(host).dataset.needsYou).toBe('false');
    expect(row(host).dataset.pinned).toBe('false');
  });

  it('is lit by being COUNTED, whatever its status says', async () => {
    // #1137's rule, restated at the row's own boundary: the list decides who
    // needs you and the row paints the answer. An idle session that is one of
    // the N is lit; the row never consults the status to overrule that.
    const host = await mountRow({ needsYou: true });
    expect(row(host).dataset.needsYou).toBe('true');
  });

  it('shows what other sessions left, and how deep it is nested, when told', async () => {
    const host = await mountRow({ waiting: 3, depth: 1, pinned: true });
    expect(host.querySelector('[data-rail-waiting="c1"]')!.textContent).toBe('3');
    expect(host.querySelector('[data-rail-lineage="c1"]')).not.toBeNull();
    expect(row(host).dataset.railDepth).toBe('1');
    expect(row(host).dataset.pinned).toBe('true');
  });

  it('draws the insertion line only on the side it is given', async () => {
    const plain = await mountRow();
    expect(plain.querySelector('[data-drop-line]')).toBeNull();
    await act(async () => root!.unmount());
    root = null;

    const host = await mountRow({ dropEdge: 'after' });
    expect(host.querySelector('[data-drop-line="after"]')).not.toBeNull();
    expect(row(host).dataset.dropEdge).toBe('after');
  });

  it('reports a click as focus and the ✕ as close, once each', async () => {
    const said: string[] = [];
    const host = await mountRow({
      onFocus: () => said.push('focus'),
      onClose: () => said.push('close'),
    });
    await click(host.querySelector<HTMLElement>('[data-rail-open="c1"]')!);
    await click(host.querySelector<HTMLElement>('.rail-x')!);
    // once each: the name button and the ✕ both sit inside the row, whose own
    // click also focuses, so either one bubbling would say "focus" again
    expect(said).toEqual(['focus', 'close']);
  });

  it('asks to be renamed on a double-click, but not for a session never started', async () => {
    let asked = 0;
    const host = await mountRow({ onStartRename: () => asked++ });
    await click(row(host), 'dblclick');
    expect(asked).toBe(1);
    await act(async () => root!.unmount());
    root = null;

    const idle = await mountRow({
      session: { ...SESSION, status: 'not-started' },
      onStartRename: () => asked++,
    });
    await click(row(idle), 'dblclick');
    expect(asked).toBe(1);
  });

  it('shows the draft it is handed, reports typing, and commits it trimmed', async () => {
    // The draft is the LIST's, not the row's: a row remounts whenever its list
    // re-parents it, and what was typed has to outlive that. So the box shows
    // what it is given and says what was typed; it remembers nothing.
    const said: string[] = [];
    const host = await mountRow({
      editing: true,
      draft: '  renamed  ',
      onDraftChange: (d) => said.push(`draft:${d}`),
      onRename: (name) => said.push(`rename:${name}`),
      onEndRename: () => said.push('end'),
    });
    const field = host.querySelector<HTMLInputElement>('.rail-row input')!;
    expect(field.value).toBe('  renamed  ');

    const valueProp = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!;
    await act(async () => {
      valueProp.set!.call(field, 'typed');
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(said).toEqual(['draft:typed']);
    said.length = 0;
    await act(async () => {
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(said).toEqual(['rename:renamed', 'end']);
  });
});
