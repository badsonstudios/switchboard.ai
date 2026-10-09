// @vitest-environment jsdom
// What the Sessions list says now that two rows above it are gone (#1164).
//
// There used to be a row of lamps and a Collapsed strip above the workspace.
// The owner had both removed outright. Three things they said are now said by
// the list itself, and each has a claim here: which sessions are folded away,
// which one the last jump landed on, and how many need you.
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import type React from 'react';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { initI18nForTests } from '../i18n/test-i18n';
import { SessionsRail } from './SessionsRail';
import { DEFAULT_BOOK } from '../lib/presentation-policy';
import { DEFAULT_FOCUS_BOOK } from '../lib/focus-policy';
import { uiDelete } from '../lib/ui-state';
import { NO_ORDER } from '../lib/rail-order';
import { RailSession } from '../model/types';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let root: Root | null = null;
const noop = (): void => {};

const SESSIONS: RailSession[] = [
  { id: 'a', title: 'alpha', status: 'idle' },
  { id: 'b', title: 'beta', status: 'idle' },
  { id: 'c', title: 'gamma', status: 'idle' },
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
        groups={[]}
        needing={new Set<string>()}
        palette={['var(--status-working)']}
        policies={DEFAULT_BOOK}
        focusPolicies={DEFAULT_FOCUS_BOOK}
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
        onSetSessionPolicy={noop}
        onSetSessionFocusPolicy={noop}
        onCycleGroupPolicy={noop}
        manualOrder={NO_ORDER}
        onReorder={noop}
        {...over}
      />
    );
  });
  return host;
}

const rowOf = (host: HTMLElement, id: string): HTMLElement =>
  host.querySelector<HTMLElement>(`[data-rail-open="${id}"]`)!.closest<HTMLElement>('.rail-row')!;

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

describe('a session that is folded away (issue 1164)', () => {
  it('has a dashed edge on its row, and says so out loud', async () => {
    // the Collapsed strip was the only thing that listed these; without the
    // mark, nothing in this placement would say which sessions are not on screen
    const host = await mountRail({ folded: new Set(['b']) });
    expect(rowOf(host, 'b').dataset.folded).toBe('true');
    expect(rowOf(host, 'b').getAttribute('style')).toContain('dashed');
    expect(
      host.querySelector('[data-rail-open="b"]')!.getAttribute('aria-label')
    ).toContain('folded away');
  });

  it('leaves every other row exactly as it was', async () => {
    const host = await mountRail({ folded: new Set(['b']) });
    for (const id of ['a', 'c']) {
      expect(rowOf(host, id).dataset.folded).toBeUndefined();
      expect(rowOf(host, id).getAttribute('style')).not.toContain('dashed');
    }
  });

  it('is brought back by the click that goes to it — there is no second gesture', async () => {
    const focused: string[] = [];
    const host = await mountRail({ folded: new Set(['b']), onFocus: (id) => focused.push(id) });
    await act(async () => host.querySelector<HTMLElement>('[data-rail-open="b"]')!.click());
    expect(focused).toEqual(['b']);
  });

  it('a list that is told nothing about folding marks nothing', async () => {
    const host = await mountRail();
    expect(host.querySelector('[data-folded]')).toBeNull();
  });
});

describe('the session the last jump landed on (issue 1164)', () => {
  it('is outlined, and only that one', async () => {
    // the row of lamps used to light the one you jumped to; the row does now
    const host = await mountRail({ urgency: new Map([['c', null]]) });
    expect(rowOf(host, 'c').dataset.flash).toBe('true');
    expect(rowOf(host, 'a').dataset.flash).toBeUndefined();
    expect(rowOf(host, 'b').dataset.flash).toBeUndefined();
  });

  it('is not outlined once its beat has run out', async () => {
    const host = await mountRail({ urgency: new Map([['c', Date.now() - 1]]) });
    expect(rowOf(host, 'c').dataset.flash).toBeUndefined();
  });
});

describe('how many need you (issue 1164)', () => {
  it('is at the foot of the list, as a number a spec can read', async () => {
    const host = await mountRail({ needing: new Set(['a', 'c']) });
    expect(host.querySelector<HTMLElement>('[data-rail-need]')!.dataset.railNeed).toBe('2');
  });

  it('is not there at all when nobody is waiting', async () => {
    const host = await mountRail();
    expect(host.querySelector('[data-rail-need]')).toBeNull();
  });
});

describe('a group in the list, for sessions whose rows may not be drawn (issue 1164)', () => {
  // A token, not a hex colour: this is renderer TSX and the raw-colour lint
  // cannot tell data from styling. Nothing here asserts on the colour.
  const GROUP = { id: 'g1', name: 'api', color: 'var(--status-working)' };
  const grouped: RailSession[] = SESSIONS.map((x) => ({ ...x, groupId: GROUP.id }));
  const card = (host: HTMLElement): HTMLElement =>
    host.querySelector<HTMLElement>('[data-group-card="g1"]')!;

  it('says how many of its sessions are folded away', async () => {
    // the Collapsed strip listed these whatever the group was doing; closed,
    // the group draws no rows, so the header is the only place left to say it
    const host = await mountRail({ sessions: grouped, groups: [GROUP], folded: new Set(['a', 'c']) });
    const chip = card(host).querySelector<HTMLElement>('[data-rail-group-folded]')!;
    expect(chip.textContent).toBe('2 folded away');
  });

  it('says nothing about folding when none of its sessions is', async () => {
    const host = await mountRail({ sessions: grouped, groups: [GROUP], folded: new Set() });
    expect(card(host).querySelector('[data-rail-group-folded]')).toBeNull();
  });

  it('is outlined when the last jump landed on one of its sessions', async () => {
    const host = await mountRail({
      sessions: grouped,
      groups: [GROUP],
      urgency: new Map([['b', null]]),
    });
    expect(card(host).dataset.flash).toBe('true');
    expect(card(host).getAttribute('style')).toContain('outline');
  });

  it('is not outlined for a jump that landed somewhere else', async () => {
    const loose: RailSession[] = [
      ...grouped.slice(0, 2),
      { id: 'z', title: 'zeta', status: 'idle' },
    ];
    const host = await mountRail({
      sessions: loose,
      groups: [GROUP],
      urgency: new Map([['z', null]]),
    });
    expect(card(host).dataset.flash).toBeUndefined();
  });
});

describe('a dashed row explains itself to a mouse too (issue 1164)', () => {
  it('has the same hint the pill has', async () => {
    const host = await mountRail({ folded: new Set(['b']) });
    expect(rowOf(host, 'b').title).not.toBe('');
    expect(rowOf(host, 'a').title).toBe('');
  });
});
