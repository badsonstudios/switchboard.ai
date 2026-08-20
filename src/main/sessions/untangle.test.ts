import { describe, expect, it } from 'vitest';
import { MAX_LINEAGE } from './lineage';
import { UntangleCard, untangleDuplicateConversations } from './untangle';

/** the smallest thing the policy reasons about */
const FOLDER = 'C:/Projects/thing';
const card = (
  id: string,
  title: string,
  head?: string,
  lineage?: string[],
  folder = FOLDER
): UntangleCard => ({
  id,
  identity: { title, folder },
  ...(head ? { nativeSessionId: head } : {}),
  ...(lineage ? { nativeSessionLineage: lineage } : {}),
});

describe('untangleDuplicateConversations — nothing to do', () => {
  it('returns the SAME array when no conversation is duplicated', () => {
    // identity, not equality: the store skips the write on this, which is what
    // makes running it on every launch free
    const cards = [card('a', 'A', 'x'), card('b', 'B', 'y', ['z'])];
    const out = untangleDuplicateConversations(cards);
    expect(out.cards).toBe(cards);
    expect(out.changes).toEqual([]);
  });

  it('leaves cards with no conversation alone', () => {
    const cards = [card('a', 'A'), card('b', 'B')];
    expect(untangleDuplicateConversations(cards).cards).toBe(cards);
  });

  it('does not see a card as its own duplicate when its head repeats in its chain', () => {
    // a hand-edited file can hold this; `resumeCandidates` de-duplicates, so one
    // card holding `x` twice is still one holder
    const cards = [card('a', 'A', 'x', ['x'])];
    expect(untangleDuplicateConversations(cards).changes).toEqual([]);
  });
});

describe('untangleDuplicateConversations — rule 1: a head beats an ancestor', () => {
  it('gives the conversation to the card still IN it', () => {
    // `b` holds x as its head; `a` only remembers having been there
    const out = untangleDuplicateConversations([
      card('a', 'A', 'own', ['x']),
      card('b', 'B', 'x'),
    ]);
    expect(out.cards[0]).toMatchObject({
      nativeSessionId: 'own',
      cededNativeIds: ['x'],
    });
    expect(out.cards[0].nativeSessionLineage).toBeUndefined();
    expect(out.cards[1]).toEqual(card('b', 'B', 'x'));
    expect(out.changes).toEqual([
      {
        cardId: 'a',
        cardTitle: 'A',
        nativeSessionId: 'x',
        keptByCardId: 'b',
        keptByTitle: 'B',
      },
    ]);
  });

  it('beats workspace order — the elder card gives it up when it is only an ancestor', () => {
    const out = untangleDuplicateConversations([
      card('a', 'A', 'p', ['x']),
      card('b', 'B', 'x'),
    ]);
    expect(out.cards[1].cededNativeIds).toBeUndefined();
    expect(out.changes.map((c) => c.cardId)).toEqual(['a']);
  });

  it('untangles a criss-cross without either card losing its head', () => {
    // A is in x and remembers y; B is in y and remembers x
    const out = untangleDuplicateConversations([
      card('a', 'A', 'x', ['y']),
      card('b', 'B', 'y', ['x']),
    ]);
    expect(out.cards[0]).toMatchObject({
      nativeSessionId: 'x',
      cededNativeIds: ['y'],
    });
    expect(out.cards[1]).toMatchObject({
      nativeSessionId: 'y',
      cededNativeIds: ['x'],
    });
    expect(out.cards[0].nativeSessionLineage).toBeUndefined();
    expect(out.cards[1].nativeSessionLineage).toBeUndefined();
  });
});

