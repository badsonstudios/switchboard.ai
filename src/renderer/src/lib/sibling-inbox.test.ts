// The per-card inbox for messages from other sessions (P2-E11-05).
//
// What this pins is the HOLDING: a message is filed, persisted, bounded and
// acknowledged honestly — and nothing in here can send one. That last half is
// asserted structurally below, against the module's own source, because "it
// has no way to submit" is a property worth keeping after everyone stops
// looking.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  beginSend,
  heldMessages,
  inboxKey,
  isSendInFlight,
  pruneInboxes,
  receiveSiblingMessage,
  removeHeldMessages,
  resetInboxCacheForTests,
  settledMessages,
  SIBLING_SETTLE_MS,
  staleInboxKeys,
  withForwarded,
  type HeldMessage,
} from './sibling-inbox';
import { loadUiState, uiFlush } from './ui-state';
import {
  SIBLING_INBOX_CAP,
  SIBLING_INBOX_CHAR_CAP,
  SIBLING_MESSAGE_CHAR_CAP,
  type SiblingMessage,
} from '../../../shared/sibling-message';

let sent: Record<string, unknown>[];

function bridge(initial: Record<string, unknown> = {}): void {
  sent = [];
  vi.stubGlobal('window', {
    switchboard: {
      workspace: {
        getUi: () => Promise.resolve(initial),
        setUi: (ui: unknown) => sent.push({ ...(ui as Record<string, unknown>) }),
      },
    },
  });
}

let n = 0;
const msg = (over: Partial<SiblingMessage> = {}): SiblingMessage => ({
  deliveryId: `d${n++}`,
  cardId: 'card-b',
  from: { id: 'live-a', name: 'Alpha' },
  text: 'please look at the regulator',
  at: '2026-09-10T08:00:00.000Z',
  ...over,
});

beforeEach(async () => {
  bridge();
  await loadUiState();
  resetInboxCacheForTests();
});

afterEach(() => {
  uiFlush();
  vi.unstubAllGlobals();
});

