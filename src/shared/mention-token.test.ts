import { describe, expect, it } from 'vitest';
import {
  caretAfterMention,
  filterSummaries,
  insertMention,
  isCompleteMention,
  mentionEnterAction,
  mentionToken,
} from './mention-token';
import type { SessionSummary } from './sessions';

const session = (id: string, name: string, over: Partial<SessionSummary> = {}): SessionSummary => ({
  id,
  name,
  folder: `/p/${name.toLowerCase()}`,
  providerId: 'claude-code',
  status: 'idle',
  exited: false,
  ...over,
});

/** caret at the end of the draft: the common case while typing */
const atEnd = (draft: string) => mentionToken(draft, draft.length);

describe('mentionToken (popup trigger rule)', () => {
  it('empty query right after an @ at the start of the draft', () => {
    expect(atEnd('@')).toEqual({ at: 0, query: '' });
  });

  it('partial name at the start of the draft', () => {
    expect(atEnd('@Tra')).toEqual({ at: 0, query: 'Tra' });
  });

  it('mid-sentence, after a space — the case a slash command can never be', () => {
    expect(atEnd('take @Tra')).toEqual({ at: 5, query: 'Tra' });
  });

  it('after a newline', () => {
    expect(atEnd('first line\n@Tra')).toEqual({ at: 11, query: 'Tra' });
  });

  it('after EVERY opening bracket or quote', () => {
    for (const open of ['(', '[', '{', '"', "'", '`']) {
      expect(atEnd(`x ${open}@Tra`), `after ${open}`).toEqual({ at: 3, query: 'Tra' });
    }
  });

  it('the caret at the end of the word, with the word followed by a name-ending character', () => {
    // `take @Tra and fix it` with the caret right after "Tra": the next char is a space.
    expect(mentionToken('take @Tra and fix it', 9)).toEqual({ at: 5, query: 'Tra' });
    expect(mentionToken('take @Tra, then', 9)).toEqual({ at: 5, query: 'Tra' });
  });

  it('the NEAREST @ before the caret wins', () => {
    expect(atEnd('@One and @Tw')).toEqual({ at: 9, query: 'Tw' });
  });
});

describe('mentionToken — NO popup', () => {
  // A composer that opens a popup on — or mangles — an `@` in prose is #635's
  // lesson repeated on a new surface. Every row here is text a user types
  // without meaning a session, or a caret position where completing would
  // damage what is already there.
  const none: Array<[string, string, number?]> = [
    ['an email address', 'mail dan@example.com'],
    ['an @ mid-word', 'foo@bar'],
    ['a decorator after a letter', 'class x@Component'],
    ['the caret has left the word (space)', 'take @TradingApp '],
    ['no @ at all', 'plain prose'],
    ['an empty draft', ''],
    ['caret at position 0', '@Tra', 0],
    ['caret moved back before the @', 'take @Tra', 4],
    ['a second @ glued to the first', '@a@b'],
    // Review, #797: the caret INSIDE an existing mention. Completing "Tr" here
    // would leave `@Trackpad adingApp please`.
    ['the caret inside a mention already typed', 'hey @TradingApp please', 7],
    ['the caret inside a mention at the end of the draft', '@TradingApp', 3],
  ];
  for (const [what, draft, caret] of none) {
    it(what, () => {
      expect(mentionToken(draft, caret ?? draft.length)).toBeNull();
    });
  }

  it('the caret has left the word via EVERY name-ending character', () => {
    for (const end of [')', ']', '}', '"', "'", '`', ',', ';', ':', '!', '?', ' ', '\n', '\t']) {
      expect(atEnd(`ask @TradingApp${end}`), `after ${JSON.stringify(end)}`).toBeNull();
    }
  });

  it('`@media` at a word start DOES tokenize — the empty match list is what closes the popup', () => {
    // Recorded so nobody "fixes" the tokenizer into guessing at CSS: it cannot
    // know `media` is not a session name. The done-when's rule is "no match →
    // no popup", and that rule lives in the list filter, not here.
    expect(atEnd('@media')).toEqual({ at: 0, query: 'media' });
  });

  it('an out-of-range caret is not a token', () => {
    expect(mentionToken('@Tra', 99)).toBeNull();
  });
});

describe('insertMention', () => {
  it('replaces only the @partial, keeping the text before it', () => {
    const draft = 'take @Tra';
    const token = mentionToken(draft, draft.length)!;
    expect(insertMention(draft, token, draft.length, 'TradingApp')).toBe('take @TradingApp ');
  });

  it('keeps the text after the caret, and does not double an existing space', () => {
    const draft = 'take @Tra and fix it';
    const token = mentionToken(draft, 9)!;
    expect(insertMention(draft, token, 9, 'TradingApp')).toBe('take @TradingApp and fix it');
  });

  it('does not add a space before a NEWLINE that already separates it', () => {
    const draft = 'take @Tra\nsecond line';
    const token = mentionToken(draft, 9)!;
    expect(insertMention(draft, token, 9, 'TradingApp')).toBe('take @TradingApp\nsecond line');
  });

  it('adds a space when the text after the caret starts with punctuation', () => {
    const draft = 'take @Tra.';
    // `.` is not a name-ending character, so the caret is "inside" — use a comma,
    // which is, to reach the insert with punctuation after the caret.
    const withComma = 'take @Tra,';
    const token = mentionToken(withComma, 9)!;
    expect(insertMention(withComma, token, 9, 'TradingApp')).toBe('take @TradingApp ,');
    expect(mentionToken(draft, 9)).toBeNull();
  });

  it('works for a bare @ with nothing typed yet', () => {
    const token = mentionToken('@', 1)!;
    expect(insertMention('@', token, 1, 'TradingApp')).toBe('@TradingApp ');
  });

  it('caretAfterMention lands just past "@name "', () => {
    const draft = 'take @Tra';
    const token = mentionToken(draft, draft.length)!;
    const next = insertMention(draft, token, draft.length, 'TradingApp');
    expect(next.slice(0, caretAfterMention(token, 'TradingApp'))).toBe('take @TradingApp ');
  });
});

