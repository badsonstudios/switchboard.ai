// @vitest-environment jsdom
// A group's header is two lines (#1455).
//
// It used to be one flex row: caret, dot, NAME, count, roll-up, waiting chip,
// folded-away pill, three buttons. Everything but the name was `flexShrink: 0`,
// so the name was the one thing that gave way — to "IT…", or to nothing, and
// Dan had a list of groups he could not tell apart. The fix is structural: the
// name shares its line with the buttons only, and the chips are on a line of
// their own. jsdom does no layout, so what is pinned here is that structure;
// the e2e (group-header-name.spec.ts) measures the rendered width.
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import type React from 'react';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { initI18nForTests } from '../i18n/test-i18n';
import { SessionsRail } from './SessionsRail';
import { DEFAULT_BOOK } from '../lib/presentation-policy';
import { uiDelete } from '../lib/ui-state';
import { NO_ORDER } from '../lib/rail-order';
import { RailSession } from '../model/types';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let root: Root | null = null;
const noop = (): void => {};

// A token, not a hex colour: the raw-colour lint cannot tell data from styling.
const GROUP = {
  id: 'g1',
  name: 'Infrastructure and platform work',
  color: 'var(--status-working)',
};
const SESSIONS: RailSession[] = [
  { id: 'a', title: 'alpha', status: 'idle', groupId: 'g1' },
  { id: 'b', title: 'beta', status: 'idle', groupId: 'g1' },
  { id: 'z', title: 'zeta', status: 'idle' },
];

type RailProps = React.ComponentProps<typeof SessionsRail>;

async function mountRail(over: Partial<RailProps> = {}): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <SessionsRail
        sessions={SESSIONS}
        groups={[GROUP]}
        // the screenshot's worst case: one waiting, one folded away
        needing={new Set<string>(['a'])}
        folded={new Set<string>(['b', 'z'])}
        palette={['var(--status-working)']}
        policies={DEFAULT_BOOK}
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
        pinned={new Set()}
        onTogglePin={noop}
        onCycleGroupPolicy={noop}
        manualOrder={NO_ORDER}
        onReorder={noop}
        {...over}
      />
    );
  });
  return host;
}

const card = (host: HTMLElement, key: string): HTMLElement =>
  host.querySelector<HTMLElement>(`[data-group-card="${key}"]`)!;
const nameOf = (host: HTMLElement, key: string): HTMLElement =>
  card(host, key).querySelector<HTMLElement>(`[data-rail-group-toggle="${key}"]`)!;
const chipsOf = (host: HTMLElement, key: string): HTMLElement =>
  card(host, key).querySelector<HTMLElement>('[data-rail-group-line="chips"]')!;

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

describe('a group header puts its name on a line of its own (#1455)', () => {
  it('the chips are on line 2, in a box the name is not in', async () => {
    const host = await mountRail();
    const chips = chipsOf(host, 'g1');
    const name = nameOf(host, 'g1');
    // every chip the screenshot showed squeezing the name out
    for (const sel of ['[data-rail-group-summary]', '[data-rail-group-folded]']) {
      expect(chips.querySelector(sel), sel).not.toBeNull();
    }
    expect(chips.contains(name)).toBe(false);
    // the count chip too: it is the first thing on line 2
    expect(chips.firstElementChild!.textContent).toBe('2');
    expect(chips.style.gridRow).toBe('2');
    // and the name is on line 1
    expect(name.style.gridRow).toBe('1');
    expect(name.parentElement!.classList.contains('rail-head')).toBe(true);
  });

  it('starts line 2 in the name column, so the chips line up under the name', async () => {
    const host = await mountRail();
    expect(nameOf(host, 'g1').style.gridColumn).toBe('3');
    expect(chipsOf(host, 'g1').style.gridColumn).toMatch(/^3 \/ 5$/);
  });

  it('keeps the arrange / add / close buttons on the name line', async () => {
    const host = await mountRail();
    const policy = card(host, 'g1').querySelector<HTMLElement>('[data-group-policy="g1"]')!;
    const buttons = policy.parentElement!;
    expect(buttons.style.gridRow).toBe('1');
    expect(buttons.querySelectorAll('button')).toHaveLength(3);
    expect(chipsOf(host, 'g1').contains(policy)).toBe(false);
  });

  it('carries the full name in its tooltip, for when it does not fit', async () => {
    const host = await mountRail();
    expect(nameOf(host, 'g1').title).toContain(GROUP.name);
  });

  it('the "No group" header is laid out the same way', async () => {
    const host = await mountRail();
    const name = nameOf(host, 'ungrouped');
    const chips = chipsOf(host, 'ungrouped');
    expect(chips.querySelector('[data-rail-group-folded]')).not.toBeNull();
    expect(chips.contains(name)).toBe(false);
    expect(name.style.gridColumn).toBe('3');
    expect(name.style.gridRow).toBe('1');
    expect(name.title).toBe(name.textContent);
  });
});
