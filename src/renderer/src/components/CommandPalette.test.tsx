// @vitest-environment jsdom
// The command palette's ID WIRING (#654).
//
// This component had no unit test at all, and #654 rewired four ids in it —
// `aria-controls`, `aria-activedescendant`, the listbox and every row — from
// literal strings to a `React.useId()` prefix. The source-tree scan in
// `markdown.test.tsx` catches a literal coming BACK; nothing caught the ids
// still RESOLVING, so a typo (`${paletteId}row` where the listbox says
// `${paletteId}rows`) would leave a combobox pointing at nothing and every
// suite green. Found in review, and this file is the answer to it.
//
// WHY THIS COMPONENT AND NOT THE TWO DIALOGS: of the three #654 touched, this
// is the one whose refs were LIVE. `App.tsx` renders `UpdateDialog` — which
// puts GitHub's release notes through `<Markdown>` — immediately BEFORE the
// palette, and an IDREF resolves to the FIRST element in tree order carrying
// that id. So release-notes content really could plant `palette-row-<command>`
// above these refs and capture them (verified in Chromium 149: the combobox's
// `activedescendant` resolved to the planted `<div>`, with no `role` on it,
// because content cannot write one). The two dialogs render BEFORE the feed
// and the viewer and were never capturable from there.
//
// It is deliberately narrow: what the ROWS are is `lib/palette.ts`'s job and is
// tested there.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { initI18nForTests } from '../i18n/test-i18n';
import { CommandPalette } from './CommandPalette';
import type { Command, CommandContext } from '../lib/commands';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let root: Root | null = null;
let host: HTMLElement;

const ran = vi.fn();
const commands: Command[] = [
  {
    id: 'help.about',
    titleKey: 'palette.label',
    categoryKey: 'palette.label',
    scope: 'app',
    run: ran,
  },
  {
    id: 'attention.pushSetup',
    titleKey: 'palette.placeholder',
    categoryKey: 'palette.label',
    scope: 'app',
    run: ran,
  },
];

const ctx = (): CommandContext =>
  ({ sessions: [], activeCardId: null }) as unknown as CommandContext;

async function render(open: boolean): Promise<void> {
  await act(async () => {
    root!.render(
      <CommandPalette
        open={open}
        onClose={vi.fn()}
        commands={commands}
        contextOf={ctx}
        focusCard={vi.fn()}
        platform="other"
      />
    );
  });
}

const combobox = (): HTMLInputElement =>
  host.querySelector<HTMLInputElement>('[role="combobox"]')!;

beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  // jsdom has no layout, so it ships no `scrollIntoView` — and the palette
  // keeps the selected row in view on every selection change. Stubbed rather
  // than worked around: this file is about ids, and the scroll is not on trial.
  (Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = (): void => {};
  ran.mockReset();
  document.body.innerHTML = '';
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await initI18nForTests();
});

afterEach(async () => {
  if (root) {
    const r = root;
    root = null;
    await act(async () => r.unmount());
  }
});

describe('the command palette’s id wiring (#654)', () => {
  it('every IDREF it writes resolves to the element it means', async () => {
    await render(true);
    const input = combobox();

    const controls = input.getAttribute('aria-controls');
    expect(controls).toBeTruthy();
    const listbox = host.querySelector(`[id="${controls}"]`);
    expect(listbox?.getAttribute('role')).toBe('listbox');

    const active = input.getAttribute('aria-activedescendant');
    expect(active).toBeTruthy();
    const option = host.querySelector(`[id="${active}"]`);
    // Not just "an element exists": it has to be the SELECTED option, which is
    // the only thing `aria-activedescendant` means.
    expect(option?.getAttribute('role')).toBe('option');
    expect(option?.getAttribute('aria-selected')).toBe('true');
    // …and it is inside the listbox the other ref names, not a stray match
    expect(listbox?.contains(option ?? null)).toBe(true);
  });

  it('writes no id content could name, and the test hooks still find the rows', async () => {
    await render(true);
    const ids = [...host.querySelectorAll('[id]')].map((el) => el.id);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(id).not.toMatch(/^palette-rows?\b|^palette-row-/);

    // The e2e suite selects rows by these hooks now (7 selectors moved in
    // #654). They are attribute NAMES, not ids: content cannot emit a `data-*`
    // at all (`ALLOW_DATA_ATTR: false`), so a hook is not a second guessable
    // name. If they are ever renamed, five e2e specs go red — this reds first.
    expect(host.querySelector('[data-palette-rows]')).not.toBeNull();
    expect(host.querySelector('[data-palette-row="help.about"]')).not.toBeNull();
    expect(host.querySelector('[data-palette-row="attention.pushSetup"]')).not.toBeNull();
  });

  it('the ids belong to the TREE, not to this component', async () => {
    // `React.useId()` is NOT a secret — React 19 numbers client ids from a
    // module-global counter — so the honest property is this one: the strings
    // move when anything else in the tree calls `useId` first, which is what
    // makes them not-a-published-name. Same pin as the two dialogs'.
    await render(true);
    const before = [...host.querySelectorAll('[id]')].map((el) => el.id);
    const Ahead = (): React.JSX.Element => <i data-ahead={React.useId()} />;
    await act(async () => {
      root!.render(
        <>
          <Ahead />
          <CommandPalette
            open
            onClose={vi.fn()}
            commands={commands}
            contextOf={ctx}
            focusCard={vi.fn()}
            platform="other"
          />
        </>
      );
    });
    const after = [...host.querySelectorAll('[id]')].map((el) => el.id);
    expect(after.length).toBe(before.length);
    expect(after.filter((id) => before.includes(id))).toEqual([]);
  });
});