describe('untangleDuplicateConversations — rule 2: the elder card keeps it', () => {
  it('is THE owner-reported pair: two heads, one conversation', () => {
    // `Switchboard.ai` and `Switchboard.ai-2` both held one id (#484's
    // discovery 1). The `-2` suffix is minted for the LATER card, so workspace
    // order says which is the copy.
    const out = untangleDuplicateConversations([
      card('one', 'Switchboard.ai', '25e95c0b'),
      card('two', 'Switchboard.ai-2', '25e95c0b'),
    ]);
    expect(out.cards[0]).toEqual(card('one', 'Switchboard.ai', '25e95c0b'));
    expect(out.cards[1]).toMatchObject({ cededNativeIds: ['25e95c0b'] });
    // NOTHING IS DESTROYED: the loser keeps the pointer, out of the resume walk
    expect(out.cards[1].nativeSessionId).toBeUndefined();
    expect(out.cards[1].nativeSessionLineage).toBeUndefined();
    expect(out.changes).toEqual([
      {
        cardId: 'two',
        cardTitle: 'Switchboard.ai-2',
        nativeSessionId: '25e95c0b',
        keptByCardId: 'one',
        keptByTitle: 'Switchboard.ai',
      },
    ]);
  });

  it('applies when both hold it only as an ancestor', () => {
    const out = untangleDuplicateConversations([
      card('a', 'A', 'p', ['x']),
      card('b', 'B', 'q', ['x']),
    ]);
    expect(out.changes.map((c) => c.cardId)).toEqual(['b']);
    expect(out.cards[0].nativeSessionLineage).toEqual(['x']);
    expect(out.cards[1].nativeSessionLineage).toBeUndefined();
    expect(out.cards[1].cededNativeIds).toEqual(['x']);
  });

  it('leaves ONE owner when three cards collide, and tells the other two who has it', () => {
    const out = untangleDuplicateConversations([
      card('a', 'A', 'x'),
      card('b', 'B', 'x'),
      card('c', 'C', 'x'),
    ]);
    expect(out.cards[0].nativeSessionId).toBe('x');
    expect(out.cards[1].nativeSessionId).toBeUndefined();
    expect(out.cards[2].nativeSessionId).toBeUndefined();
    expect(out.changes.map((c) => [c.cardId, c.keptByCardId])).toEqual([
      ['b', 'a'],
      ['c', 'a'],
    ]);
  });
});

describe('untangleDuplicateConversations — what the loser is left holding', () => {
  it('PROMOTES an ancestor rather than stranding the card under an empty head', () => {
    const out = untangleDuplicateConversations([
      card('a', 'A', 'x'),
      card('b', 'B', 'x', ['mine', 'older']),
    ]);
    expect(out.cards[1]).toMatchObject({
      nativeSessionId: 'mine',
      nativeSessionLineage: ['older'],
      cededNativeIds: ['x'],
    });
  });

  it('keeps what it had already ceded, newest cession first, without repeats', () => {
    const before: UntangleCard = {
      ...card('b', 'B', 'x'),
      cededNativeIds: ['old', 'x'],
    };
    const out = untangleDuplicateConversations([card('a', 'A', 'x'), before]);
    expect(out.cards[1].cededNativeIds).toEqual(['x', 'old']);
  });

  it('drops a ceded id the card is actively holding again', () => {
    // possible only when the keeper card was closed and the sweep handed the
    // conversation back — then it is live, and "given away" is no longer true
    const b: UntangleCard = {
      ...card('b', 'B', 'y', ['x']),
      cededNativeIds: ['y', 'old'],
    };
    const out = untangleDuplicateConversations([card('a', 'A', 'x'), b]);
    // it gives up x (a holds it as a head too, and a is elder), keeps y — and
    // the stale "I gave y away" goes with it
    expect(out.cards[1]).toMatchObject({
      nativeSessionId: 'y',
      cededNativeIds: ['x', 'old'],
    });
  });

  it('reports a card that gave up two conversations as two lines, together', () => {
    const out = untangleDuplicateConversations([
      card('a', 'A', 'x'),
      card('b', 'B', 'y'),
      card('c', 'C', 'x', ['y']),
    ]);
    expect(out.changes.map((c) => [c.cardId, c.nativeSessionId])).toEqual([
      ['c', 'x'],
      ['c', 'y'],
    ]);
    expect(out.cards[2].cededNativeIds).toEqual(['x', 'y']);
  });
});

  it('lists what it just gave up in the order it HELD them', () => {
    // the manual tells the user to find the id and move it back; a former HEAD
    // sitting after a former ancestor would read like a Map, not like the card
    const out = untangleDuplicateConversations([
      card('k1', 'K1', 'was-my-head'),
      card('k2', 'K2', 'was-my-ancestor'),
      card('loser', 'L', 'was-my-head', ['was-my-ancestor']),
    ]);
    expect(out.cards[2].cededNativeIds).toEqual(['was-my-head', 'was-my-ancestor']);
    expect(out.cards[2].nativeSessionId).toBeUndefined();
  });

  it('cleans a stale ceded entry off a card that is not ceding anything', () => {
    // a hand-edited file can say a card both holds and gave away one id; "one
    // conversation, two contradictory facts" is a state nothing downstream is
    // written to survive
    const cards: UntangleCard[] = [
      { ...card('a', 'A', 'x'), cededNativeIds: ['x', 'gone'] },
      card('b', 'B', 'y'),
    ];
    const out = untangleDuplicateConversations(cards);
    expect(out.cards[0].cededNativeIds).toEqual(['gone']);
    expect(out.cards[0].nativeSessionId).toBe('x');
    expect(out.changes).toEqual([]); // a cleanup is not a cession
    expect(out.cards[1]).toBe(cards[1]); // and the untouched card is untouched
  });

  it('caps the ceded list, and the keeper is holding what falls off', () => {
    // the ONE place this change can drop a pointer. Bounded on purpose: this is
    // persisted state re-serialized on every save.
    const many = Array.from({ length: MAX_LINEAGE + 4 }, (_, i) => `conv-${i}`);
    const keepers = many.map((id, i) => card(`k${i}`, `K${i}`, id));
    const loser = card('loser', 'L', many[0], many.slice(1));
    const out = untangleDuplicateConversations([...keepers, loser]);
    const ceded = out.cards[out.cards.length - 1].cededNativeIds!;
    expect(ceded).toHaveLength(MAX_LINEAGE);
    // nothing that fell off is unreachable — every keeper still holds its own
    const heldSomewhere = new Set(out.cards.flatMap((c) => (c.nativeSessionId ? [c.nativeSessionId] : [])));
    for (const id of many) expect(heldSomewhere.has(id)).toBe(true);
  });

