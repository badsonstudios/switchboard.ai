// P2-E17-01 — the transcript search engine.
//
// The load-bearing test in this file is "finds text the view buffer has thrown
// away". Everything else guards a way the engine could quietly start lying:
// searching capped text, searching JSON escapes instead of what the user reads,
// missing the tail of a file being written, or handing E17-02 a `seq` that
// points at the wrong block.
import fs from 'fs';
import path from 'path';
import { beforeAll, describe, expect, it } from 'vitest';
import { BLOCK_CAP, DETAIL_CAP, FeedBlock, deriveIntents } from '../feed/blocks';
import { FeedBuffer } from '../feed/buffer';
import { tempDir } from '../../test-temp-dirs';
import {
  SESSION_TRANSCRIPT,
  SESSION_TRANSCRIPT_FACTS,
  transcriptLines,
} from './fixtures/session-transcript';
import { alignToLoaded, compileMatcher, searchTranscripts, unsafeRegexShape } from './search';

let tmp: string;

// One directory for the file, registered so the net in `test-setup.ts` takes it
// (#213) — every test here writes its own transcript into it.
beforeAll(() => {
  tmp = tempDir('sb-search-');
});

/** Write a transcript made of JSON objects, one per line. */
function transcript(name: string, entries: unknown[], trailingNewline = true): string {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + (trailingNewline ? '\n' : ''));
  return file;
}

/** An assistant turn with one text block. */
const say = (text: string, ts?: string): unknown => ({
  type: 'assistant',
  ...(ts ? { timestamp: ts } : {}),
  message: { role: 'assistant', content: [{ type: 'text', text }] },
});

/**
 * What the FEED holds for a transcript — the watcher's own derivation, block cap
 * and tool-result stitching, run over the same file.
 *
 * Copied in shape from `TranscriptWatcher.deriveBlocks` for a non-sidechain
 * file, which is the point: the engine's `seq` claim is only worth anything if
 * it agrees with what this produces.
 */
function feedOf(lines: string[]): FeedBlock[] {
  const feed = new FeedBuffer(() => {});
  for (const line of lines) {
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    for (const intent of deriveIntents(e)) {
      if (intent.t === 'tool-result') {
        feed.attachResult(intent.toolUseId, intent.out);
        continue;
      }
      const block = feed.push(intent.block, false);
      if (intent.toolUseId) feed.remember(intent.toolUseId, block);
    }
  }
  return feed.list();
}

const search = searchTranscripts;