describe('receiveSiblingMessage', () => {
  it('files the message on its CARD and acknowledges it as placed', () => {
    const m = msg();
    expect(receiveSiblingMessage(m)).toEqual({ placed: true, shown: false });
    expect(heldMessages('card-b')).toEqual([
      { id: m.deliveryId, from: { id: 'live-a', name: 'Alpha' }, text: m.text, at: m.at },
    ]);
    expect(heldMessages('card-other')).toEqual([]);
  });

  it('persists IMMEDIATELY — the sender is told "it is waiting" the moment this returns', () => {
    // `uiSet`, not `uiSetSoon`: a quit inside the debounce must not lose a
    // message whose sender has already been told it is safe in the box.
    const m = msg();
    receiveSiblingMessage(m);
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.at(-1)?.[inboxKey('card-b')]).toEqual([
      { id: m.deliveryId, from: m.from, text: m.text, at: m.at },
    ]);
  });

  it('keeps them in arrival order', () => {
    const a = msg({ text: 'first' });
    const b = msg({ text: 'second' });
    receiveSiblingMessage(a);
    receiveSiblingMessage(b);
    expect(heldMessages('card-b').map((h) => h.text)).toEqual(['first', 'second']);
  });

  it(`refuses the ${SIBLING_INBOX_CAP + 1}th as FULL — and files nothing`, () => {
    for (let i = 0; i < SIBLING_INBOX_CAP; i++) {
      expect(receiveSiblingMessage(msg())).toMatchObject({ placed: true });
    }
    expect(receiveSiblingMessage(msg({ text: 'one too many' }))).toEqual({ placed: false, reason: 'full' });
    expect(heldMessages('card-b')).toHaveLength(SIBLING_INBOX_CAP);
    expect(heldMessages('card-b').some((h) => h.text === 'one too many')).toBe(false);
  });

  it(`refuses as FULL once the waiting TEXT would pass ${SIBLING_INBOX_CHAR_CAP.toLocaleString('en-US')} characters (#765 review)`, () => {
    // Ten full-size messages would be 200k characters in one card's entry of
    // the workspace blob, which every other preference pays to push and save.
    const big = 'x'.repeat(SIBLING_MESSAGE_CHAR_CAP);
    const fits = Math.floor(SIBLING_INBOX_CHAR_CAP / SIBLING_MESSAGE_CHAR_CAP);
    for (let i = 0; i < fits; i++) expect(receiveSiblingMessage(msg({ text: big }))).toMatchObject({ placed: true });
    expect(receiveSiblingMessage(msg({ text: 'one more small one' }))).toEqual({ placed: false, reason: 'full' });
    expect(heldMessages('card-b')).toHaveLength(fits);
  });

  it('the cap is per card', () => {
    for (let i = 0; i < SIBLING_INBOX_CAP; i++) receiveSiblingMessage(msg());
    expect(receiveSiblingMessage(msg({ cardId: 'card-c' }))).toMatchObject({ placed: true });
  });

  it('the same delivery twice is ONE message', () => {
    const m = msg();
    receiveSiblingMessage(m);
    expect(receiveSiblingMessage(m)).toMatchObject({ placed: true });
    expect(heldMessages('card-b')).toHaveLength(1);
  });

  it.each([
    ['not an object', 'hello'],
    ['null', null],
    ['no card', { ...msg(), cardId: '' }],
    ['no delivery id', { ...msg(), deliveryId: '' }],
    ['no sender', { ...msg(), from: null }],
    ['a sender with no name', { ...msg(), from: { id: 'x' } }],
    ['text that is not text', { ...msg(), text: 5 }],
    ['text over the cap main enforces', msg({ text: 'x'.repeat(SIBLING_MESSAGE_CHAR_CAP + 1) })],
    // The second lock on the #765-review Blocker: main refuses these first,
    // and this is the text the user's Enter will send.
    ['a terminal escape in the text', msg({ text: `hi ${String.fromCharCode(27)}[201~` })],
    ['a bidi override in the text', msg({ text: `ok ${String.fromCharCode(0x202e)}x` })],
    ['a control character in the sender name', msg({ from: { id: 'a', name: `A${String.fromCharCode(7)}` } })],
  ])('answers NO ack for a payload with %s — and files nothing', (_label, raw) => {
    // No ack means main reports "not confirmed", which is the truth. Answering
    // "full" or "placed" would be this end claiming something about a message
    // it could not read.
    expect(receiveSiblingMessage(raw)).toBeNull();
    expect(heldMessages('card-b')).toEqual([]);
  });

  describe('the card has to still be there (#774)', () => {
    const gone = (): boolean => false;
    const there = (): boolean => true;

    it('refuses as GONE, and files nothing, when the card is no longer known', () => {
      // Main resolved the target and the message then crossed IPC; a card
      // closed inside that window used to be filed under, acked as waiting,
      // and swept at the next boot — with the sending agent told all along
      // that a person had it.
      expect(receiveSiblingMessage(msg(), gone)).toEqual({ placed: false, reason: 'gone' });
      expect(heldMessages('card-b')).toEqual([]);
    });

    it('is asked about the card the message names', () => {
      const asked: string[] = [];
      receiveSiblingMessage(msg({ cardId: 'card-q' }), (id) => {
        asked.push(id);
        return true;
      });
      expect(asked).toEqual(['card-q']);
    });

    it('places it when the card is known', () => {
      expect(receiveSiblingMessage(msg(), there)).toEqual({ placed: true, shown: false });
      expect(heldMessages('card-b')).toHaveLength(1);
    });

    it('places it when NO predicate is given — nobody told us otherwise', () => {
      expect(receiveSiblingMessage(msg())).toEqual({ placed: true, shown: false });
    });

    it('GONE outranks FULL — a closed card’s inbox is beside the point', () => {
      for (let i = 0; i < SIBLING_INBOX_CAP; i++) receiveSiblingMessage(msg());
      expect(receiveSiblingMessage(msg(), gone)).toEqual({ placed: false, reason: 'gone' });
    });

    it('a payload that is not a message is still NO ack, however gone the card is', () => {
      // Order matters the other way here: "I could not read it" outranks "the
      // card is gone", because the first is a fact about this end and the
      // second is a claim about the card named in a payload we could not read.
      expect(receiveSiblingMessage('nonsense', gone)).toBeNull();
    });

    it('a predicate that THROWS means known, not gone', () => {
      // The doubt resolves toward the old behaviour: wrongly holding costs a
      // message waiting in a card the user can still open, wrongly refusing
      // tells an agent its message went nowhere while it sits in the composer.
      const ack = receiveSiblingMessage(msg(), () => {
        throw new Error('card list unreadable');
      });
      expect(ack).toEqual({ placed: true, shown: false });
      expect(heldMessages('card-b')).toHaveLength(1);
    });

    it('a predicate answering a non-boolean is not a yes', () => {
      // It crosses no boundary, but it is injected — and `=== true` is the
      // difference between "said yes" and "returned something truthy".
      const ack = receiveSiblingMessage(msg(), (() => 'yes') as unknown as (id: string) => boolean);
      expect(ack).toEqual({ placed: false, reason: 'gone' });
    });
  });

  it('copies only the fields it keeps — nothing else rides into the workspace file', () => {
    receiveSiblingMessage({ ...msg(), submit: true, extra: 'x', from: { id: 'a', name: 'A', role: 'admin' } });
    const [h] = heldMessages('card-b');
    expect(Object.keys(h).sort()).toEqual(['at', 'from', 'id', 'text']);
    expect(Object.keys(h.from).sort()).toEqual(['id', 'name']);
  });
});

