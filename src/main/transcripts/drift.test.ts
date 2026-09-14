// P2-E15-10: the §5.26 round-trip drift detector.
//
// The done-when is one sentence with two halves that pull against each other:
// a line carrying an unknown field logs EXACTLY ONE warning naming it, and is
// OTHERWISE INGESTED NORMALLY. The second half is the important one — a
// detector that quarantines a line it does not fully understand has replaced a
// silent schema break with a loud data-loss bug.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { DriftDetector, unknownKeys } from './drift';
import { KNOWN_LINE_TYPES, TRANSCRIPT_SCHEMA, TYPE_SCOPED_ROOT_KEYS } from './schema';

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
    const warn = vi.fn<(key: string, sample: string) => void>();
    const d = new DriftDetector(warn);
    for (let i = 0; i < 25; i++) {
      d.inspect(ROOT, { ...assistantLine(), thinkingBudget: i }, 'assistant');
    }
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('thinkingBudget', 'assistant');
    expect(d.keys(ROOT)).toEqual(['thinkingBudget']);
  });

  it('warns once PER key, not once in total', () => {
    const warn = vi.fn<(key: string, sample: string) => void>();
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
    const warn = vi.fn<(key: string, sample: string) => void>();
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
    const warn = vi.fn<(key: string, sample: string) => void>();
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

// #779 — the schema re-measured against 3,259 transcripts / 244,916 lines and
// against the CLI's own routing tables (PATH binary 2.1.261). Every line below
// is a shape the corpus actually contained or a payload the binary's reducer
// names by hand; none is invented. They exist so that removing a key from
// `schema.ts` reddens a test instead of quietly costing us a real warning slot
// on Dan's next session.
describe('lines the 2026-07-31 corpus was too small to contain (#779)', () => {
  it('accepts a 2.1.261 assistant line — attribution, api block index, thinking breakdown', () => {
    // Every one of these was reported as drift before #779. `apiBlockIndex` and
    // `isAbortedMidStream` are 2.1.261-only; `agentId` and `attributionAgent`
    // span 2.1.226 → 2.1.261, so they were always there and the old corpus
    // simply never ran a subagent.
    const line = assistantLine();
    Object.assign(line, {
      agentId: 'a01a13363455c1315',
      attributionAgent: 'deep-research-specialist',
      attributionMcpServer: 'sbbus',
      attributionMcpTool: 'sb_probe_echo',
      apiBlockIndex: 1,
      isAbortedMidStream: true,
    });
    const usage = (line.message as { usage: Record<string, unknown> }).usage;
    usage.output_tokens_details = { thinking_tokens: 551 };
    expect(unknownKeys(line)).toEqual([]);
  });

  it('does not walk INTO the thinking breakdown — it is a counter, not a contract', () => {
    // Same posture as `cache_creation`: we never read the interior, so its
    // interior is not ours to declare. Pinning it stops someone "helpfully"
    // adding a descend for it and turning a future Anthropic sub-key into a
    // warning about a number we do not use.
    const line = assistantLine();
    const usage = (line.message as { usage: Record<string, unknown> }).usage;
    usage.output_tokens_details = { thinking_tokens: 4, some_future_split: 9 };
    expect(unknownKeys(line)).toEqual([]);
  });

  it('accepts a user line the queue touched, and an attachment the CLI expanded', () => {
    expect(
      unknownKeys({
        type: 'user',
        sessionId: 's-1',
        turnCompanion: true,
        queueSkipAttachments: true,
        interruptedByShutdown: true,
        message: { role: 'user', content: 'go' },
      })
    ).toEqual([]);
    expect(
      unknownKeys({
        type: 'attachment',
        sessionId: 's-1',
        rendered: [{ content: '<system-reminder>…' }],
        renderedInHumanTurn: [{ content: '<system-reminder>…' }],
      })
    ).toEqual([]);
  });

  // The CLI's bookkeeping line types that carry a PAYLOAD, with the fields its
  // own reducer reads. Four of these (`atis-latch`, `relocated`,
  // `worktree-state`, `cost-state`) were live drift on every ordinary session;
  // the rest were waiting for the first time a feature got used.
  //
  // The payload-FREE types (`progress`, `observer-ref`, the three
  // `marble-origami-*`, the two `artifact-*`, `history-suppression`) are
  // deliberately NOT listed: a row carrying no fields asserts only that the type
  // is known, which the loop over all of `KNOWN_LINE_TYPES` above already covers.
  // Including them made the table read as 26 shapes pinned when it was 17.
  const bookkeeping: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    ['atis-latch', { atis: '' }],
    ['relocated', { relocatedCwd: 'C:/Projects/x/.claude/worktrees/y' }],
    ['worktree-state', { worktreeSession: { originalCwd: 'C:/p', worktreePath: 'C:/p/.wt' } }],
    [
      'cost-state',
      {
        totalCostUSD: 4.3635505,
        modelUsage: { 'claude-opus-5': { inputTokens: 590, outputTokens: 380369 } },
        hasUnknownModelCost: false,
        totalAPIDuration: 585311,
        totalAPIDurationWithoutRetries: 585268,
        totalToolDuration: 1102,
        totalDuration: 5766257,
        totalLinesAdded: 773,
        totalLinesRemoved: 38,
        startTime: 1788637029344,
      },
    ],
    ['queue-operation', { operation: 'absorb', reason: 'absorbed_mid_turn' }],
    ['tag', { tag: 'release' }],
    ['custom-title', { customTitle: 'The git pane' }],
    ['agent-name', { agentName: 'debugger' }],
    ['agent-color', { agentColor: 'cyan' }],
    ['agent-setting', { agentSetting: 'inherit' }],
    ['isolation-latch', { side: 'left' }],
    ['continued-in', { continuedInSessionId: 's-2', timestamp: '2026-09-12T10:00:00.000Z' }],
    ['ended-by-model', { timestamp: '2026-09-12T10:00:00.000Z' }],
    ['attribution-snapshot', { messageId: 'm-1' }],
    ['content-replacement', { agentId: 'a-1', replacements: [] }],
    ['fork-context-ref', { agentId: 'a-1' }],
    [
      'bridge-session',
      {
        bridgeSessionId: 'b-1',
        lastSequenceNum: 7,
        sessionGroupingId: 'g-1',
        noHistoryBackfill: true,
        ownerAccountUuid: 'acc-1',
        ownerOrganizationUuid: 'org-1',
        declaredDialogKinds: ['chat'],
      },
    ],
    [
      'frame-link',
      { artifactCount: 2, path: 'C:/p/a.html', frameUrl: 'https://x/y', title: 'Chart' },
    ],
  ];

  it.each(bookkeeping)('accepts a %s line whole', (type, payload) => {
    expect(unknownKeys({ type, sessionId: 's-1', ...payload })).toEqual([]);
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

  it('never declares the same key twice in one list', () => {
    // #779 added 44 hand-typed names to the root `ignored` array, which is
    // exactly the size at which a paste lands twice and nobody sees it. A
    // duplicate is harmless to the walker and invisible to a reader, so it
    // survives — and then the NEXT person counts the list to answer "is this key
    // declared?" and gets the wrong answer.
    for (const [path, contract] of Object.entries(TRANSCRIPT_SCHEMA)) {
      for (const [name, list] of [
        ['consumed', contract.consumed],
        ['ignored', contract.ignored],
      ] as const) {
        const dupes = [...new Set(list.filter((k, i) => list.indexOf(k) !== i))];
        expect(dupes, `${path || '<root>'}.${name} declares ${dupes.join(', ')} twice`).toEqual([]);
      }
    }
    const typeDupes = [
      ...new Set(KNOWN_LINE_TYPES.filter((t, i) => KNOWN_LINE_TYPES.indexOf(t) !== i)),
    ];
    expect(typeDupes, `KNOWN_LINE_TYPES declares ${typeDupes.join(', ')} twice`).toEqual([]);
  });

  it('the counts its comments claim match the lists they describe', () => {
    // Not busywork — these numbers had ALREADY rotted when #779 found them: the
    // root comment read "68 keys, measured" over a list of 69. Nothing noticed,
    // because the only thing that number does is tell a reader the scale of what
    // they are about to trust, and a hand-written count beside a hand-written list
    // is wrong the first time someone appends without counting.
    //
    // It reads the comment out of the SOURCE and compares, rather than pinning a
    // literal here. Review caught why that matters: a literal in the test makes
    // THREE places to keep in sync, so the next appender bumps the test, forgets
    // the comment, and gets green with a rotted comment — the exact failure this
    // is for, one level deeper. Compared against the source there is nothing to
    // bump and it can only fail when the two genuinely disagree.
    const src = readFileSync(path.join(__dirname, 'schema.ts'), 'utf8');

    const claimedKeys = Number(/^\s*\/\/ (\d+) keys\./m.exec(src)?.[1]);
    expect(claimedKeys, 'schema.ts: could not find the "N keys." comment').not.toBeNaN();
    expect(claimedKeys, 'schema.ts: the root ignored count comment is stale').toBe(
      TRANSCRIPT_SCHEMA[''].ignored.length
    );

    const claimedTypes = Number(/enumerate the same (\d+)\b/.exec(src)?.[1]);
    expect(claimedTypes, 'schema.ts: could not find the line-type count claim').not.toBeNaN();
    expect(claimedTypes, 'schema.ts: the line-type count claim is stale').toBe(
      KNOWN_LINE_TYPES.length
    );
  });

  it('scopes a type-scoped key to its own type and nowhere else', () => {
    // The reason TYPE_SCOPED_ROOT_KEYS exists. `path` and `title` belong to a
    // `frame-link` line; declared flat they would have permanently silenced a
    // `cwd` → `path` or `aiTitle` → `title` rename, which is the consumed-field
    // rename this whole file is for. Both directions are asserted, because only
    // the negative one is load-bearing and only the positive one is why we added
    // the keys at all.
    expect(
      unknownKeys({ type: 'frame-link', sessionId: 's', path: 'C:/p/a.html', title: 'Chart' })
    ).toEqual([]);
    const line = assistantLine();
    line.path = 'C:/p/a.html';
    line.title = 'Chart';
    expect(unknownKeys(line)).toEqual(['path', 'title']);
  });

  it('a cost-state payload key on ANY other line type is drift (#787)', () => {
    // The tightening #787 paid 243,649 measured lines for, pinned. These ten
    // keys sat in the flat `ignored` list from #779, where they were legal on
    // all 38 line types; now that `watcher.ts` renders `totalCostUSD` as money,
    // a rename of it is the loudest thing this detector exists to catch, and
    // the flat list would have silenced it for ever.
    expect(
      unknownKeys({
        type: 'cost-state',
        sessionId: 's',
        totalCostUSD: 1,
        modelUsage: {},
        hasUnknownModelCost: false,
        totalAPIDuration: 0,
        totalAPIDurationWithoutRetries: 0,
        totalToolDuration: 0,
        totalDuration: 0,
        totalLinesAdded: 0,
        totalLinesRemoved: 0,
        startTime: 0,
      })
    ).toEqual([]);
    const line = assistantLine();
    line.totalCostUSD = 1;
    line.modelUsage = {};
    expect(unknownKeys(line)).toEqual(['totalCostUSD', 'modelUsage']);
  });

  it('gives a line with no usable type the SHARED set, not a type-s extras', () => {
    // A line that will not say what it is does not get a type's allowances.
    expect(unknownKeys({ sessionId: 's', customTitle: 'x' })).toEqual(['customTitle']);
    expect(unknownKeys({ type: 42, sessionId: 's', customTitle: 'x' })).toEqual(['customTitle']);
  });

  it('every type-scoped key is scoped to a DECLARED line type, and is not also flat', () => {
    // A scope on an undeclared type would be dead (the line reports
    // `type=<value>` and its keys are checked against the shared set anyway), and
    // a key in both places is a scope that does nothing — the silent way this
    // map decays back into the flat list it exists to avoid.
    for (const [type, keys] of Object.entries(TYPE_SCOPED_ROOT_KEYS)) {
      expect(KNOWN_LINE_TYPES, `${type} is scoped but not a declared line type`).toContain(type);
      for (const key of keys) {
        expect(
          [...TRANSCRIPT_SCHEMA[''].consumed, ...TRANSCRIPT_SCHEMA[''].ignored],
          `${key} is scoped to ${type} AND declared flat — the scope does nothing`
        ).not.toContain(key);
      }
    }
  });
});