describe('the captured real transcript', () => {
  it('is the shape the fixture claims — and bigger than the view buffer', () => {
    const lines = transcriptLines();
    expect(lines).toHaveLength(SESSION_TRANSCRIPT_FACTS.lines);
    let blocks = 0;
    let results = 0;
    for (const line of lines) {
      for (const intent of deriveIntents(JSON.parse(line) as Record<string, unknown>)) {
        if (intent.t === 'block') blocks++;
        else results++;
      }
    }
    expect(blocks).toBe(SESSION_TRANSCRIPT_FACTS.blocks);
    expect(results).toBe(SESSION_TRANSCRIPT_FACTS.toolResults);
    // The premise of the whole epic: the Feed cannot hold this session.
    expect(blocks).toBeGreaterThan(BLOCK_CAP);
    expect(feedOf(lines)).toHaveLength(BLOCK_CAP);
  });

  // THE POINT OF THE ITEM. A DOM search would answer "no results" for every one
  // of these, because the blocks they live in were dropped from the renderer's
  // buffer long before the user pressed Ctrl+F.
  it('finds hits in blocks the view buffer has evicted', async () => {
    const lines = transcriptLines();
    const loaded = feedOf(lines);
    const oldestLoadedSeq = Math.min(...loaded.map((b) => b.seq));
    expect(oldestLoadedSeq).toBeGreaterThan(1); // i.e. something WAS evicted

    const r = await search([{ sessionId: 's1', file: SESSION_TRANSCRIPT, loaded }], {
      sessionIds: ['s1'],
      query: { term: 'transcript' },
      limit: 5000,
    });

    expect(r.error).toBeUndefined();
    expect(r.groups[0].searched).toBe(true);
    expect(r.groups[0].aligned).toBe(true);

    const evicted = r.hits.filter((h) => h.blockIndex < oldestLoadedSeq);
    // Not "at least one": ~37% of this session's blocks are out of reach, so a
    // regression that quietly searched only the loaded tail would still satisfy
    // a `> 0` and is the exact failure this test exists to catch.
    expect(evicted.length).toBeGreaterThan(50);
    console.log(
      `[E17-01] "transcript": ${r.total} matches, ${evicted.length} of them in blocks ` +
        `the Feed has evicted (oldest loaded seq ${oldestLoadedSeq} of ${r.groups[0].blocks})`
    );
    for (const h of evicted) {
      // readable...
      expect(h.snippet.toLowerCase()).toContain('transcript');
      // ...but explicitly not jump-to-able: the recorded v1 boundary
      expect(h.earlierThanLoaded).toBe(true);
      expect(h.seq).toBeUndefined();
      expect(loaded.some((b) => b.seq === h.blockIndex)).toBe(false);
    }
  });

  it("resolves a still-loaded hit to the seq the Feed renders", async () => {
    const lines = transcriptLines();
    const loaded = feedOf(lines);
    const r = await search([{ sessionId: 's1', file: SESSION_TRANSCRIPT, loaded }], {
      sessionIds: ['s1'],
      query: { term: 'transcript' },
      limit: 5000,
    });
    const inView = r.hits.filter((h) => h.seq !== undefined);
    expect(inView.length).toBeGreaterThan(0);
    for (const h of inView) {
      expect(h.earlierThanLoaded).toBe(false);
      // The file ordinal and the Feed's seq are the same number for a
      // transcript-derived session, and this is what asserts it rather than
      // assuming it.
      expect(h.seq).toBe(h.blockIndex);
      const block = loaded.find((b) => b.seq === h.seq);
      expect(block).toBeDefined();
      expect(block?.kind).toBe(h.kind);
    }
  });

  // The reason the scan is chunked: this thread pumps every terminal in the
  // window. The numbers this run measures go in the item's hand-off.
  it('never holds the main thread for long enough to stall a PTY', async () => {
    const r = await search([{ sessionId: 's1', file: SESSION_TRANSCRIPT }], {
      sessionIds: ['s1'],
      query: { term: 'switchboard' },
      limit: 5000,
    });
    expect(r.groups[0].blocks).toBe(SESSION_TRANSCRIPT_FACTS.blocks);
    // Generous against a loaded CI runner; the observed value on the dev
    // machine is ~3ms, against a 100ms watcher poll and a terminal that reads
    // whenever the loop turns.
    expect(r.longestBlockMs).toBeLessThan(50);
    console.log(
      `[E17-01] 7.7MB / ${SESSION_TRANSCRIPT_FACTS.lines} lines: elapsed=${r.elapsedMs}ms ` +
        `longest uninterrupted=${r.longestBlockMs}ms hits=${r.total}`
    );
  });

  // The claim above is only worth anything if the DEFAULT yield really hands
  // the loop back — a timer firing during the scan is the closest a unit test
  // gets to "the terminal kept reading". The watcher's own poll is a 100ms
  // interval on this same loop.
  it('lets the event loop run while it scans', async () => {
    let ticks = 0;
    const timer = setInterval(() => ticks++, 1);
    try {
      await search([{ sessionId: 's1', file: SESSION_TRANSCRIPT }], {
        sessionIds: ['s1'],
        query: { term: 'switchboard' },
        limit: 1,
      });
    } finally {
      clearInterval(timer);
    }
    expect(ticks).toBeGreaterThanOrEqual(3);
  });

  it('yields to the event loop between chunks', async () => {
    let yields = 0;
    await search([{ sessionId: 's1', file: SESSION_TRANSCRIPT }], {
      sessionIds: ['s1'],
      query: { term: 'switchboard' },
      limit: 1,
    }, { chunkBytes: 64 * 1024, onChunk: () => { yields++; } });
    // 7.7MB at 64KB a chunk — the exact count is the file's business, that
    // there are many of them is the engine's.
    expect(yields).toBeGreaterThan(50);
  });
});

