import { describe, expect, it } from 'vitest';
import { findMentions } from './mention-finder';
import { buildMentionPrompt, mentionLabel, type MentionAnswer } from './mention-prompt';

const NAMES = ['TradingApp', 'BrainHarbor', 'Beta'];
const answers = (entries: Array<[string, MentionAnswer]>) => new Map(entries);
const build = (text: string, a: Map<string, MentionAnswer>) => buildMentionPrompt(text, findMentions(text, NAMES), a);

const TRADING = '[[block: TradingApp output]]';
const BRAIN = '[[block: BrainHarbor output]]';

describe('buildMentionPrompt — what a draft with mentions sends', () => {
  it('puts the resolved session’s block AHEAD of the prose, and rewrites the mention out of @ shape', () => {
    const r = build('take @TradingApp’s fix and apply it here', answers([['TradingApp', { kind: 'resolved', block: TRADING }]]));
    expect(r).toEqual({ ok: true, prompt: `${TRADING}\n\ntake "TradingApp" (session)’s fix and apply it here` });
  });

  it('injects a session ONCE however often it is mentioned — and rewrites every mention', () => {
    const r = build('@TradingApp then @TradingApp again', answers([['TradingApp', { kind: 'resolved', block: TRADING }]]));
    expect(r).toEqual({
      ok: true,
      prompt: `${TRADING}\n\n${mentionLabel('TradingApp')} then ${mentionLabel('TradingApp')} again`,
    });
  });

  it('several sessions: blocks in first-mention order, every offset still right after the rewrites', () => {
    const r = build(
      'compare @BrainHarbor with @TradingApp and @BrainHarbor',
      answers([
        ['TradingApp', { kind: 'resolved', block: TRADING }],
        ['BrainHarbor', { kind: 'resolved', block: BRAIN }],
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
        ['TradingApp', { kind: 'resolved', block: TRADING }],
        ['BrainHarbor', { kind: 'missing' }],
      ])
    );
    expect(r).toEqual({ ok: true, prompt: `${TRADING}\n\n@Beta asks ${mentionLabel('TradingApp')} about @BrainHarbor` });
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
        ['BrainHarbor', { kind: 'resolved', block: BRAIN }],
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