describe('untangleDuplicateConversations - idempotence', () => {
  it('finds nothing to do on a second pass', () => {
    const once = untangleDuplicateConversations([
      card('a', 'A', 'x'),
      card('b', 'B', 'x', ['y']),
      card('c', 'C', 'y'),
    ]);
    expect(once.changes.length).toBeGreaterThan(0);
    const twice = untangleDuplicateConversations(once.cards);
    expect(twice.cards).toBe(once.cards);
    expect(twice.changes).toEqual([]);
  });

  it('never leaves an id in two cards resume chains', () => {
    const out = untangleDuplicateConversations([
      card('a', 'A', 'x', ['y', 'z']),
      card('b', 'B', 'y', ['x']),
      card('c', 'C', 'z', ['x', 'y']),
    ]);
    const seen = new Set<string>();
    for (const c of out.cards) {
      for (const id of [c.nativeSessionId, ...(c.nativeSessionLineage ?? [])]) {
        if (!id) continue;
        expect(seen.has(id)).toBe(false);
        seen.add(id);
      }
    }
  });

  it('never drops a conversation off the workspace entirely', () => {
    const cards = [card('a', 'A', 'x', ['y']), card('b', 'B', 'x', ['y'])];
    const out = untangleDuplicateConversations(cards);
    const kept = new Set(
      out.cards.flatMap((c) => [
        ...(c.nativeSessionId ? [c.nativeSessionId] : []),
        ...(c.nativeSessionLineage ?? []),
        ...(c.cededNativeIds ?? []),
      ])
    );
    expect(kept).toEqual(new Set(['x', 'y']));
  });

  it('leaves every other field on the card untouched', () => {
    const rich = { ...card('b', 'B', 'x'), extra: 42, taskLabel: 'mine' };
    const out = untangleDuplicateConversations([card('a', 'A', 'x'), rich]);
    expect(out.cards[1]).toMatchObject({
      extra: 42,
      taskLabel: 'mine',
      identity: { title: 'B', folder: FOLDER },
    });
    expect(out.cards[1].cededNativeIds).toEqual(['x']); // it really did cede
  });
});

describe('untangleDuplicateConversations - one id, two FOLDERS is not a duplicate', () => {
  it('leaves both cards alone', () => {
    // a conversation is `<root>/<slug of the folder>/<id>.jsonl`, and every
    // lookup on this path is folder-scoped — so the same id under two folders
    // names two files and the cards are not in each other's way
    const cards = [
      card('a', 'A', 'shared', undefined, 'C:/Projects/one'),
      card('b', 'B', 'shared', undefined, 'C:/Projects/two'),
    ];
    const out = untangleDuplicateConversations(cards);
    expect(out.cards).toBe(cards);
    expect(out.changes).toEqual([]);
  });

  it('still unties the SAME folder written two ways', () => {
    // `slugForCwd` is what decides, so a lowercase drive letter cannot make one
    // folder look like two
    const out = untangleDuplicateConversations([
      card('a', 'A', 'shared', undefined, 'C:/Projects/one'),
      card('b', 'B', 'shared', undefined, 'c:/Projects/one'),
    ]);
    expect(out.changes.map((c) => c.cardId)).toEqual(['b']);
  });
});