describe('what it matches', () => {
  it('is case-insensitive by default and case-sensitive on request', async () => {
    const file = transcript('case.jsonl', [say('Switchboard and switchboard and SWITCHBOARD')]);
    const t = [{ sessionId: 's', file }];
    expect((await search(t, { sessionIds: ['s'], query: { term: 'switchboard' } })).total).toBe(3);
    expect(
      (await search(t, { sessionIds: ['s'], query: { term: 'switchboard', caseSensitive: true } }))
        .total
    ).toBe(1);
  });

  it('honours whole-word, including for a term that starts with punctuation', async () => {
    const file = transcript('word.jsonl', [say('config configuration reconfigure --force enforce')]);
    const t = [{ sessionId: 's', file }];
    expect((await search(t, { sessionIds: ['s'], query: { term: 'config' } })).total).toBe(3);
    expect(
      (await search(t, { sessionIds: ['s'], query: { term: 'config', wholeWord: true } })).total
    ).toBe(1);
    // `\b` would anchor against the SPACE before the dash and refuse this;
    // lookarounds say the thing the option promises.
    expect(
      (await search(t, { sessionIds: ['s'], query: { term: '--force', wholeWord: true } })).total
    ).toBe(1);
  });

  it('treats a literal term as literal, not as a pattern', async () => {
    const file = transcript('literal.jsonl', [say('a.b and axb')]);
    const t = [{ sessionId: 's', file }];
    expect((await search(t, { sessionIds: ['s'], query: { term: 'a.b' } })).total).toBe(1);
    expect((await search(t, { sessionIds: ['s'], query: { term: 'a.b', regex: true } })).total).toBe(
      2
    );
  });

  it('reports an uncompilable regex as a bad pattern instead of throwing', async () => {
    const file = transcript('bad.jsonl', [say('anything')]);
    const r = await search([{ sessionId: 's', file }], {
      sessionIds: ['s'],
      query: { term: '(unclosed', regex: true },
    });
    expect(r.error?.code).toBe('bad-pattern');
    expect(r.error?.message).toBeTruthy();
    expect(r.hits).toEqual([]);
    expect(r.total).toBe(0);
  });

  // MEASURED BEFORE THIS GUARD EXISTED: `(a+)+$` against 60 characters held the
  // main thread for 146 SECONDS — every terminal, the watcher's poll and the UI
  // dead for the duration. No chunking helps; it is one `exec`. So the shape is
  // refused before it is compiled. The header says why this is a guard rail and
  // not a proof, and what the real fix is.
  it('refuses a pattern that would backtrack for minutes, in milliseconds', async () => {
    const file = transcript('redos.jsonl', [say('a'.repeat(60) + '!')]);
    const t0 = Date.now();
    const r = await search([{ sessionId: 's', file }], {
      sessionIds: ['s'],
      query: { term: '(a+)+$', regex: true },
    });
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(r.error?.code).toBe('bad-pattern');
    expect(r.error?.message).toContain('repeat inside a repeat');
  });

  it('refuses the shape, not every group with a quantifier on it', () => {
    for (const bad of ['(a+)+', '(a*)*', '(\\s*)+', '([a-z]+){2,}', '(x(y+))+', '(a?)+']) {
      expect(unsafeRegexShape(bad), bad).toBe(true);
    }
    // `(foo|bar)+` is an ordinary pattern and blows up only when the branches
    // OVERLAP, which needs a real analysis. Refusing every quantified
    // alternation would reject far more working patterns than it protects.
    for (const ok of ['(foo|bar)+', '(abc)+', 'a+b+', '\\(a+\\)+', '[(]a+[)]+', '(?:err|warn)+']) {
      expect(unsafeRegexShape(ok), ok).toBe(false);
    }
  });

  it('answers partially rather than running for ever', async () => {
    const file = transcript(
      'slow.jsonl',
      Array.from({ length: 200 }, (_, i) => say(`REPEATED text ${i}`))
    );
    // A deadline of zero expires on the first check, which is the only way to
    // drive this deterministically — a real one is 3s against a 45ms scan.
    const r = await search(
      [{ sessionId: 's', file }],
      { sessionIds: ['s'], query: { term: 'REPEATED' } },
      { deadlineMs: 0, chunkBytes: 512 }
    );
    expect(r.error?.code).toBe('timed-out');
    expect(r.groups[0].blocks).toBeLessThan(200); // it really did stop early
  });

  it('does not spin on a pattern that can match nothing', async () => {
    const file = transcript('zero.jsonl', [say('yyy')]);
    const r = await search([{ sessionId: 's', file }], {
      sessionIds: ['s'],
      query: { term: 'x*', regex: true },
    });
    // Every position can match empty; none of them counts as a hit.
    expect(r.total).toBe(0);
    expect(r.error).toBeUndefined();
  });

  it('finds nothing, quietly, for an empty term', async () => {
    const file = transcript('empty-term.jsonl', [say('plenty here')]);
    const r = await search([{ sessionId: 's', file }], { sessionIds: ['s'], query: { term: '' } });
    expect(r.hits).toEqual([]);
    expect(r.error).toBeUndefined();
  });

  it('locates the match inside the snippet it returns', async () => {
    const file = transcript('snippet.jsonl', [say('x'.repeat(400) + 'NEEDLE' + 'y'.repeat(400))]);
    const r = await search([{ sessionId: 's', file }], {
      sessionIds: ['s'],
      query: { term: 'NEEDLE' },
    });
    const hit = r.hits[0];
    expect(hit.snippet.slice(hit.matchStart, hit.matchStart + hit.matchLength)).toBe('NEEDLE');
    expect(hit.snippet.startsWith('…')).toBe(true);
    expect(hit.snippet.endsWith('…')).toBe(true);
  });
});

