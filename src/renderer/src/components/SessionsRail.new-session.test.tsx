// @vitest-environment jsdom
// "+ session" lives in the Sessions list, beside "+ group" (#1163).
//
// It used to sit in a bar of its own above the workspace. The owner asked for
// the bar to go and the button to move here, where the one on the strip across
// the top already is: one place to look, in either placement.
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import i18next from 'i18next';
import { initI18nForTests } from '../i18n/test-i18n';
import { SessionsRail } from './SessionsRail';
import { DEFAULT_BOOK } from '../lib/presentation-policy';
import { uiDelete } from '../lib/ui-state';
import { NO_ORDER } from '../lib/rail-order';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let root: Root | null = null;
const noop = (): void => {};

async function mountRail(onNewSession?: () => void, groupsMade: string[] = []): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <SessionsRail
        sessions={[]}
        groups={[]}
        needing={new Set<string>()}
        palette={['var(--status-working)']}
        policies={DEFAULT_BOOK}
        onRename={noop}
        onFocus={noop}
        onDiff={noop}
        onClose={noop}
        onCreateGroup={(name) => groupsMade.push(name)}
        {...(onNewSession ? { onNewSession } : {})}
        onRenameGroup={noop}
        onRecolorGroup={noop}
        onDeleteGroup={noop}
        onOpenInGroup={noop}
        onMoveToGroup={noop}
        pinned={new Set()}
        onTogglePin={noop}
        onCycleGroupPolicy={noop}
        manualOrder={NO_ORDER}
        onReorder={noop}
      />
    );
  });
  return host;
}

beforeAll(async () => {
  await initI18nForTests();
});

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '';
  uiDelete(['railCollapsed', 'railWidth']);
});

afterEach(async () => {
  if (root) {
    const r = root;
    root = null;
    await act(async () => r.unmount());
  }
});

describe('"+ session" in the Sessions list (issue 1163)', () => {
  it('sits straight after "+ group", and opens a session', async () => {
    let opened = 0;
    const host = await mountRail(() => opened++);
    const add = host.querySelector<HTMLElement>('[data-rail-add-session]')!;
    expect(add.textContent).toBe(i18next.t('rail.addSession'));
    // the same two, in the same order, as on the strip across the top
    expect(Array.from(add.parentElement!.children).map((c) => c.textContent)).toEqual([
      i18next.t('rail.addGroup'),
      i18next.t('rail.addSession'),
    ]);
    await act(async () => add.click());
    expect(opened).toBe(1);
  });

  it('is there with no sessions at all — that is when you need it most', async () => {
    const host = await mountRail(noop);
    expect(host.textContent).toContain(i18next.t('rail.empty'));
    expect(host.querySelector('[data-rail-add-session]')).not.toBeNull();
  });

  it('does not make a group, and "+ group" does not open a session', async () => {
    let opened = 0;
    const groups: string[] = [];
    const host = await mountRail(() => opened++, groups);
    await act(async () => host.querySelector<HTMLElement>('[data-rail-add-session]')!.click());
    expect(groups).toEqual([]);
    await act(async () => host.querySelector<HTMLElement>('.rail-add-group')!.click());
    expect(groups).toEqual([i18next.t('rail.newGroup')]);
    expect(opened).toBe(1);
  });

  it('is not drawn for a list that was not told how to open one', async () => {
    const host = await mountRail();
    expect(host.querySelector('[data-rail-add-session]')).toBeNull();
  });
});
