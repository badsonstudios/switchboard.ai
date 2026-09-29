import { describe, expect, it } from 'vitest';
import { AT_ESCAPE_NOTE, atEscapeNote, neutraliseAtMentions } from './at-mentions';

/**
 * The CLI's own bare-mention extractor, copied verbatim from the 2.1.272 binary
 * and re-confirmed against 2.1.280 by `spike/probes/832/probe-fenced-at.mjs`.
 *
 * THE TESTS BELOW ASSERT AGAINST THIS, not against our escape's shape. What we
 * owe #832 is "the CLI finds nothing", and a test pinning "a backslash appears
 * in front of the at-sign" would keep passing on the day the escape stopped
 * working — which is the only day the assertion matters.
 */
const CLI_EXTRACTOR = /(^|[\s。、？！])@([^\s]+)\b/g;
const mentions = (s: string): string[] =>
  [...s.matchAll(CLI_EXTRACTOR)].map((m) => m[2] ?? '');

describe('neutraliseAtMentions — #832, another session cannot attach our files', () => {
  it('leaves text with no mention byte-for-byte alone, and says so with a count of 0', () => {
    const r = neutraliseAtMentions('the build passed and nothing was odd');
    expect(r).toEqual({ text: 'the build passed and nothing was odd', count: 0 });
  });

  it('defuses the shapes a transcript really carries — npm scopes, decorators, emails', () => {
    const hostile = 'I bumped @types/node, added @Injectable, and mailed x @example.com';
    expect(mentions(hostile)).toEqual(['types/node', 'Injectable', 'example.com']);
    const r = neutraliseAtMentions(hostile);
    expect(r.count).toBe(3);
    expect(mentions(r.text)).toEqual([]);
  });

  it('defuses a mention at the very start of the text (the `^` arm of the boundary)', () => {
    expect(mentions('@NOTES.md is the file')).toEqual(['NOTES.md']);
    expect(mentions(neutraliseAtMentions('@NOTES.md is the file').text)).toEqual([]);
  });

  it('defuses a mention that opens a line, which is where an injected block puts them', () => {
    const block = 'Recent output:\n@NOTES.md was read\nthen the build ran';
    expect(mentions(block)).toEqual(['NOTES.md']);
    expect(mentions(neutraliseAtMentions(block).text)).toEqual([]);
  });

  it('defuses the CLI’s QUOTED form too — same boundary, same break', () => {
    const quoted = 'it read @"my notes.md" first';
    const r = neutraliseAtMentions(quoted);
    expect(r.count).toBe(1);
    expect(/(^|[\s。、？！])@"([^"]+)"/g.test(r.text)).toBe(false);
  });

  it('covers the CJK boundary characters the extractor accepts', () => {
    const cjk = 'それは。@NOTES.md です';
    expect(mentions(cjk)).toEqual(['NOTES.md']);
    expect(mentions(neutraliseAtMentions(cjk).text)).toEqual([]);
  });

  it('leaves an at-sign that was never a mention alone — it was not a boundary', () => {
    // No whitespace before it, so the CLI never matched it in the first place.
    const r = neutraliseAtMentions("import x from '@scope/pkg'");
    expect(r).toEqual({ text: "import x from '@scope/pkg'", count: 0 });
  });

  it('is idempotent: a block that passes through two doors is not double-escaped', () => {
    const once = neutraliseAtMentions('see @types/node');
    const twice = neutraliseAtMentions(once.text);
    expect(twice.text).toBe(once.text);
    expect(twice.count).toBe(0);
  });

  it('keeps every word readable — the escape is visible, never an invisible character', () => {
    const r = neutraliseAtMentions('see @types/node');
    expect(r.text).toContain('types/node');
    // The rule `sibling-message.ts` states: what the user reviews must be what
    // the agent reads. No zero-width, bidi or tag characters may be introduced.
    // BUILT FROM CODE POINTS, the rule the source files state: no control or
    // invisible character may appear in a source file, and `check:nul` plus the
    // lint's irregular-whitespace rule fail the build if one does.
    const invisible = (cp: number): boolean =>
      cp === 0x200b ||
      (cp >= 0x200e && cp <= 0x200f) ||
      (cp >= 0x202a && cp <= 0x202e) ||
      (cp >= 0x2060 && cp <= 0x2064) ||
      (cp >= 0x2066 && cp <= 0x2069) ||
      cp === 0xfeff;
    expect([...r.text].some((ch) => invisible(ch.codePointAt(0) ?? 0))).toBe(false);
  });

  it('says the note only when something was actually escaped', () => {
    expect(atEscapeNote(0)).toBe('');
    expect(atEscapeNote(2)).toBe(AT_ESCAPE_NOTE);
  });
});
