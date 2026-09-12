// @vitest-environment jsdom
// #774 — the rail's mark for a message another session is holding for you.
//
// #765 put the waiting count on the card's own Session TAB. That answers
// nothing for a card that is collapsed or hidden (the ladder's lower rungs
// remove the panel outright) and nothing for a user looking at a different
// card — the sending agent was told "the user may not notice it", which was
// true and left the user with no prompt to go and look. The rail row is the
// one surface such a card still has.
//
// Three properties, and the third is the one with teeth:
//
//   • the mark appears, carries the COUNT, and is gone at zero;
//   • the count reaches a screen reader — the mark itself is `aria-hidden`
//     decoration like every other glyph on the row, so if it is not folded
//     into the row button's accessible name it is readable to the eye and to
//     nobody else;
//   • ⚠️ SUBSCRIBING FROM THE RAIL MUST NOT MAKE A CARD "SHOWN". `shown` is
//     reported to the sending agent and means "a composer for that card is
//     mounted". The rail is mounted for every session always, so a rail that
//     subscribed the ordinary way (`useHeldMessages`) would report all of them
//     as shown for ever, and the agent-facing sentence this whole item exists
//     to earn would become a lie on every send. That is a one-word mistake in
//     `useHeldCounts` and it is invisible from the pixels, so it is asserted
//     here against the ack rather than against the DOM.
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { createRoot, Root } from 'react-dom/client';
import { act } from 'react';
import { SessionsRail } from './SessionsRail';
import { RailGroup, RailSession } from '../model/types';
import { DEFAULT_BOOK } from '../lib/presentation-policy';
import { DEFAULT_FOCUS_BOOK } from '../lib/focus-policy';
import { NO_ORDER } from '../lib/rail-order';
import { initI18nForTests } from '../i18n/test-i18n';
import {
  receiveSiblingMessage,
  removeHeldMessages,
  resetInboxCacheForTests,
} from '../lib/sibling-inbox';
import { loadUiState, uiDelete } from '../lib/ui-state';
import type { SiblingMessage } from '../../../shared/sibling-message';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

const noop = (): void => {};

let host: HTMLDivElement;
let root: Root;

const session = (id: string): RailSession => ({
  id,
  title: id,
  status: 'idle',
  // a folder each, so nothing emergently auto-groups underneath the test
  folder: `C:\\p\\${id}`,
});

let n = 0;
const msg = (cardId: string, over: Partial<SiblingMessage> = {}): SiblingMessage => ({
  deliveryId: `d${n++}`,
  cardId,
  from: { id: 'live-a', name: 'Alpha' },
  text: 'please look at the regulator',
  at: '2026-09-11T08:00:00.000Z',
  ...over,
});

async function mount(sessions: RailSession[]): Promise<void> {
  await act(async () => {
    root.render(
      <SessionsRail
        sessions={sessions}
        groups={[]}
        needing={new Set<string>()}
        palette={['var(--status-working)']}
        selectedId={null}
        policies={DEFAULT_BOOK}
        focusPolicies={DEFAULT_FOCUS_BOOK}
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
        onSetSessionPolicy={noop}
        onSetSessionFocusPolicy={noop}
        onCycleGroupPolicy={noop}
      />
    );
  });
}

/** the waiting mark on one row, or null */
const mark = (cardId: string): HTMLElement | null =>
  host.querySelector<HTMLElement>(`[data-rail-waiting="${cardId}"]`);

/** what a screen reader is told about one row */
const rowName = (cardId: string): string =>
  host.querySelector<HTMLElement>(`[data-rail-open="${cardId}"]`)?.getAttribute('aria-label') ?? '';

beforeAll(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  await initI18nForTests();
});