describe('what it searches', () => {
  // §5.31: "it searches everything, including what the view is hiding".
  // DETAIL_CAP is the sharpest case — `quiet` verbosity hides tool output, and
  // tool output is exactly where an error string lives.
  it('sees past DETAIL_CAP into tool output the Feed truncates', async () => {
    const filler = 'x'.repeat(DETAIL_CAP + 500);
    const entries = [
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'npm test' } }],
        },
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tu1', content: filler + 'ENOENT-marker' }],
        },
      },
    ];
    const file = transcript('deep-out.jsonl', entries);

    // What the FEED holds does not contain it — that is the lie a DOM search
    // would tell, one layer down.
    const displayed = deriveIntents(entries[1] as Record<string, unknown>)[0];
    expect(displayed.t).toBe('tool-result');
    expect(displayed.t === 'tool-result' && displayed.out).not.toContain('ENOENT-marker');

    const r = await search([{ sessionId: 's', file }], {
      sessionIds: ['s'],
      query: { term: 'ENOENT-marker' },
    });
    expect(r.total).toBe(1);
    expect(r.hits[0].field).toBe('tool.out');
    expect(r.hits[0].kind).toBe('tool');
    // ...and it is anchored to the TOOL block, not to the user line that
    // carried the result — the block the Feed renders that output inside.
    expect(r.hits[0].blockIndex).toBe(1);
  });

  it('searches a tool call by what the user reads, not by its JSON escapes', async () => {
    const file = transcript('paths.jsonl', [
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'tu2',
              name: 'Read',
              input: { file_path: 'C:\\Projects\\switchboard\\src\\main\\index.ts' },
            },
          ],
        },
      },
    ]);
    // `tool.detail` is `JSON.stringify`d, so every one of these backslashes is
    // doubled in it. Searching the JSON would find nothing on the platform this
    // app is developed on.
    const r = await search([{ sessionId: 's', file }], {
      sessionIds: ['s'],
      query: { term: 'C:\\Projects\\switchboard' },
    });
    expect(r.total).toBe(1);
    expect(r.hits[0].field).toBe('tool.input');
  });

  // The engine skips building the text of a line whose RAW JSON cannot contain
  // the term, which is most of the file and most of the cost. A false negative
  // there would be invisible: fewer results, no error, no way to tell. Regex
  // mode takes the slow path by construction, so running the same term both
  // ways over a real transcript is a differential test of the fast one.
  it('the fast path finds exactly what the slow path finds', async () => {
    const target = [{ sessionId: 's', file: SESSION_TRANSCRIPT }];
    // Terms DRAWN FROM THE FIXTURE rather than hand-picked, so the set includes
    // the characters that decide whether the prefilter may be used at all —
    // backslashes, quotes, newlines, non-ASCII — instead of the ones a person
    // thinks to type. Deterministic, so a failure is reproducible.
    // Prose and the structured edit fields — DECODED values, which is what the
    // engine searches. Deliberately not `tool.detail`: that is the JSON text,
    // and a substring of it (`l -1",\n  "descri`) is a thing no user could ever
    // be looking for, which the first draft of this test proved by drawing one.
    const texts = feedOf(transcriptLines())
      .map((b) => b.text ?? b.tool?.newString ?? b.tool?.oldString ?? '')
      .filter((t) => t.length > 200);
    expect(texts.length).toBeGreaterThan(50);
    let seed = 20260811;
    const rand = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const terms = ['transcript', 'Session', 'npm run'];
    for (let i = 0; i < 16; i++) {
      const t = texts[rand(texts.length)];
      const at = rand(Math.max(1, t.length - 40));
      terms.push(t.slice(at, at + 12 + rand(20)));
    }
    for (const term of terms) {
      if (!term.trim()) continue;
      const fast = await search(target, { sessionIds: ['s'], query: { term }, limit: 1 });
      const slow = await search(target, {
        sessionIds: ['s'],
        // the slow path is the regex one, so the term has to be neutralised
        query: { term: term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), regex: true },
        limit: 1,
      });
      expect(fast.total, `term=${JSON.stringify(term)}`).toBe(slow.total);
      expect(fast.total, `term=${JSON.stringify(term)}`).toBeGreaterThan(0);
    }
  }, 60_000);

  it('finds a term that the raw-line prefilter cannot be used for', async () => {
    // A quote and a newline are both escaped in the JSONL, so the fast path
    // must switch itself off rather than miss the hit.
    const file = transcript('escapes.jsonl', [say('he said "halt" and\nthen stopped')]);
    const t = [{ sessionId: 's', file }];
    expect((await search(t, { sessionIds: ['s'], query: { term: '"halt"' } })).total).toBe(1);
    expect((await search(t, { sessionIds: ['s'], query: { term: 'and\nthen' } })).total).toBe(1);
  });

  it('searches thinking and todo blocks, which the view folds away', async () => {
    const file = transcript('hidden.jsonl', [
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'the ORACLE said no' },
            {
              type: 'tool_use',
              id: 'tw',
              name: 'TodoWrite',
              input: { todos: [{ content: 'ship the ORACLE', status: 'pending' }] },
            },
          ],
        },
      },
    ]);
    const r = await search([{ sessionId: 's', file }], {
      sessionIds: ['s'],
      query: { term: 'ORACLE' },
    });
    expect(r.total).toBe(2);
    expect(r.hits.map((h) => h.kind).sort()).toEqual(['thinking', 'todos']);
  });

  it('skips a malformed line without losing the blocks around it', async () => {
    const file = path.join(tmp, 'malformed.jsonl');
    fs.writeFileSync(
      file,
      [JSON.stringify(say('before')), '{not json at all', JSON.stringify(say('after MARKER'))].join(
        '\n'
      ) + '\n'
    );
    const r = await search([{ sessionId: 's', file }], {
      sessionIds: ['s'],
      query: { term: 'MARKER' },
    });
    expect(r.total).toBe(1);
    // two good lines, two blocks — the bad one derived none, in the file and in
    // the Feed alike, so the ordinals stay in step
    expect(r.groups[0].blocks).toBe(2);
    expect(r.hits[0].blockIndex).toBe(2);
  });
});

