import { describe, expect, it } from 'vitest';
import { findMentions } from './mention-finder';
import {
  buildMentionPrompt,
  leftOutNote,
  mentionLabel,
  TOTAL_CONTEXT_CHAR_CAP,
  type MentionAnswer,
} from './mention-prompt';

const NAMES = ['TradingApp', 'BrainHarbor', 'Beta'];
const answers = (entries: Array<[string, MentionAnswer]>) => new Map(entries);
const build = (text: string, a: Map<string, MentionAnswer>, names: readonly string[] = NAMES) =>
  buildMentionPrompt(text, findMentions(text, names), a);

const TRADING = '[[block: TradingApp output]]';
const BRAIN = '[[block: BrainHarbor output]]';
/** a resolved answer for a session of its own */
const resolved = (block: string, key = block): MentionAnswer => ({ kind: 'resolved', block, key });

describe('buildMentionPrompt — what a draft with mentions sends', () => {
  it('puts the resolved session’s block AHEAD of the prose, and rewrites the mention out of @ shape', () => {
    const r = build('take @TradingApp’s fix and apply it here', answers([['TradingApp', resolved(TRADING)]]));
    expect(r).toEqual({ ok: true, prompt: `${TRADING}\n\ntake "TradingApp" (session)’s fix and apply it here` });
  });

  it('injects a session ONCE however often it is mentioned — and rewrites every mention', () => {
    const r = build('@TradingApp then @TradingApp again', answers([['TradingApp', resolved(TRADING)]]));
    expect(r).toEqual({
      ok: true,
      prompt: `${TRADING}\n\n${mentionLabel('TradingApp')} then ${mentionLabel('TradingApp')} again`,
    });
  });

  it('several sessions: blocks in first-mention order, every offset still right after the rewrites', () => {
    const r = build(
      'compare @BrainHarbor with @TradingApp and @BrainHarbor',
      answers([
        ['TradingApp', resolved(TRADING)],
        ['BrainHarbor', resolved(BRAIN)],
      ])
    );
    expect(r).toEqual({
      ok: true,
      prompt:
        `${BRAIN}\n\n${TRADING}\n\n` +
        `compare ${mentionLabel('BrainHarbor')} with ${mentionLabel('TradingApp')} and ${mentionLabel('BrainHarbor')}`,
    });
  });

  it('leaves a MISSING or OWN-session mention byte-for-byte while rewriting a resolved one beside it', () => {
    const r = build(
      '@Beta asks @TradingApp about @BrainHarbor',
      answers([
        ['Beta', { kind: 'own' }],
        ['TradingApp', resolved(TRADING)],
        ['BrainHarbor', { kind: 'missing' }],
      ])
    );
    expect(r).toEqual({ ok: true, prompt: `${TRADING}\n\n@Beta asks ${mentionLabel('TradingApp')} about @BrainHarbor` });
  });
});

// The review blocker, from the builder's side: answers are keyed on what the
// user TYPED, and "the same session twice" is decided on the resolved id.
describe('buildMentionPrompt — two spellings of one session', () => {
  const CASED = ['api', 'API'];

  it('injects it ONCE and rewrites each mention as the user spelled it', () => {
    const r = build(
      'ask @api and @API',
      answers([
        ['api', resolved(TRADING, 'live-1')],
        ['API', resolved(TRADING, 'live-1')],
      ]),
      CASED
    );
    expect(r).toEqual({
      ok: true,
      prompt: `${TRADING}\n\nask ${mentionLabel('api')} and ${mentionLabel('API')}`,
    });
  });

  it('two DIFFERENT sessions whose blocks happen to match are still two blocks', () => {
    // Keyed on the id, not on the text of the block — two idle sessions render
    // identical "has not produced any readable output yet" answers all the time.
    const r = build(
      'ask @api and @API',
      answers([
        ['api', resolved(TRADING, 'live-1')],
        ['API', resolved(TRADING, 'live-2')],
      ]),
      CASED
    );
    expect(r.ok && r.prompt.startsWith(`${TRADING}\n\n${TRADING}\n\n`)).toBe(true);
  });
});