beforeEach(async () => {
  uiDelete(['railCollapsed', 'railWidth']);
  await loadUiState();
  resetInboxCacheForTests();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe('the waiting mark', () => {
  it('is absent on a card with nothing waiting', async () => {
    await mount([session('card-a')]);
    expect(mark('card-a')).toBeNull();
  });

  it('appears with the count, and only on the card the message went to', async () => {
    await act(async () => {
      receiveSiblingMessage(msg('card-b'));
      receiveSiblingMessage(msg('card-b'));
    });
    await mount([session('card-a'), session('card-b')]);

    expect(mark('card-a')).toBeNull();
    expect(mark('card-b')?.textContent).toBe('2');
  });

  it('appears on a card that is ALREADY mounted when the message lands', async () => {
    // The case the whole item is for: the user is looking at something else and
    // a sibling leaves a note. Nothing re-mounts, so the rail has to be
    // SUBSCRIBED — a count read once at mount would sit at zero for ever.
    await mount([session('card-b')]);
    expect(mark('card-b')).toBeNull();

    await act(async () => {
      receiveSiblingMessage(msg('card-b'));
    });
    expect(mark('card-b')?.textContent).toBe('1');
  });

  it('goes away when the messages do', async () => {
    const m = msg('card-b');
    await act(async () => {
      receiveSiblingMessage(m);
    });
    await mount([session('card-b')]);
    expect(mark('card-b')?.textContent).toBe('1');

    await act(async () => {
      removeHeldMessages('card-b', [m.deliveryId]);
    });
    expect(mark('card-b')).toBeNull();
  });

  it('follows a card that appears in the rail after the message arrived', async () => {
    // The id list is the other half of the snapshot: a message that landed
    // before the card was listed must not leave the new row blank, and that is
    // a different cache key from "a message arrived".
    await act(async () => {
      receiveSiblingMessage(msg('card-b'));
    });
    await mount([session('card-a')]);
    expect(mark('card-b')).toBeNull();

    await mount([session('card-a'), session('card-b')]);
    expect(mark('card-b')?.textContent).toBe('1');
  });
});

describe('what a screen reader is told', () => {
  it('folds the count into the row button’s own name', async () => {
    // The mark is `aria-hidden`, per this file's rule that every glyph on a row
    // is decoration and the FACT lives in the button's accessible name. Without
    // this the count is visible and unannounced.
    await act(async () => {
      receiveSiblingMessage(msg('card-b'));
    });
    await mount([session('card-b')]);

    expect(mark('card-b')?.getAttribute('aria-hidden')).toBe('true');
    expect(rowName('card-b')).toMatch(/1 message waiting from another session/);
  });

  it('pluralizes, and keeps the status it wraps', async () => {
    await act(async () => {
      receiveSiblingMessage(msg('card-b'));
      receiveSiblingMessage(msg('card-b'));
    });
    await mount([session('card-b')]);

    const name = rowName('card-b');
    expect(name).toMatch(/2 messages waiting from other sessions/);
    // the state the row already announced is still in there — the waiting
    // clause WRAPS it rather than replacing it
    expect(name).toMatch(/idle/);
    expect(name).toMatch(/card-b/);
  });

  it('says nothing about waiting when nothing is', async () => {
    await mount([session('card-a')]);
    expect(rowName('card-a')).not.toMatch(/waiting/i);
  });
});

describe('a COLLAPSED group still says something is inside (#774 review)', () => {
  // A collapsed group renders NO member rows, so the row mark is not in the
  // DOM — and the header read "calm" over unread messages. The attention count
  // already rolls up for this exact reason; so does this one now.
  const team: RailGroup = { id: 'g1', name: 'Team', color: 'var(--status-working)' };
  const inTeam = (id: string): RailSession => ({ ...session(id), groupId: team.id });

  async function mountGrouped(sessions: RailSession[]): Promise<void> {
    await act(async () => {
      root.render(
        <SessionsRail
          sessions={sessions}
          groups={[team]}
          needing={new Set<string>()}
          palette={['var(--status-working)']}
          selectedId={null}
          policies={DEFAULT_BOOK}
          focusPolicies={DEFAULT_FOCUS_BOOK}
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
          onSetSessionPolicy={noop}
          onSetSessionFocusPolicy={noop}
          onCycleGroupPolicy={noop}
        />
      );
    });
  }

  const groupChip = (): HTMLElement | null =>
    host.querySelector<HTMLElement>('[data-rail-group-waiting]');

  /** click the group's own header toggle */
  async function collapseGroup(): Promise<void> {
    const toggle = host.querySelector<HTMLButtonElement>('.rail-head-toggle')!;
    await act(async () => toggle.click());
  }

  it('sums what is waiting across the group’s sessions', async () => {
    await act(async () => {
      receiveSiblingMessage(msg('card-a'));
      receiveSiblingMessage(msg('card-b'));
      receiveSiblingMessage(msg('card-b'));
    });
    await mountGrouped([inTeam('card-a'), inTeam('card-b')]);
    expect(groupChip()?.textContent).toBe('3 waiting');
  });

  it('⚠️ is still there once the group is COLLAPSED and the rows are gone', async () => {
    await act(async () => {
      receiveSiblingMessage(msg('card-a'));
    });
    await mountGrouped([inTeam('card-a')]);
    expect(mark('card-a')).not.toBeNull();

    await collapseGroup();
    expect(mark('card-a')).toBeNull(); // the row itself is not rendered at all
    expect(groupChip()?.textContent).toBe('1 waiting');
  });

  it('is absent when the group holds nothing waiting', async () => {
    await mountGrouped([inTeam('card-a')]);
    expect(groupChip()).toBeNull();
  });

  it('⚠️ puts the count in the header BUTTON’s name, not only in the chip', async () => {
    // The chip is a role-less span — decoration, exactly like the row marks.
    // Without this, collapsing a group takes the count away from a
    // screen-reader user entirely, on the one surface that exists BECAUSE the
    // rows are gone. `aria-label` replaces contents, so the name rides along.
    await act(async () => {
      receiveSiblingMessage(msg('card-a'));
      receiveSiblingMessage(msg('card-a'));
    });
    await mountGrouped([inTeam('card-a')]);
    const toggle = host.querySelector<HTMLButtonElement>('.rail-head-toggle')!;
    const name = toggle.getAttribute('aria-label') ?? toggle.textContent ?? '';
    expect(name).toMatch(/2 messages waiting from other sessions/);
    expect(name).toMatch(/Team/);

    await collapseGroup();
    const collapsedName =
      host.querySelector<HTMLButtonElement>('.rail-head-toggle')!.getAttribute('aria-label') ?? '';
    expect(collapsedName).toMatch(/2 messages waiting from other sessions/);
  });

  it('keeps the plain group name when nothing is waiting', async () => {
    await mountGrouped([inTeam('card-a')]);
    const toggle = host.querySelector<HTMLButtonElement>('.rail-head-toggle')!;
    expect(toggle.getAttribute('aria-label')).toBeNull();
    expect(toggle.textContent).toBe('Team');
  });
});

describe('⚠️ the rail does NOT make a card count as shown to the sender', () => {
  it('acks shown:false for a card the rail is listing and no composer is', async () => {
    // `shown` is the sending agent's only clue about how soon a human will
    // read the message. The rail is mounted for every session at all times, so
    // if its subscription counted, every send would answer "it is on screen"
    // — and the "you may not notice it" sentence that this very feature earns
    // would never be printed again.
    await mount([session('card-b')]);

    let ack: unknown;
    await act(async () => {
      ack = receiveSiblingMessage(msg('card-b'));
    });
    expect(ack).toEqual({ placed: true, shown: false });

    // and the mark is painted all the same — the count is live, the card is
    // simply not being READ by anyone
    expect(mark('card-b')?.textContent).toBe('1');
  });

  it('still answers shown:false for the SECOND message, with the rail rendering the first', async () => {
    // The subscription exists by now (the first message made the mark appear),
    // so this is the case where a listener/observer mix-up actually shows up.
    await mount([session('card-b')]);
    await act(async () => {
      receiveSiblingMessage(msg('card-b'));
    });

    let ack: unknown;
    await act(async () => {
      ack = receiveSiblingMessage(msg('card-b'));
    });
    expect(ack).toEqual({ placed: true, shown: false });
  });
});
