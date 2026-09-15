import { describe, expect, it } from 'vitest';
import { findMentions, mayMention } from './mention-finder';

const NAMES = ['TradingApp', 'Trading', 'My Project', "Dan's App", 'App', 'AppX'];
const names = (text: string, list: readonly string[] = NAMES) => findMentions(text, list).map((m) => m.name);

describe('mayMention — the composer’s cheap “is there anything to look up?”', () => {
  it('is a SUPERSET of findMentions: every text with a mention says yes', () => {
    // If this ever said no where the finder says yes, that draft would skip the
    // lookup and send `@TradingApp` bare — the context silently missing.
    const texts = [
      '@TradingApp now',
      'take @TradingApp and fix it',
      "take @TradingApp's last output",
      'see (@TradingApp)',
      'see "@My Project"',
      'x\n@App',
      '```\n@App\n```\nnow ask @TradingApp',
    ];
    for (const text of texts) {
      expect(findMentions(text, NAMES).length, text).toBeGreaterThan(0);
      expect(mayMention(text), text).toBe(true);
    }
  });

  it('says no where there is no @ at a word boundary with something after it', () => {
    for (const text of ['', 'plain prose', 'mail dan@TradingApp.com', 'look at @', 'x@y']) {
      expect(mayMention(text), text).toBe(false);
    }
  });
});

describe('findMentions — where a known session is mentioned', () => {
  it('at the start, mid-sentence, and after brackets and quotes', () => {
    expect(names('@TradingApp now')).toEqual(['TradingApp']);
    expect(names('take @TradingApp and fix it')).toEqual(['TradingApp']);
    for (const open of ['(', '[', '{', '"', "'", '`x `']) {
      expect(names(`see ${open}@TradingApp`), `after ${open}`).toEqual(['TradingApp']);
    }
  });

  it('returns the offsets of the @ and just past the name', () => {
    expect(findMentions('take @TradingApp and', NAMES)).toEqual([
      { start: 5, end: 16, name: 'TradingApp', typed: 'TradingApp' },
    ]);
  });

  // The review blocker: `name` is the list's spelling, `typed` is the user's,
  // and only the second one may be resolved — two sessions can differ by case.
  it('carries the spelling the USER typed beside the one the list uses', () => {
    expect(findMentions('ask @tradingapp now', NAMES)).toEqual([
      { start: 4, end: 15, name: 'TradingApp', typed: 'tradingapp' },
    ]);
  });

  it('a title with surrounding space matches the trimmed name, and takes only what was typed', () => {
    // Titles are user-editable, so `"Trading "` and `"Trading"` can both exist.
    // Untrimmed, the longer candidate wins and swallows the user's space.
    expect(findMentions('ask @Trading , ok', ['Trading ', 'Trading'])).toEqual([
      { start: 4, end: 12, name: 'Trading', typed: 'Trading' },
    ]);
  });

  it('the LONGEST name that fits wins — a shorter name that is its prefix does not', () => {
    expect(names('@TradingApp please')).toEqual(['TradingApp']);
    expect(names('@Trading please')).toEqual(['Trading']);
  });

  it('matches a name containing a SPACE — what the popup trigger cannot', () => {
    expect(names('see @My Project today')).toEqual(['My Project']);
  });

  it("lets 's end a name — the design's own example", () => {
    expect(names("take @TradingApp's last output")).toEqual(['TradingApp']);
  });

  it('lets a TYPOGRAPHIC apostrophe end a name too — smart quotes and pasted text produce it', () => {
    const typographic = String.fromCodePoint(0x2019);
    expect(names(`take @TradingApp${typographic}s last output`)).toEqual(['TradingApp']);
  });

  it('matches a name that itself contains an apostrophe', () => {
    expect(names("ask @Dan's App about it")).toEqual(["Dan's App"]);
  });

  it('is case-insensitive, and returns the name as the session list spells it', () => {
    expect(names('@tradingapp now')).toEqual(['TradingApp']);
  });

  it('ends a name at closing punctuation', () => {
    for (const end of [')', ']', '}', '"', ',', ';', ':', '!', '?', '.']) {
      expect(names(`(ask @TradingApp${end}`), `before ${JSON.stringify(end)}`).toEqual(['TradingApp']);
    }
  });

  it('every mention, in order, including the same session twice', () => {
    expect(names('@App and @TradingApp, then @App again')).toEqual(['App', 'TradingApp', 'App']);
  });

  it('a name followed by a word boundary, not a longer name that is not in the list', () => {
    expect(names('@App, then')).toEqual(['App']);
    expect(names('@AppX then')).toEqual(['AppX']);
  });
});

describe('findMentions — left as literal text', () => {
  const none: Array<[string, string]> = [
    ['a name that is not a session', '@Nobody please'],
    ['an email address', 'mail dan@TradingApp.com'],
    ['an @ glued to a word', 'x@TradingApp'],
    ['a known name followed by more word characters', '@TradingAppX please'],
    ['a name followed by a hyphen', '@TradingApp-v2'],
    ['an @ at the end', 'look at @'],
    ['inside an inline code span', 'run `@TradingApp` literally'],
    ['inside a fenced code block', '```\n@TradingApp\n```'],
    ['inside an unterminated fence', 'here:\n```\n@TradingApp and on'],
    ['no text at all', ''],
  ];
  for (const [what, text] of none) {
    it(what, () => {
      expect(findMentions(text, NAMES)).toEqual([]);
    });
  }

  it('a mention AFTER a closed fence still counts', () => {
    expect(names('```\n@App\n```\nnow ask @TradingApp')).toEqual(['TradingApp']);
  });

  it('no names known → nothing, whatever the text', () => {
    expect(findMentions('@TradingApp', [])).toEqual([]);
    expect(findMentions('@TradingApp', ['  '])).toEqual([]);
  });
});