describe('filterSummaries (which sessions the @ popup offers)', () => {
  const list = [
    session('s-own', 'Switchboard'),
    session('s-trade', 'TradingApp'),
    session('s-brain', 'BrainHarbor'),
    session('s-gone', 'Trackpad', { exited: true, status: 'done' }),
  ];

  it('never offers the composer’s own session', () => {
    expect(filterSummaries(list, '', 's-own').map((s) => s.id)).not.toContain('s-own');
  });

  it('empty query → every other session, alphabetical', () => {
    expect(filterSummaries(list, '', 's-own').map((s) => s.name)).toEqual(['BrainHarbor', 'Trackpad', 'TradingApp']);
  });

  it('prefix matches rank before substring matches, then alphabetical', () => {
    // "ra": all three contain it, none start with it → alphabetical.
    expect(filterSummaries(list, 'ra', 's-own').map((s) => s.name)).toEqual(['BrainHarbor', 'Trackpad', 'TradingApp']);
    // "tr": Trackpad and TradingApp START with it; nothing else contains it.
    expect(filterSummaries(list, 'tr', 's-own').map((s) => s.name)).toEqual(['Trackpad', 'TradingApp']);
    // The DISCRIMINATING case: "b" is a prefix of Beta and only a substring of
    // Abba. Prefix-first puts Beta first; plain alphabetical would put Abba
    // first. The two rows above cannot tell those rules apart — this one can.
    expect(filterSummaries([session('x', 'Abba'), session('y', 'Beta')], 'b', 'none').map((s) => s.name)).toEqual([
      'Beta',
      'Abba',
    ]);
  });

  it('matches case-insensitively', () => {
    expect(filterSummaries(list, 'TRADING', 's-own').map((s) => s.name)).toEqual(['TradingApp']);
  });

  it('keeps an EXITED session — shown and marked, not excluded (#765: its transcript is still readable)', () => {
    expect(filterSummaries(list, 'track', 's-own').map((s) => [s.name, s.exited])).toEqual([['Trackpad', true]]);
  });

  it('no match → an empty list, which is what closes the popup', () => {
    expect(filterSummaries(list, 'media', 's-own')).toEqual([]);
  });

  it('does not mutate the list it was handed', () => {
    const before = list.map((s) => s.id);
    filterSummaries(list, '', 's-own');
    expect(list.map((s) => s.id)).toEqual(before);
  });
});

describe('isCompleteMention', () => {
  it('a name typed in full is complete', () => {
    expect(isCompleteMention('TradingApp', 'TradingApp')).toBe(true);
  });

  it('case-insensitive in BOTH directions, exactly like isCompleteCommand', () => {
    expect(isCompleteMention('tradingapp', 'TradingApp')).toBe(true);
    expect(isCompleteMention('TRADINGAPP', 'TradingApp')).toBe(true);
  });

  it('a prefix is not complete', () => {
    expect(isCompleteMention('Trad', 'TradingApp')).toBe(false);
    expect(isCompleteMention('', 'TradingApp')).toBe(false);
  });
});

describe('mentionEnterAction (what Enter does on a mention row)', () => {
  const table: Array<[string, string, string, boolean, 'send' | 'complete']> = [
    ['typed in full → send (#163)', 'TradingApp', 'TradingApp', false, 'send'],
    ['typed in full, any case → send', 'TRADINGAPP', 'TradingApp', false, 'send'],
    ['typed in full even after navigating → send', 'TradingApp', 'TradingApp', true, 'send'],
    ['a PREFIX → complete', 'Tra', 'TradingApp', false, 'complete'],
    ['a prefix in another case → complete', 'tRA', 'TradingApp', false, 'complete'],
    ['nothing typed yet → complete the first row', '', 'TradingApp', false, 'complete'],
    // Review, #797: a literal `@app` must not become `@TradingApp` by accident.
    ['only a SUBSTRING, not navigated → send the literal', 'app', 'TradingApp', false, 'send'],
    ['only a substring, but the user MOVED to it → complete', 'app', 'TradingApp', true, 'complete'],
  ];
  for (const [what, query, name, navigated, expected] of table) {
    it(what, () => {
      expect(mentionEnterAction(query, name, navigated)).toBe(expected);
    });
  }
});
