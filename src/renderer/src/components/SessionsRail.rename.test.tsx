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
import { initI18nForTests } from '../i18n/test-i18n';
import { SessionsRail } from './SessionsRail';
import { DEFAULT_BOOK } from '../lib/presentation-policy';
import { DEFAULT_FOCUS_BOOK } from '../lib/focus-policy';
import { uiDelete } from '../lib/ui-state';
import { RailGroup, RailSession } from '../model/types';
import { NO_ORDER } from '../lib/rail-order';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let root: Root | null = null;
const noop = (): void => {};

const sessions: RailSession[] = [{ id: 'c1', title: 'switchboard', status: 'idle' }];
/**
 * One empty group, so the only input inside its card is the rename field.
 *
 * The color is a token rather than the `#rrggbb` a real group carries — group
 * colors are main-owned persisted DATA, but this file is renderer TSX and the
 * lint rule that bans raw hex there does not know the difference. Nothing here
 * asserts on the color.
 */
const GROUP: RailGroup = { id: 'g1', name: 'infra', color: 'var(--status-working)' };

/**
 * The rail carrying one session, reporting every rename it is asked to make.
 *
 * `groupRenames`/`groups` default to "no groups at all" so the #294 tests below
 * read exactly as they did — the group cases (#311) opt in.
 */
async function mountRail(
  renames: Array<[string, string]>,
  groupRenames: Array<[string, string]> = [],
  groups: RailGroup[] = []
): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <SessionsRail
        sessions={sessions}
        groups={groups}
        needing={new Set<string>()}
        selectedId="c1"
        palette={['var(--status-working)']}
        policies={DEFAULT_BOOK}
        focusPolicies={DEFAULT_FOCUS_BOOK}
        onRename={(id, title) => renames.push([id, title])}
        onFocus={noop}
        onDiff={noop}
        onClose={noop}
        onCreateGroup={noop}
        onRenameGroup={(id, name) => groupRenames.push([id, name])}
        onRecolorGroup={noop}
        onDeleteGroup={noop}
        onOpenInGroup={noop}
        onMoveToGroup={noop}
        pinned={new Set()}
        onTogglePin={noop}
        onSetSessionPolicy={noop}
        onSetSessionFocusPolicy={noop}
        onCycleGroupPolicy={noop}
        manualOrder={NO_ORDER}
        onReorder={noop}
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
 * Open the GROUP rename field the way a user does — double-click the group's
 * name. That button IS the entry point, which is the whole reason #311 is not
 * merely a consistency fix (see the describe below).
 */
async function openGroupField(host: HTMLElement): Promise<HTMLInputElement> {
  await act(async () => {
    groupNameButton(host)!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  });
  return host.querySelector<HTMLInputElement>(`[data-group-card="${GROUP.id}"] input`)!;
}

/** the group's name button, or `null` while the rename field is open in its place */
const groupNameButton = (host: HTMLElement): HTMLElement | null =>
  host.querySelector<HTMLElement>(`[data-rail-group-toggle="${GROUP.id}"]`);

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
  await initI18nForTests();
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

/**
 * The same rule for the GROUP field 380 lines below it in the same file (#311).
 *
 * Not merely a consistency fix. A group's rename entry point IS its name — you
 * double-click the name button — so a group that lost its name would lose the
 * target you have to hit to give it one back. Main has always refused a blank
 * (`cleanName` in group-ipc.ts), so nothing was ever persisted empty; what the
 * unguarded draft did was hand main a name it THROWS on, over a bridge call
 * App does not catch. The field now decides for itself, and it decides the way
 * every other exit from this field already does: the edit ends, the name
 * stands.
 */
describe('the rail GROUP rename field (issue 311)', () => {
  /** the rail with one empty group, reporting every group rename asked for */
  const mount = async (
    groupRenames: Array<[string, string]>
  ): Promise<HTMLElement> => mountRail([], groupRenames, [GROUP]);

  it('commits a real name', async () => {
    const groupRenames: Array<[string, string]> = [];
    const host = await mount(groupRenames);
    const field = await openGroupField(host);
    expect(field.value).toBe('infra');

    await type(field, 'platform');
    await press(field, 'Enter');

    expect(groupRenames).toEqual([['g1', 'platform']]);
  });

  it('refuses an empty commit and leaves the name that was there', async () => {
    const groupRenames: Array<[string, string]> = [];
    const host = await mount(groupRenames);
    const field = await openGroupField(host);

    await type(field, '');
    await press(field, 'Enter');

    expect(groupRenames).toEqual([]);
    // the edit ENDS — same as Escape, because a rejection you cannot dismiss is
    // a trap — and the button you would double-click to try again is still
    // there, still carrying the name. That button is the whole point: it is
    // sized by its own text, so a group with no name has nothing to grab.
    expect(host.querySelector(`[data-group-card="${GROUP.id}"] input`)).toBeNull();
    expect(groupNameButton(host)?.textContent).toContain('infra');
  });

  it('refuses a whitespace-only commit for the same reason', async () => {
    const groupRenames: Array<[string, string]> = [];
    const host = await mount(groupRenames);
    const field = await openGroupField(host);

    await type(field, '   \t ');
    await press(field, 'Enter');

    expect(groupRenames).toEqual([]);
    expect(host.querySelector(`[data-group-card="${GROUP.id}"] input`)).toBeNull();
    expect(groupNameButton(host)?.textContent).toContain('infra');
  });

  it('trims what it does commit, matching main rather than leaning on it', async () => {
    const groupRenames: Array<[string, string]> = [];
    const host = await mount(groupRenames);
    const field = await openGroupField(host);

    await type(field, '  spaced out  ');
    await press(field, 'Enter');

    expect(groupRenames).toEqual([['g1', 'spaced out']]);
  });

  it('still abandons on Escape without committing anything', async () => {
    const groupRenames: Array<[string, string]> = [];
    const host = await mount(groupRenames);
    const field = await openGroupField(host);

    await type(field, 'never mind');
    await press(field, 'Escape');

    expect(groupRenames).toEqual([]);
    expect(host.querySelector(`[data-group-card="${GROUP.id}"] input`)).toBeNull();
  });
});
