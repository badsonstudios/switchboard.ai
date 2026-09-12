// The JOIN between the inbox and the card list (#774 review round 2).
//
// Both halves were well covered on their own and joined by nothing: swapping
// `mayHoldForCard` for `hasCard` in the listener left every test green while
// re-introducing a blocker that DESTROYS a live session's message and tells its
// sender the target was closed. These cases exist to fail on that swap.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { holdSiblingMessage } from './sibling-hold';
import { heldMessages, resetInboxCacheForTests } from './sibling-inbox';
import { loadUiState } from './ui-state';
import { sessionStore } from '../store/session-store';
import type { RailSession } from '../model/types';
import type { SiblingMessage } from '../../../shared/sibling-message';

const session = (id: string): RailSession => ({
  id,
  title: id,
  folder: `C:/proj/${id}`,
  status: 'idle',
});

// `sessionStore` is a module singleton and `everSeen` is union-only by design,
// so a card id used in one case is "seen" in the next. Each case therefore
// mints its own ids — which is also closer to the truth, since card ids are
// uuids and never reused.
let c = 0;
const card = (): string => `card-${c++}`;

let n = 0;
const msg = (cardId: string): SiblingMessage => ({
  deliveryId: `d${n++}`,
  cardId,
  from: { id: 'live-a', name: 'Alpha' },
  text: 'please look at the regulator',
  at: '2026-09-11T08:00:00.000Z',
});

beforeEach(async () => {
  vi.stubGlobal('window', {
    switchboard: {
      workspace: { getUi: () => Promise.resolve({}), setUi: () => {} },
    },
  });
  await loadUiState();
  resetInboxCacheForTests();
  // a fresh window's store has never listed anything
  sessionStore.setSessions([]);
});

describe('holdSiblingMessage', () => {
  it('holds for a card the store lists', () => {
    const b = card();
    sessionStore.setSessions([session(b)]);
    expect(holdSiblingMessage(msg(b))).toEqual({ placed: true, shown: false });
    expect(heldMessages(b)).toHaveLength(1);
  });

  it('refuses as GONE for a card the store SAW and lost', () => {
    const b = card();
    sessionStore.setSessions([session(b)]);
    sessionStore.setSessions([]);
    expect(holdSiblingMessage(msg(b))).toEqual({ placed: false, reason: 'gone' });
    expect(heldMessages(b)).toEqual([]);
  });

  it('⚠️ holds for a card the store has NEVER listed — not the same as closed', () => {
    // The swap this file exists to catch. `hasCard` is false here, and a
    // listener written against it would answer "gone" for a session main just
    // resolved and that is still running: the boot window, and every card
    // minted between two refreshes.
    const fresh = card();
    sessionStore.setSessions([session(card())]);
    expect(sessionStore.hasCard(fresh)).toBe(false);
    expect(holdSiblingMessage(msg(fresh))).toEqual({ placed: true, shown: false });
    expect(heldMessages(fresh)).toHaveLength(1);
  });

  it('⚠️ holds while the refresh is FROZEN and main keeps minting cards', () => {
    // `latestWins` declines to apply a failed `sessions:cards`, so the list
    // stops moving. Refusing here would let our own breakage block every
    // session's messages.
    sessionStore.setSessions([session(card())]);
    for (let i = 0; i < 3; i++) {
      expect(holdSiblingMessage(msg(card()))).toEqual({ placed: true, shown: false });
    }
  });

  it('holds for a hidden card — a card with no panel is not gone', () => {
    const a = card();
    const b = card();
    sessionStore.setSessions([session(a), session(b)]);
    sessionStore.setCards([a]);
    expect(holdSiblingMessage(msg(b))).toEqual({ placed: true, shown: false });
  });

  it('answers NO ack for a payload it cannot read, whatever the card list says', () => {
    expect(holdSiblingMessage('not a message')).toBeNull();
  });
});