describe('a session with nothing to search', () => {
  it('returns empty for a session with no transcript, and does not error', async () => {
    const r = await search([{ sessionId: 's', file: null }], {
      sessionIds: ['s'],
      query: { term: 'anything' },
    });
    expect(r.hits).toEqual([]);
    expect(r.total).toBe(0);
    expect(r.error).toBeUndefined();
    expect(r.groups).toEqual([
      { sessionId: 's', hits: 0, blocks: 0, searched: false, aligned: false },
    ]);
  });

  it('returns empty for a transcript that is not there any more', async () => {
    const r = await search([{ sessionId: 's', file: path.join(tmp, 'gone.jsonl') }], {
      sessionIds: ['s'],
      query: { term: 'anything' },
    });
    expect(r.groups[0].searched).toBe(false);
    expect(r.error).toBeUndefined();
  });

  it('returns empty for an empty file', async () => {
    const file = path.join(tmp, 'blank.jsonl');
    fs.writeFileSync(file, '');
    const r = await search([{ sessionId: 's', file }], {
      sessionIds: ['s'],
      query: { term: 'anything' },
    });
    expect(r.groups[0]).toMatchObject({ searched: true, blocks: 0, hits: 0 });
  });
});

describe('a transcript being written right now', () => {
  it('picks up a line appended mid-scan, exactly once', async () => {
    // Big enough to take many chunks, so the append lands well before EOF is
    // reached and the scan has to notice the file grew under it.
    const bulk = Array.from({ length: 400 }, (_, i) => say(`filler line ${i} ${'z'.repeat(200)}`));
    const file = transcript('growing.jsonl', bulk);

    let appended = false;
    const r = await search(
      [{ sessionId: 's', file }],
      { sessionIds: ['s'], query: { term: 'LATE-ARRIVAL' } },
      {
        chunkBytes: 4096,
        onChunk: () => {
          if (appended) return;
          appended = true;
          fs.appendFileSync(file, JSON.stringify(say('a LATE-ARRIVAL to the party')) + '\n');
        },
      }
    );
    expect(appended).toBe(true);
    // Not missed...
    expect(r.total).toBe(1);
    // ...and not counted twice, which is what a re-stat-and-reread would do.
    expect(r.hits).toHaveLength(1);
    expect(r.groups[0].blocks).toBe(bulk.length + 1);
  });

  it('ignores a half-written trailing line until it is complete', async () => {
    const file = path.join(tmp, 'partial.jsonl');
    const whole = JSON.stringify(say('first HALFWAY line'));
    const half = JSON.stringify(say('second HALFWAY line')).slice(0, 40);
    fs.writeFileSync(file, whole + '\n' + half);

    const before = await search([{ sessionId: 's', file }], {
      sessionIds: ['s'],
      query: { term: 'HALFWAY' },
    });
    expect(before.total).toBe(1);
    expect(before.groups[0].blocks).toBe(1);

    // the writer finishes the record
    fs.appendFileSync(file, JSON.stringify(say('second HALFWAY line')).slice(40) + '\n');
    const after = await search([{ sessionId: 's', file }], {
      sessionIds: ['s'],
      query: { term: 'HALFWAY' },
    });
    expect(after.total).toBe(2);
    expect(after.groups[0].blocks).toBe(2);
  });

  it('reads a multi-byte character split across a chunk boundary', async () => {
    // A chunk boundary lands wherever the writer flushed; decoding each chunk
    // on its own turns the character straddling it into replacement characters
    // and silently changes the text being searched (#194's lesson).
    const pad = 'a'.repeat(300);
    const file = transcript('utf8.jsonl', [say(`${pad}— naïve 日本語 —${pad}`)]);
    for (const chunkBytes of [16, 17, 32, 64, 128]) {
      const r = await search(
        [{ sessionId: 's', file }],
        { sessionIds: ['s'], query: { term: 'naïve 日本語' } },
        { chunkBytes }
      );
      expect(r.total, `chunkBytes=${chunkBytes}`).toBe(1);
    }
  });
});