describe('buildMentionPrompt — the total size cap', () => {
  const big = (tag: string, n: number): string => `[[${tag}]]` + 'x'.repeat(n);

  it('drops whole blocks that do not fit, names the sessions, and still rewrites their mentions', () => {
    const first = big('first', TOTAL_CONTEXT_CHAR_CAP - 100);
    const second = big('second', 500);
    const r = build(
      'compare @TradingApp with @BrainHarbor',
      answers([
        ['TradingApp', resolved(first, 'live-1')],
        ['BrainHarbor', resolved(second, 'live-2')],
      ])
    );
    if (!r.ok) throw new Error(r.refusals.join('; '));
    expect(r.prompt).toContain(first);
    expect(r.prompt).not.toContain(second);
    // Said in-band, naming what was left out — never silently truncated.
    expect(r.prompt).toContain(leftOutNote(['BrainHarbor']));
    // …and BOTH mentions are still out of `@` shape: the CLI would treat a
    // leftover `@BrainHarbor` as a file whether or not we had room for its
    // output.
    expect(r.prompt).toContain(`compare ${mentionLabel('TradingApp')} with ${mentionLabel('BrainHarbor')}`);
    expect(r.prompt).not.toContain('@BrainHarbor');
  });

  it('a block that fits exactly is kept — the boundary is not off by one', () => {
    const exact = 'y'.repeat(TOTAL_CONTEXT_CHAR_CAP);
    const r = build('ask @TradingApp', answers([['TradingApp', resolved(exact, 'live-1')]]));
    expect(r.ok && r.prompt.startsWith(exact)).toBe(true);
    expect(r.ok && r.prompt.includes('was left out')).toBe(false);
  });

  it('every block dropped still sends the prose, with the note and no context', () => {
    const huge = 'z'.repeat(TOTAL_CONTEXT_CHAR_CAP + 1);
    const r = build('ask @TradingApp', answers([['TradingApp', resolved(huge, 'live-1')]]));
    expect(r).toEqual({
      ok: true,
      prompt: `${leftOutNote(['TradingApp'])}\n\nask ${mentionLabel('TradingApp')}`,
    });
  });
});

describe('buildMentionPrompt — the draft comes back EXACTLY as typed', () => {
  // The done-when's negative table: an @ that resolves to nothing reaches the
  // model as the literal characters the user typed.
  const same: Array<[string, string, Array<[string, MentionAnswer]>]> = [
    ['no mentions at all', 'plain prose', []],
    ['a mention of no session', 'ping @TradingApp please', [['TradingApp', { kind: 'missing' }]]],
    ['a mention of the own session', 'note to @Beta', [['Beta', { kind: 'own' }]]],
    ['a mention with no answer at all (fail open to literal)', '@TradingApp', []],
    // Keyed on the typed spelling: an answer filed under the LIST's spelling is
    // not an answer to what the user wrote, and must not be applied to it.
    ['an answer under a different spelling', 'ping @TradingApp', [['tradingapp', { kind: 'own' }]]],
  ];
  for (const [what, text, a] of same) {
    it(what, () => {
      expect(build(text, answers(a))).toEqual({ ok: true, prompt: text });
    });
  }
});

describe('buildMentionPrompt — an ambiguous name refuses the WHOLE send', () => {
  it('returns the reason and no prompt, even when another mention resolved', () => {
    const reason = '"TradingApp" is ambiguous — 2 sessions share that name: … Use the session id.';
    const r = build(
      '@TradingApp and @BrainHarbor',
      answers([
        ['TradingApp', { kind: 'ambiguous', reason }],
        ['BrainHarbor', resolved(BRAIN)],
      ])
    );
    expect(r).toEqual({ ok: false, refusals: [reason] });
  });

  it('reports each distinct reason once, however often the name is mentioned', () => {
    const reason = 'ambiguous TradingApp';
    const r = build('@TradingApp, @TradingApp', answers([['TradingApp', { kind: 'ambiguous', reason }]]));
    expect(r).toEqual({ ok: false, refusals: [reason] });
  });
});
