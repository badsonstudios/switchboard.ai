import { describe, it, expect } from 'vitest';
import { UsageLedger, usageKey } from './usage-ledger';
import type { UsageTotals } from './watcher';

const zero = (): UsageTotals => ({ input: 0, output: 0, cacheRead: 0, cacheCreate: 0, thinking: 0 });

/** Feed lines through one ledger the way the watcher does, and return the totals. */
function run(lines: Array<Record<string, unknown>>): UsageTotals {
  const ledger = new UsageLedger();
  const totals = zero();
  for (const line of lines) {
    const usage = (line.message as { usage?: Record<string, unknown> } | undefined)?.usage;
    if (usage) ledger.absorb(totals, usage, usageKey(line));
  }
  return totals;
}

const copy = (id: string | undefined, requestId: string | undefined, usage: Record<string, unknown>) => ({
  type: 'assistant',
  ...(requestId === undefined ? {} : { requestId }),
  message: { ...(id === undefined ? {} : { id }), usage },
});

describe('usageKey', () => {
  it('is the message id', () => {
    expect(usageKey(copy('msg_1', 'req_1', {}))).toBe('msg_1');
  });

  it('does not depend on requestId — a copy that lacks one is still the same response', () => {
    expect(usageKey(copy('msg_1', undefined, {}))).toBe(usageKey(copy('msg_1', 'req_1', {})));
  });

  it('has no key without a usable message id', () => {
    expect(usageKey(copy(undefined, 'req_1', {}))).toBeUndefined();
    expect(usageKey(copy('', 'req_1', {}))).toBeUndefined();
    expect(usageKey({ message: { id: 42 }, requestId: 'req_1' })).toBeUndefined();
    expect(usageKey({ requestId: 'req_1' })).toBeUndefined();
  });
});

describe('UsageLedger', () => {
  it('counts identical copies of one response once', () => {
    const u = { input_tokens: 5, output_tokens: 40, cache_read_input_tokens: 1000, cache_creation_input_tokens: 30 };
    expect(run([copy('m', 'r', u), copy('m', 'r', u), copy('m', 'r', u)])).toEqual({
      input: 5,
      output: 40,
      cacheRead: 1000,
      cacheCreate: 30,
      thinking: 0,
    });
  });

  it('lets a later copy REPLACE an earlier one — the real subagent shape, where output grows', () => {
    const early = { input_tokens: 2, output_tokens: 2, cache_read_input_tokens: 17891, cache_creation_input_tokens: 4405 };
    const late = { ...early, output_tokens: 1191, output_tokens_details: { thinking_tokens: 100 } };
    expect(run([copy('m', 'r', early), copy('m', 'r', late)])).toEqual({
      input: 2,
      output: 1191,
      cacheRead: 17891,
      cacheCreate: 4405,
      thinking: 100,
    });
  });

  it('replaces against the PREVIOUS copy each time, across three strictly growing copies', () => {
    // Found in review: the fixture's three-copy response reads 2, 2, 4450, so a
    // ledger that only ever remembered the FIRST copy gave the right answer.
    const c = (output: number, thinking: number) =>
      copy('m', 'r', { input_tokens: 2, output_tokens: output, output_tokens_details: { thinking_tokens: thinking } });
    expect(run([c(2, 0), c(900, 40), c(4450, 229)])).toMatchObject({ input: 2, output: 4450, thinking: 229 });
  });

  it('replaces by the LATEST copy, not the largest — a lower later copy lowers the total', () => {
    // Never measured (0 decreasing copies in the corpus). Pinned so the rule is
    // one rule: "max" and "latest" agree on every real transcript and would
    // otherwise be indistinguishable to every other test here.
    expect(run([copy('m', 'r', { output_tokens: 50 }), copy('m', 'r', { output_tokens: 20 })]).output).toBe(20);
  });

  it('replaces thinking with its copy, and a copy with none takes it back out', () => {
    const t = (thinking: number | undefined, output: number) =>
      copy('m', 'r', {
        output_tokens: output,
        ...(thinking === undefined ? {} : { output_tokens_details: { thinking_tokens: thinking } }),
      });
    expect(run([t(50, 60), t(120, 300)]).thinking).toBe(120);
    expect(run([t(120, 300), t(undefined, 300)]).thinking).toBe(0);
  });

  it('matches copies that are not adjacent — a tool result can sit between them', () => {
    const totals = run([
      copy('a', 'r1', { output_tokens: 2 }),
      { type: 'user', message: { content: [{ type: 'tool_result' }] } },
      copy('b', 'r2', { output_tokens: 7 }),
      copy('a', 'r1', { output_tokens: 4450 }),
    ]);
    expect(totals.output).toBe(4457);
  });

  it('counts distinct responses separately', () => {
    expect(run([copy('a', 'r1', { input_tokens: 3 }), copy('b', 'r1', { input_tokens: 4 })]).input).toBe(7);
  });

  it('treats copies of one response as one even when only some carry a requestId', () => {
    expect(run([copy('a', undefined, { output_tokens: 2 }), copy('a', 'r1', { output_tokens: 90 })]).output).toBe(90);
  });

  it('adds every line that has no key — no id means nothing to de-dupe on', () => {
    const u = { input_tokens: 5 };
    expect(run([copy(undefined, 'r', u), copy(undefined, 'r', u)]).input).toBe(10);
  });

  it('treats a non-finite or non-numeric count as 0, and a later good copy is not poisoned by it', () => {
    const bad = { input_tokens: 'lots', output_tokens: Number.NaN, cache_read_input_tokens: Infinity, cache_creation_input_tokens: null };
    const good = { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 };
    expect(run([copy('m', 'r', bad)])).toEqual(zero());
    expect(run([copy('m', 'r', bad), copy('m', 'r', good)])).toEqual({
      input: 1,
      output: 2,
      cacheRead: 3,
      cacheCreate: 4,
      thinking: 0,
    });
  });

  it('adds into the totals it is given, on top of what they already hold', () => {
    const ledger = new UsageLedger();
    const totals = { ...zero(), input: 100 };
    ledger.absorb(totals, { input_tokens: 5 }, 'm');
    ledger.absorb(totals, { input_tokens: 5 }, 'm');
    expect(totals.input).toBe(105);
  });

  it('keeps no memory across ledgers — a fresh one counts a known key again', () => {
    const totals = zero();
    new UsageLedger().absorb(totals, { output_tokens: 10 }, 'm');
    new UsageLedger().absorb(totals, { output_tokens: 10 }, 'm');
    expect(totals.output).toBe(20);
  });
});