describe('scope is a parameter', () => {
  it('searches a list of sessions and reports them separately', async () => {
    const a = transcript('scope-a.jsonl', [say('alpha SHARED'), say('alpha SHARED again')]);
    const b = transcript('scope-b.jsonl', [say('beta SHARED')]);
    const r = await search(
      [
        { sessionId: 'a', file: a },
        { sessionId: 'b', file: b },
      ],
      { sessionIds: ['a', 'b'], query: { term: 'SHARED' } }
    );
    expect(r.total).toBe(3);
    expect(r.groups.map((g) => [g.sessionId, g.hits])).toEqual([
      ['a', 2],
      ['b', 1],
    ]);
    expect(new Set(r.hits.map((h) => h.sessionId))).toEqual(new Set(['a', 'b']));
  });

  it('caps the hits it returns but still counts what it found', async () => {
    const file = transcript(
      'many.jsonl',
      Array.from({ length: 50 }, (_, i) => say(`REPEATED ${i}`))
    );
    const r = await search(
      [{ sessionId: 's', file }],
      { sessionIds: ['s'], query: { term: 'REPEATED' }, limit: 10 },
      { limit: 10 }
    );
    expect(r.hits).toHaveLength(10);
    expect(r.total).toBe(50);
    expect(r.truncated).toBe(true);
  });
});

