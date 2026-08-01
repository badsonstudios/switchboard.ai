// P2-E15-10: the §5.26 round-trip drift detector.
//
// The done-when is one sentence with two halves that pull against each other:
// a line carrying an unknown field logs EXACTLY ONE warning naming it, and is
// OTHERWISE INGESTED NORMALLY. The second half is the important one — a
// detector that quarantines a line it does not fully understand has replaced a
// silent schema break with a loud data-loss bug.
import { describe, it, expect, vi } from 'vitest';
import { DriftDetector, unknownKeys } from './drift';
import { KNOWN_LINE_TYPES, TRANSCRIPT_SCHEMA } from './schema';

/** A realistic assistant line, entirely inside the declared contract. */
function assistantLine(): Record<string, unknown> {
  return {
    type: 'assistant',
    uuid: 'u-1',
    parentUuid: 'u-0',
    sessionId: 's-1',
    cwd: 'C:/tmp/x',
    version: '2.1.220',
    gitBranch: 'main',
    timestamp: '2026-07-31T10:00:00.000Z',
    isSidechain: false,
    userType: 'external',
    requestId: 'req_1',
    message: {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-5',
      stop_reason: 'end_turn',
      stop_sequence: null,
      content: [
        { type: 'text', text: 'hello' },
        { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a.md' } },
      ],
      usage: {
        input_tokens: 10,
        output_tokens: 20,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        service_tier: 'standard',
        iterations: 1,
      },
    },
  };
}

describe('unknownKeys (the declared contract)', () => {
  it('reports nothing for a line entirely inside the schema', () => {
    expect(unknownKeys(assistantLine())).toEqual([]);
  });

  it('names a new TOP-LEVEL field by its path', () => {
    const line = { ...assistantLine(), thinkingBudget: 4096 };
    expect(unknownKeys(line)).toEqual(['thinkingBudget']);
  });

  it('names a new NESTED field by its dotted path', () => {
    const line = assistantLine();
    (line.message as Record<string, unknown>).reasoningTrace = 'x';
    expect(unknownKeys(line)).toEqual(['message.reasoningTrace']);
  });

  it('names a new field inside a content item', () => {
    const line = assistantLine();
    const content = (line.message as { content: Array<Record<string, unknown>> }).content;
    content[0].redactionReason = 'policy';
    expect(unknownKeys(line)).toEqual(['message.content[].redactionReason']);
  });

  it('names a renamed usage field — the failure this exists to catch', () => {
    // A release renaming output_tokens shows up as token totals silently
    // reading zero. This is the line in the log that says why.
    const line = assistantLine();
    const usage = (line.message as { usage: Record<string, unknown> }).usage;
    delete usage.output_tokens;
    usage.output_token_count = 20;
    expect(unknownKeys(line)).toEqual(['message.usage.output_token_count']);
  });

  it('reports an unknown line TYPE as its own signal (§5.26 warns per type too)', () => {
    expect(unknownKeys({ type: 'checkpoint-restore' })).toEqual(['type=checkpoint-restore']);
  });

  it('accepts every declared line type', () => {
    for (const t of KNOWN_LINE_TYPES) expect(unknownKeys({ type: t })).toEqual([]);
  });

  it('accepts a summary record — the first resume of a compacted conversation', () => {
    // Not in the 2026-07-31 corpus, but `claim()`'s head-parsing archaeology is
    // built around summary-first files, and resumed transcripts replay from
    // offset 0. Omitting it made a guaranteed false positive out of a case the
    // rest of the watcher already knows about.
    expect(unknownKeys({ type: 'summary', summary: 'Earlier work', leafUuid: 'u9' })).toEqual([]);
  });

  it('accepts content blocks the corpus could not have contained', () => {
    // The corpus is one machine's history, so it measures a LOWER BOUND on the
    // format: any feature nobody here has triggered is absent from the
    // measurement without being absent from the schema. Each of these would
    // otherwise fire a false alarm the first time the feature was used.
    const block = (over: Record<string, unknown>) => ({
      type: 'assistant',
      message: { role: 'assistant', content: [over] },
    });
    expect(unknownKeys(block({ type: 'redacted_thinking', data: 'xxx' }))).toEqual([]);
    expect(unknownKeys(block({ type: 'text', text: 'x', citations: [] }))).toEqual([]);
    expect(unknownKeys(block({ type: 'text', text: 'x', cache_control: { type: 'ephemeral' } }))).toEqual([]);
  });

  it('never walks INTO tool arguments — they belong to the tool, not the format', () => {
    // Otherwise every parameter of every skill and MCP server anyone runs
    // reports as drift, and the detector is muted inside a day.
    const line = assistantLine();
    const content = (line.message as { content: Array<Record<string, unknown>> }).content;
    content[1].input = { anything_at_all: 1, nested: { deeper: { still: true } } };
    expect(unknownKeys(line)).toEqual([]);
  });

  it('does not descend into an unknown key — one report, not an inventory', () => {
    const line = { ...assistantLine(), newBlob: { a: 1, b: { c: 2, d: 3 } } };
    expect(unknownKeys(line)).toEqual(['newBlob']);
  });

  it('tolerates a string message.content (a plain user prompt) without reporting', () => {
    const line = {
      type: 'user',
      sessionId: 's',
      message: { role: 'user', content: 'just text' },
    };
    expect(unknownKeys(line)).toEqual([]);
  });

  it('survives nulls, arrays and primitives where objects were expected', () => {
    expect(() => unknownKeys({ type: 'user', message: null })).not.toThrow();
    expect(() => unknownKeys({ type: 'user', message: [1, 2, 3] })).not.toThrow();
    expect(() => unknownKeys({ type: 'user', message: 7 })).not.toThrow();
    expect(unknownKeys({ type: 'user', message: null })).toEqual([]);
  });

  it('truncates an absurd key name rather than echoing it into a log', () => {
    const line = { type: 'user', [`x`.repeat(500)]: 1 };
    const [key] = unknownKeys(line);
    expect(key.length).toBeLessThanOrEqual(121); // 120 + the ellipsis
  });

  it('does not blow up on a deeply self-nested line', () => {
    const line: Record<string, unknown> = { type: 'user' };
    let node = line;
    for (let i = 0; i < 200; i++) {
      const next: Record<string, unknown> = {};
      node.message = next;
      node = next;
    }
    expect(() => unknownKeys(line)).not.toThrow();
  });
});

const ROOT = 'C:/Users/x/.claude/projects';

describe('DriftDetector (warn-once)', () => {
  it('warns EXACTLY once for a field, however many lines carry it', () => {
    const warn = vi.fn();
    const d = new DriftDetector(warn);
    for (let i = 0; i < 25; i++) {
      d.inspect(ROOT, { ...assistantLine(), thinkingBudget: i }, 'assistant');
    }
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('thinkingBudget', 'assistant');
    expect(d.keys(ROOT)).toEqual(['thinkingBudget']);
  });

  it('warns once PER key, not once in total', () => {
    const warn = vi.fn();
    const d = new DriftDetector(warn);
    d.inspect(ROOT, { type: 'assistant', alpha: 1 }, 'assistant');
    d.inspect(ROOT, { type: 'assistant', beta: 2 }, 'assistant');
    d.inspect(ROOT, { type: 'assistant', alpha: 3, beta: 4 }, 'assistant');
    expect(warn.mock.calls.map((c) => c[0])).toEqual(['alpha', 'beta']);
  });

  it('ignores a line that is not an object at all', () => {
    // `JSON.parse` is happy with a bare string or array, and walking one would
    // report its INDICES as drifted keys — burning warn-once slots on junk and
    // putting '0','1','2' in the diagnostics.
    const warn = vi.fn();
    const d = new DriftDetector(warn);
    d.inspect(ROOT, 'a bare string', 'user');
    d.inspect(ROOT, [1, 2, 3], 'user');
    d.inspect(ROOT, null, 'user');
    d.inspect(ROOT, 42, 'user');
    expect(warn).not.toHaveBeenCalled();
    expect(d.keys(ROOT)).toEqual([]);
  });

  it('stops after 200 distinct keys, PER ROOT — one bad provider cannot mute the others', () => {
    // The watcher has been provider-generic since P2-E15-01, but this schema
    // is Claude-shaped. A process-wide cap meant an adapter writing a
    // different JSONL dialect would exhaust the budget and switch drift
    // detection off for the Claude sessions too — the detector disabling
    // itself is exactly the silence it exists to break.
    const warn = vi.fn();
    const d = new DriftDetector(warn);
    const OTHER = 'C:/Users/x/.some-other-cli/sessions';
    for (let i = 0; i < 400; i++) d.inspect(OTHER, { type: 'assistant', [`k${i}`]: 1 }, 'assistant');
    expect(d.keys(OTHER)).toHaveLength(200);
    // 200 real warnings + the one that says it has stopped looking
    expect(warn).toHaveBeenCalledTimes(201);
    expect(warn.mock.calls[200][0]).toMatch(/drift detection stopped/);
    // and it stays stopped for THAT root
    warn.mockClear();
    d.inspect(OTHER, { type: 'assistant', brandNew: 1 }, 'assistant');
    expect(warn).not.toHaveBeenCalled();

    // ...while the Claude root is untouched and still reporting
    d.inspect(ROOT, { type: 'assistant', outputTokensV2: 1 }, 'assistant');
    expect(warn).toHaveBeenCalledWith('outputTokensV2', 'assistant');
    expect(d.keys(ROOT)).toEqual(['outputTokensV2']);
  });

  it('never throws even when the warn callback does', () => {
    // The detector sits on the ingest path of every transcript line in the
    // app. A logger having a bad day must not stop the Feed rendering.
    const d = new DriftDetector(() => {
      throw new Error('log sink is on fire');
    });
    expect(() => d.inspect(ROOT, { type: 'assistant', surprise: 1 }, 'assistant')).not.toThrow();
  });
});

describe('the schema itself', () => {
  it('declares no key as both consumed and ignored', () => {
    for (const [path, contract] of Object.entries(TRANSCRIPT_SCHEMA)) {
      const both = contract.consumed.filter((k) => contract.ignored.includes(k));
      expect(both, `${path || '<root>'} declares ${both.join(', ')} twice`).toEqual([]);
    }
  });

  it('only descends into keys it has actually declared', () => {
    // A `descend` entry for an undeclared key would be dead: the walker
    // reports the key as drift and never reaches the child path.
    for (const [path, contract] of Object.entries(TRANSCRIPT_SCHEMA)) {
      for (const key of Object.keys(contract.descend ?? {})) {
        expect(
          [...contract.consumed, ...contract.ignored],
          `${path || '<root>'} descends into undeclared "${key}"`
        ).toContain(key);
      }
    }
  });

  it('every descend target is a declared path', () => {
    for (const contract of Object.values(TRANSCRIPT_SCHEMA)) {
      for (const target of Object.values(contract.descend ?? {})) {
        expect(Object.keys(TRANSCRIPT_SCHEMA)).toContain(target);
      }
    }
  });
});