describe('what is held survives', () => {
  it('a relaunch — read back from the blob main hands the next window', async () => {
    const stored: HeldMessage[] = [{ id: 'd-x', from: { id: 'live-a', name: 'Alpha' }, text: 'kept', at: 'T' }];
    bridge({ [inboxKey('card-b')]: stored });
    await loadUiState();
    resetInboxCacheForTests();
    expect(heldMessages('card-b')).toEqual(stored);
  });

  it('tolerates garbage in the blob rather than throwing on mount', async () => {
    bridge({ [inboxKey('card-b')]: [{ id: 'ok', from: { id: 'a', name: 'A' }, text: 't', at: 'T' }, 42, null, { id: 1 }] });
    await loadUiState();
    resetInboxCacheForTests();
    expect(heldMessages('card-b').map((h) => h.id)).toEqual(['ok']);
    bridge({ [inboxKey('card-c')]: 'not a list' });
    await loadUiState();
    resetInboxCacheForTests();
    expect(heldMessages('card-c')).toEqual([]);
  });

  it('hands back the SAME array until something changes (a snapshot, for useSyncExternalStore)', () => {
    receiveSiblingMessage(msg());
    const a = heldMessages('card-b');
    expect(heldMessages('card-b')).toBe(a);
    receiveSiblingMessage(msg());
    expect(heldMessages('card-b')).not.toBe(a);
  });
});

describe('removeHeldMessages', () => {
  it('takes exactly those off the card', () => {
    const a = msg({ text: 'a' });
    const b = msg({ text: 'b' });
    receiveSiblingMessage(a);
    receiveSiblingMessage(b);
    removeHeldMessages('card-b', [a.deliveryId]);
    expect(heldMessages('card-b').map((h) => h.text)).toEqual(['b']);
  });

  it('the last one gone deletes the key rather than storing []', () => {
    const a = msg();
    receiveSiblingMessage(a);
    removeHeldMessages('card-b', [a.deliveryId]);
    expect(inboxKey('card-b') in (sent.at(-1) ?? {})).toBe(false);
  });

  it('is a no-op for no card, no ids, or ids it does not hold', () => {
    receiveSiblingMessage(msg());
    const before = sent.length;
    removeHeldMessages(undefined, ['x']);
    removeHeldMessages('card-b', []);
    removeHeldMessages('card-b', ['nope']);
    expect(sent.length).toBe(before);
    expect(heldMessages('card-b')).toHaveLength(1);
  });
});

describe('pruning', () => {
  it('finds the inboxes of cards that are gone', () => {
    const blob = { [inboxKey('live')]: [], [inboxKey('dead')]: [], 'composerDraft.dead': 'x' };
    expect(staleInboxKeys(blob, new Set(['live']))).toEqual([inboxKey('dead')]);
  });

  it('an EMPTY known-set deletes nothing — "the card list failed" is not "you have no cards"', () => {
    expect(staleInboxKeys({ [inboxKey('a')]: [] }, new Set())).toEqual([]);
  });

  it('prunes the blob AND the cached snapshot', () => {
    receiveSiblingMessage(msg({ cardId: 'dead' }));
    receiveSiblingMessage(msg({ cardId: 'live' }));
    pruneInboxes(new Set(['live']));
    expect(heldMessages('dead')).toEqual([]);
    expect(heldMessages('live')).toHaveLength(1);
  });
});

describe('the in-flight send guard (#774)', () => {
  it('marks and releases, and the release is idempotent', () => {
    expect(isSendInFlight('card-b')).toBe(false);
    const done = beginSend('card-b');
    expect(isSendInFlight('card-b')).toBe(true);
    done();
    expect(isSendInFlight('card-b')).toBe(false);
    done();
    expect(isSendInFlight('card-b')).toBe(false);
  });

  it('is per card — one card sending does not block another', () => {
    beginSend('card-b');
    expect(isSendInFlight('card-c')).toBe(false);
  });

  it('an absent card id is never in flight, and its release is a no-op', () => {
    expect(isSendInFlight(undefined)).toBe(false);
    expect(() => beginSend(undefined)()).not.toThrow();
  });

  it('the boot prune clears a send for a card that is gone', () => {
    // `done()` rides the promise, not the component, so a card closed mid-send
    // releases normally. This is for the send that NEVER settles: without the
    // sweep the entry is permanent and the card's Send button is greyed for
    // the rest of the run with no way back.
    beginSend('card-b');
    beginSend('card-c');
    pruneInboxes(new Set(['card-c']));
    expect(isSendInFlight('card-b')).toBe(false);
    expect(isSendInFlight('card-c')).toBe(true);
  });

  it('a REFUSED knownCards read prunes nothing — the #650 rule', () => {
    beginSend('card-b');
    pruneInboxes(new Set());
    expect(isSendInFlight('card-b')).toBe(true);
  });
});