describe('lining the file up with the view buffer', () => {
  it('ignores subagent blocks when aligning, since they are not in this file', () => {
    // `mainIndex` is the ordinal the alignment counts in — sidechain blocks are
    // not in this trail, so it can run ahead of nothing here and simply equals
    // the file ordinal.
    const trail = [
      { index: 8, mainIndex: 8, kind: 'assistant' as const, ts: 't8' },
      { index: 9, mainIndex: 9, kind: 'user' as const, ts: 't9' },
      { index: 10, mainIndex: 10, kind: 'assistant' as const, ts: 't10' },
    ];
    const loaded: FeedBlock[] = [
      { seq: 40, kind: 'assistant', ts: 't8', sidechain: false },
      {
        seq: 41,
        kind: 'tool',
        ts: 'tx',
        sidechain: true,
        tool: { name: 'Bash', category: 'shell', summary: '' },
      },
      { seq: 42, kind: 'user', ts: 't9', sidechain: false },
      { seq: 43, kind: 'assistant', ts: 't10', sidechain: false },
    ];
    const a = alignToLoaded(trail, loaded);
    expect(a).not.toBeNull();
    expect(a?.firstLoadedIndex).toBe(8);
    expect(a?.loadedMain.map((b) => b.seq)).toEqual([40, 42, 43]);
  });

  it('refuses to align against a Feed whose newest block is not in this file', async () => {
    const file = transcript('mine.jsonl', [say('one TARGET', 't1'), say('two TARGET', 't2')]);
    const other = feedOf([JSON.stringify(say('a wholly different conversation', 't9'))]);
    const r = await search([{ sessionId: 's', file, loaded: other }], {
      sessionIds: ['s'],
      query: { term: 'TARGET' },
    });
    expect(r.groups[0].aligned).toBe(false);
    // Snippet-only rather than a plausible-looking wrong seq: scrolling the
    // Feed to the wrong block is the same class of lie as searching the DOM.
    for (const h of r.hits) {
      expect(h.seq).toBeUndefined();
      // ...and it does NOT claim they are earlier in the session either. We do
      // not know where they are; "earlier" would be a guess with a confident
      // face on it, and the missing `seq` is already the signal E17-02 reads.
      expect(h.earlierThanLoaded).toBe(false);
    }
  });

  // THE BUG THIS FIXTURE CANNOT SEE. The bound transcript can carry its own
  // `isSidechain: true` lines (`watcher.ts` marks a block sidechain when the
  // LINE says so, or when it came from a subagent file), and the watcher gives
  // those a `seq` like any other while the Feed keeps them apart. Counting them
  // in the same ordinal the alignment arithmetic uses shifts every mapping past
  // the first one — a click that scrolls to the wrong block. The captured
  // transcript has 3,531 `isSidechain` fields and not one of them is `true`, so
  // only a hand-built file pins this.
  it('counts the bound file’s own sidechain lines apart from the main ones', async () => {
    const lines = [
      say('B1 TARGET', 't1'),
      say('B2 TARGET', 't2'),
      { ...(say('B3 TARGET', 't3') as object), isSidechain: true },
      say('B4 TARGET', 't4'),
      say('B5 TARGET', 't5'),
    ];
    const file = transcript('sidechain.jsonl', lines);

    // What the watcher would be holding: same derivation, sidechain flag and
    // all, with the last three blocks in the window.
    const feed = new FeedBuffer(() => {}, 3);
    const all = lines.map((l, i) =>
      feed.push(
        { kind: 'assistant', text: `B${i + 1} TARGET`, ts: `t${i + 1}` },
        (l as { isSidechain?: boolean }).isSidechain === true
      )
    );
    expect(all.map((b) => b.seq)).toEqual([1, 2, 3, 4, 5]);
    const loaded = feed.list(); // seqs 3,4,5 — one of them sidechain

    const r = await search([{ sessionId: 's', file, loaded }], {
      sessionIds: ['s'],
      query: { term: 'TARGET' },
    });

    expect(r.groups[0].aligned).toBe(true);
    // Every resolved hit must point at the block that really holds its text.
    const byIndex = new Map(r.hits.map((h) => [h.blockIndex, h]));
    for (const [index, h] of byIndex) {
      if (h.seq === undefined) continue;
      const block = loaded.find((b) => b.seq === h.seq);
      expect(block?.text, `file block ${index} resolved to seq ${h.seq}`).toBe(`B${index} TARGET`);
    }
    // ...and the sidechain block itself resolves to nothing rather than to a
    // neighbour: which loaded sidechain block it is depends on subagent files
    // this scan never read.
    expect(byIndex.get(3)?.seq).toBeUndefined();
    expect(byIndex.get(4)?.seq).toBe(4);
    expect(byIndex.get(5)?.seq).toBe(5);
  });

  it('aligns when the watcher is a few lines behind the file', async () => {
    // The everyday runtime case: the scan reads to EOF, the watcher's last poll
    // did not. The loaded window is then a strict prefix-shifted subset and the
    // newest file blocks have no seq — without claiming to be old.
    const lines = Array.from({ length: 12 }, (_, i) => say(`line ${i + 1} TARGET`, `t${i + 1}`));
    const file = transcript('behind.jsonl', lines);
    const loaded = feedOf(lines.slice(0, 9).map((l) => JSON.stringify(l))).slice(-4); // blocks 6..9

    const r = await search([{ sessionId: 's', file, loaded }], {
      sessionIds: ['s'],
      query: { term: 'TARGET' },
    });

    expect(r.groups[0].aligned).toBe(true);
    const seqOf = new Map(r.hits.map((h) => [h.blockIndex, h.seq]));
    expect(seqOf.get(6)).toBe(6);
    expect(seqOf.get(9)).toBe(9);
    expect(seqOf.get(5)).toBeUndefined(); // evicted...
    expect(r.hits.find((h) => h.blockIndex === 5)?.earlierThanLoaded).toBe(true);
    expect(seqOf.get(12)).toBeUndefined(); // ...and not yet drained
    expect(r.hits.find((h) => h.blockIndex === 12)?.earlierThanLoaded).toBe(false);
  });

  it('refuses when more than one block in the file could be the one on screen', async () => {
    // Two indistinguishable blocks (same kind, no timestamp) and a one-block
    // view: "it matched" carries no information, and the two answers are a
    // block apart. Untimestamped transcript lines are rare, which is exactly
    // why the ambiguity has to be refused rather than resolved by position.
    const file = transcript('twins.jsonl', [say('one TARGET'), say('two TARGET')]);
    const r = await search(
      [{ sessionId: 's', file, loaded: feedOf([JSON.stringify(say('two TARGET'))]) }],
      { sessionIds: ['s'], query: { term: 'TARGET' } }
    );
    expect(r.groups[0].aligned).toBe(false);
  });

  it('leaves every hit snippet-only when the renderer holds nothing', async () => {
    const file = transcript('unloaded.jsonl', [say('a TARGET here')]);
    const r = await search([{ sessionId: 's', file, loaded: [] }], {
      sessionIds: ['s'],
      query: { term: 'TARGET' },
    });
    expect(r.groups[0].aligned).toBe(false);
    expect(r.hits[0].seq).toBeUndefined();
  });
});

describe('compileMatcher', () => {
  it('answers with a matcher, with nothing, or with a reason — never a throw', () => {
    expect(compileMatcher({ term: 'x' }).re).toBeInstanceOf(RegExp);
    expect(compileMatcher({ term: '' }).re).toBeNull();
    expect(compileMatcher({ term: '' }).error).toBeUndefined();
    const bad = compileMatcher({ term: '[', regex: true });
    expect(bad.re).toBeNull();
    expect(bad.error?.code).toBe('bad-pattern');
  });
});
