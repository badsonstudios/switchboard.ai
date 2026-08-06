// @vitest-environment jsdom
// What the rail's rename field will and will not commit (#294).
//
// The field committed its draft verbatim, and main only length-caps a title, so
// `''` was a legal session name. Every display site downstream grew its own
// "empty counts as absent" rule to survive it (#250/#264) — but the rail row
// renders the raw title, so an erased name left the session anonymous in the
// exact place you would go to fix it. The rule now lives once, at the commit.
//
// Driven through the real component rather than a extracted predicate: the
// claim is about what the Enter key does to the store, and the interesting part
// is that a rejected commit ends the edit rather than trapping the user in it.
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import ICU from 'i18next-icu';
import en from '../i18n/locales/en.json';
import { SessionsRail } from './SessionsRail';
import { DEFAULT_BOOK } from '../lib/presentation-policy';
import { DEFAULT_FOCUS_BOOK } from '../lib/focus-policy';
import { uiDelete } from '../lib/ui-state';
import { RailSession } from '../model/types';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let root: Root | null = null;
const noop = (): void => {};

const sessions: RailSession[] = [{ id: 'c1', title: 'switchboard', status: 'idle' }];

/** the rail carrying one session, reporting every rename it is asked to make */
async function mountRail(renames: Array<[string, string]>): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <SessionsRail
        sessions={sessions}
        groups={[]}
        selectedId="c1"
        palette={['var(--status-working)']}
        policies={DEFAULT_BOOK}
        focusPolicies={DEFAULT_FOCUS_BOOK}
        onRename={(id, title) => renames.push([id, title])}
        onFocus={noop}
        onDiff={noop}
        onClose={noop}
        onCreateGroup={noop}
        onRenameGroup={noop}
        onRecolorGroup={noop}
        onDeleteGroup={noop}
        onOpenInGroup={noop}
        onMoveToGroup={noop}
        pinned={new Set()}
        onTogglePin={noop}
        onSetSessionPolicy={noop}
        onSetSessionFocusPolicy={noop}
        onCycleGroupPolicy={noop}
      />
    );
  });
  return host;
}

/** open the rename field the way a user does — double-click the row */
async function openField(host: HTMLElement): Promise<HTMLInputElement> {
  const row = host.querySelector<HTMLElement>('.rail-row')!;
  await act(async () => {
    row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  });
  return host.querySelector<HTMLInputElement>('.rail-row input')!;
}

/**
 * Type into a CONTROLLED input. Assigning `.value` skips React's own value
 * tracker, which then decides nothing changed and swallows the `input` event —
 * so the write has to go through the prototype setter the tracker patched over.
 */
async function type(field: HTMLInputElement, text: string): Promise<void> {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setValue.call(field, text);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function press(field: HTMLInputElement, key: string): Promise<void> {
  await act(async () => {
    field.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });
}

beforeAll(async () => {
  if (!i18next.isInitialized) {
    await i18next
      .use(ICU)
      .use(initReactI18next)
      .init({
        lng: 'en',
        resources: { en: { translation: en } },
        interpolation: { escapeValue: false },
      });
  }
});

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '';
  uiDelete(['railCollapsed', 'railWidth']);
  (window as unknown as { switchboard: unknown }).switchboard = {
    events: { ack: () => Promise.resolve(), dismiss: () => Promise.resolve() },
  };
});

afterEach(async () => {
  if (root) {
    const r = root;
    root = null;
    await act(async () => r.unmount());
  }
});

describe('the rail rename field (issue 294)', () => {
  it('commits a real name', async () => {
    const renames: Array<[string, string]> = [];
    const host = await mountRail(renames);
    const field = await openField(host);
    expect(field.value).toBe('switchboard');

    await type(field, 'renamed');
    await press(field, 'Enter');

    expect(renames).toEqual([['c1', 'renamed']]);
  });

  it('refuses an empty commit and leaves the name that was there', async () => {
    const renames: Array<[string, string]> = [];
    const host = await mountRail(renames);
    const field = await openField(host);

    await type(field, '');
    await press(field, 'Enter');

    expect(renames).toEqual([]);
    // the edit still ENDS — a rejection the user cannot dismiss is a trap, and
    // the row underneath still carries the name it had
    expect(host.querySelector('.rail-row input')).toBeNull();
    expect(host.querySelector('.rail-row')!.textContent).toContain('switchboard');
  });

  it('refuses a whitespace-only commit for the same reason', async () => {
    const renames: Array<[string, string]> = [];
    const host = await mountRail(renames);
    const field = await openField(host);

    await type(field, '   \t ');
    await press(field, 'Enter');

    expect(renames).toEqual([]);
    expect(host.querySelector('.rail-row input')).toBeNull();
  });

  it('trims what it does commit, so "blank" is one rule and not two', async () => {
    const renames: Array<[string, string]> = [];
    const host = await mountRail(renames);
    const field = await openField(host);

    await type(field, '  spaced out  ');
    await press(field, 'Enter');

    expect(renames).toEqual([['c1', 'spaced out']]);
  });

  it('still abandons on Escape without committing anything', async () => {
    const renames: Array<[string, string]> = [];
    const host = await mountRail(renames);
    const field = await openField(host);

    await type(field, 'never mind');
    await press(field, 'Escape');

    expect(renames).toEqual([]);
    expect(host.querySelector('.rail-row input')).toBeNull();
  });
});