describe('withForwarded — what the user’s Enter actually sends', () => {
  const a: HeldMessage = { id: '1', from: { id: 'live-a', name: 'Alpha' }, text: 'first', at: 'T' };
  const b: HeldMessage = { id: '2', from: { id: 'live-c', name: 'Gamma' }, text: 'second', at: 'T' };

  it('each message in its attribution header, oldest first, then what the user typed', () => {
    // The marker ref is the start of the DELIVERY ID — which main minted and
    // never returned to the sender, so the sender cannot forge an end marker.
    expect(withForwarded([a, b], 'do the first one')).toBe(
      '[Message 1 from another switchboard session, "Alpha" (session id live-a). The user reviewed it and sent it on to you. ' +
        'It ends at the matching "End of message 1" line.]\n' +
        'first\n' +
        '[End of message 1 from "Alpha".]\n\n' +
        '[Message 2 from another switchboard session, "Gamma" (session id live-c). The user reviewed it and sent it on to you. ' +
        'It ends at the matching "End of message 2" line.]\n' +
        'second\n' +
        '[End of message 2 from "Gamma".]\n\n' +
        'do the first one'
    );
  });

  it('uses the delivery id for the ref — a real one gives eight hex characters', () => {
    const real: HeldMessage = { ...a, id: '3f2a9c1e-77aa-4b1d-9e0f-123456789abc' };
    expect(withForwarded([real], '')).toMatch(/^\[Message 3f2a9c1e from/);
    expect(withForwarded([real], '')).toMatch(/\[End of message 3f2a9c1e from "Alpha"\.\]$/);
  });

  it('says the USER sent it on — never "automatically"', () => {
    const out = withForwarded([a], '');
    expect(out).toMatch(/The user reviewed it/);
    expect(out).not.toMatch(/automatically/);
  });

  it('nothing typed adds nothing after the last message', () => {
    expect(withForwarded([a], '').endsWith('[End of message 1 from "Alpha".]')).toBe(true);
  });

  it('no messages is exactly what was typed', () => {
    expect(withForwarded([], 'just me')).toBe('just me');
  });
});

describe('settledMessages — what an Enter pressed NOW may send (#765 review)', () => {
  const a: HeldMessage = { id: 'a', from: { id: 'x', name: 'X' }, text: 'shown a while', at: 'T' };
  const b: HeldMessage = { id: 'b', from: { id: 'x', name: 'X' }, text: 'just shown', at: 'T' };

  it('sends only what the composer has been SHOWING for SIBLING_SETTLE_MS', () => {
    // The user's Enter for their OWN prompt, already on its way when a block
    // appears, did not review that block — and forwarding it would put "the
    // user reviewed it" on top of something nobody read.
    const now = 10_000;
    const seen = new Map([
      ['a', now - SIBLING_SETTLE_MS],
      ['b', now - 10],
    ]);
    expect(settledMessages([a, b], seen, now)).toEqual([a]);
  });

  it('a message the composer has NOT shown yet is never settled — however long it has waited (round 2)', () => {
    // The first version measured from ARRIVAL, so a message that landed while
    // the card sat on its Terminal tab — or was restored after a relaunch —
    // went out with the first Enter after the user came back, unseen.
    expect(settledMessages([a, b], new Map(), 10_000_000)).toEqual([]);
  });
});

it.each(['sibling-inbox.ts', '../components/SiblingMessages.tsx'])(
  '%s has NO WAY TO SEND — asserted against its source, not its comments',
  (file) => {
    // The safety property's renderer half: holding and showing is all these can
    // do. A future "auto-send if…" convenience would have to import one of these,
    // and that is the moment this test should make someone stop and read §5.4.
    const src = fs.readFileSync(path.join(__dirname, file), 'utf8');
    const code = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(code).not.toMatch(/submitPrompt|sendSessionCommand|writePromptToPty|pty\.input|\.submit\(|switchboard\./);
  }
);
