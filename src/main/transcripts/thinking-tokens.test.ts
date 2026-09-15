// The one hard rule of #789: thinking tokens are INSIDE `output_tokens`.
//
// Every hostile line here is built as JSON TEXT and parsed, with a witness
// assertion that the parsed value really is the hostile thing — a hand-built
// object literal can quietly not contain what the test is named after (a
// string that is secretly a number, an `Infinity` that JSON cannot spell).
import { describe, it, expect } from 'vitest';
import { thinkingTokensOf } from './thinking-tokens';

const parse = (text: string): Record<string, unknown> => JSON.parse(text) as Record<string, unknown>;
const detailsOf = (u: Record<string, unknown>): Record<string, unknown> =>
  u.output_tokens_details as Record<string, unknown>;

describe('thinkingTokensOf', () => {
  it('reads the breakdown off a real-shaped line', () => {
    const u = parse('{"output_tokens":4200,"output_tokens_details":{"thinking_tokens":2900}}');
    expect(thinkingTokensOf(u)).toBe(2900);
  });

  it('accepts thinking EQUAL to output — a subset may be the whole set', () => {
    // The measured maximum ratio was 0.9928, so equality has not been seen;
    // it is still inside the contract, and refusing it would be a stricter
    // rule than the one we can defend.
    const u = parse('{"output_tokens":551,"output_tokens_details":{"thinking_tokens":551}}');
    expect(thinkingTokensOf(u)).toBe(551);
  });

  it('refuses a line whose thinking EXCEEDS its output — 0, not a clamp', () => {
    const u = parse('{"output_tokens":3,"output_tokens_details":{"thinking_tokens":9}}');
    expect(detailsOf(u).thinking_tokens).toBeGreaterThan(u.output_tokens as number); // witness
    expect(thinkingTokensOf(u)).toBe(0);
  });

  it('is 0 when the line has no breakdown at all (every CLI before 2.1.233)', () => {
    expect(thinkingTokensOf(parse('{"output_tokens":4200}'))).toBe(0);
  });

  it('is 0 when there is a breakdown but no output_tokens to be a subset OF', () => {
    // Our output total adds 0 for this line, so thinking must add 0 as well or
    // the session total could show more thinking than output.
    const u = parse('{"output_tokens_details":{"thinking_tokens":5}}');
    expect(u.output_tokens).toBeUndefined(); // witness
    expect(thinkingTokensOf(u)).toBe(0);
  });

  it('is 0 when output_tokens is a numeric STRING', () => {
    // `"9000" >= 5` is true in JavaScript; the typeof check is what stops a
    // coerced comparison from passing a line the contract does not describe.
    const u = parse('{"output_tokens":"9000","output_tokens_details":{"thinking_tokens":5}}');
    expect(typeof u.output_tokens).toBe('string'); // witness
    expect(thinkingTokensOf(u)).toBe(0);
  });

  it('is 0 when the details object is null', () => {
    // NOT hypothetical: re-measured 2026-09-15 over 259,678 corpus lines, the
    // CLI writes `output_tokens_details: null` on 20 `<synthetic>` lines
    // (2.1.233 → 2.1.261, always with `output_tokens: 0`). Without the null
    // check this line throws inside the watcher's absorb loop.
    const u = parse('{"output_tokens":10,"output_tokens_details":null}');
    expect(u.output_tokens_details).toBeNull(); // witness
    expect(thinkingTokensOf(u)).toBe(0);
  });

  it('is 0 when thinking_tokens is a numeric string', () => {
    const u = parse('{"output_tokens":10,"output_tokens_details":{"thinking_tokens":"5"}}');
    expect(typeof detailsOf(u).thinking_tokens).toBe('string'); // witness
    expect(thinkingTokensOf(u)).toBe(0);
  });

  it('is 0 when thinking_tokens is negative', () => {
    const u = parse('{"output_tokens":10,"output_tokens_details":{"thinking_tokens":-5}}');
    expect(detailsOf(u).thinking_tokens).toBe(-5); // witness
    expect(thinkingTokensOf(u)).toBe(0);
  });

  it('is 0 when both counters overflow to Infinity', () => {
    // `1e999` is how JSON spells a number that parses to Infinity, and
    // `Infinity <= Infinity` is true — only the finiteness check refuses it.
    const u = parse('{"output_tokens":1e999,"output_tokens_details":{"thinking_tokens":1e999}}');
    expect(detailsOf(u).thinking_tokens).toBe(Infinity); // witness
    expect(thinkingTokensOf(u)).toBe(0);
  });

  it('ignores a future sibling sub-key rather than failing on it', () => {
    const u = parse(
      '{"output_tokens":10,"output_tokens_details":{"thinking_tokens":4,"some_future_split":9}}'
    );
    expect(thinkingTokensOf(u)).toBe(4);
  });
});
