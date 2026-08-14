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
import { BLOCK_CAP, DETAIL_CAP, FeedBlock, TEXT_CAP, deriveIntents } from '../feed/blocks';
import { FeedBuffer } from '../feed/buffer';
import { StreamFeed } from '../feed/stream-feed';
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

// ---------------------------------------------------------------------------
// #458 — lining a DIRECT session up, where the shape match cannot.
//
// The gap this closes, in one sentence: a Direct session's Feed is built from
// the stream, whose blocks are stamped with the moment the message reached us,
// so `alignByShape` — which reads the FILE's timestamps back off the rendered
// blocks — never matched a single one of them, and §5.31's flagship gesture was
// dead on the app's default transport since #381.
//
// Every test below runs the REAL `StreamFeed` over the REAL messages, rather
// than hand-building blocks that would only prove the assertion I wrote.
// ---------------------------------------------------------------------------
describe('lining a Direct session up (#458)', () => {
  /**
   * What the FEED holds for a session the STREAM built.
   *
   * The conversion is the one the Claude Code VS Code extension performs in its
   * own transcript→stream path (read out of the bundle 2026-08-13, per the
   * standing rule): `message` is passed through VERBATIM and everything the FILE
   * wrapped it in — timestamp, uuid, cwd, isSidechain — is dropped. That is what
   * makes this a fair stand-in for the transport rather than a copy of the file
   * path with a different name.
   *
   * `isMeta` lines are skipped, which is the one ASSUMPTION here: they are the
   * CLI's own bookkeeping rather than conversation, and `deriveIntents` refuses
   * them before it looks at anything else. If a real CLI turned out to stream
   * them, the alignment would REFUSE (see `shapeAgrees`) and every hit would
   * come back snippet-only — i.e. it would fail back to the behaviour this item
   * replaced, never to a wrong jump.
   */
  function streamFeedOf(lines: string[]): FeedBlock[] {
    const sf = new StreamFeed();
    for (const line of lines) {
      let e: Record<string, unknown>;
      try {
        e = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (e.isMeta === true) continue;
      if (e.type !== 'assistant' && e.type !== 'user') continue;
      sf.offer('s', { type: e.type, message: e.message, parent_tool_use_id: null });
    }
    return sf.blocks('s');
  }

  /** An assistant turn with the id the API gives every one of them. */
  const said = (id: string, text: string, ts?: string): unknown => ({
    type: 'assistant',
    ...(ts ? { timestamp: ts } : {}),
    message: { role: 'assistant', id, content: [{ type: 'text', text }] },
  });

  /** A tool call — the one block whose id is unique across the conversation. */
  const called = (id: string, name: string, summary: string, ts?: string): unknown => ({
    type: 'assistant',
    ...(ts ? { timestamp: ts } : {}),
    message: {
      role: 'assistant',
      id: `msg_for_${id}`,
      content: [{ type: 'tool_use', id, name, input: { command: summary } }],
    },
  });

  const ask = (text: string, ts?: string): unknown => ({
    type: 'user',
    ...(ts ? { timestamp: ts } : {}),
    message: { role: 'user', content: text },
  });

  // THE POINT OF THE ITEM, over the real captured transcript: a Direct session
  // whose Feed the stream built, every block of it stamped with a time that is
  // nowhere in the file, and the hits still resolve to the seq the renderer is
  // showing — including the arithmetic that says which ones are too far back.
  it('resolves hits to the seq a stream-built Feed is showing', async () => {
    const lines = transcriptLines();
    const loaded = streamFeedOf(lines);
    expect(loaded).toHaveLength(BLOCK_CAP); // the same eviction as the file path

    // The premise, asserted rather than assumed: not one rendered timestamp is
    // a timestamp from the file, which is why `alignByShape` cannot help here.
    const fileStamps = new Set(
      lines.map((l) => (JSON.parse(l) as { timestamp?: string }).timestamp).filter(Boolean)
    );
    // Every block IS stamped, and no stamp is one of the file's — so `same()`'s
    // `a.ts === b.ts` is false at every position and the shape match is dead on
    // arrival. This is what makes the assertions below non-vacuous.
    expect(loaded.every((b) => typeof b.ts === 'string' && !fileStamps.has(b.ts))).toBe(true);

    const r = await search([{ sessionId: 's1', file: SESSION_TRANSCRIPT, loaded }], {
      sessionIds: ['s1'],
      query: { term: 'transcript' },
      limit: 5000,
    });

    expect(r.error).toBeUndefined();
    expect(r.groups[0].aligned).toBe(true);

    const jumpable = r.hits.filter((h) => typeof h.seq === 'number');
    expect(jumpable.length).toBeGreaterThan(0);
    // Every seq it hands out is a block the renderer actually holds...
    const held = new Map(loaded.map((b) => [b.seq, b]));
    let proved = 0;
    for (const h of jumpable) {
      const block = held.get(h.seq as number);
      expect(block).toBeDefined();
      expect(block?.kind).toBe(h.kind);
      expect(h.earlierThanLoaded).toBe(false);
      // ...and it is the RIGHT one. Kind alone is far too weak to say that on a
      // real feed: kinds repeat constantly, so a systematic off-by-a-few would
      // survive it at most positions. For a prose hit the block's own TEXT has
      // to contain the term, which nothing but the correct block does.
      //
      // Note what this test can NOT pin, so nobody reads more into it than is
      // there: in this fixture the stream Feed's `seq` happens to equal the
      // file's ordinal (no sidechain lines, one derivation, so both run 580 to
      // 1,579), which means an implementation that ignored the offset
      // arithmetic and returned `mainIndex` would satisfy every assertion here.
      // The offset itself is pinned by the small-window cases below, where the
      // view starts partway into the file and the two numbers differ.
      //
      // Blocks AT the cap are skipped: the Feed truncates prose at `TEXT_CAP`
      // and the engine deliberately does not (§5.31 — find sees what the view is
      // hiding), so a match past the cap is genuinely absent from what the
      // renderer holds. (`h.matchStart` cannot answer this — it is an offset
      // into the snippet, not into the block.)
      const text = block?.text;
      if (h.field === 'text' && text !== undefined && text.length < TEXT_CAP) {
        expect(text.toLowerCase()).toContain('transcript');
        proved++;
      }
    }
    // …and that stronger check actually ran, on a real sample rather than on
    // the one hit that happened to qualify. Observed on this fixture: 16.
    expect(proved).toBeGreaterThanOrEqual(15);
    // ...and the ones it will not jump to are exactly the evicted ones, still
    // readable in the list. That boundary is §5.31's, and it stays.
    const listOnly = r.hits.filter((h) => h.seq === undefined);
    expect(listOnly.length).toBeGreaterThan(0);
    expect(listOnly.every((h) => h.earlierThanLoaded)).toBe(true);
  });

  it('lands a hit on the block a stream-built Feed rendered for it', async () => {
    const entries = [
      ask('find me the NEEDLE', 'f1'),
      said('msg_a', 'looking for it', 'f2'),
      called('toolu_1', 'Bash', 'grep NEEDLE .', 'f3'),
      said('msg_b', 'the NEEDLE is in the haystack', 'f4'),
    ];
    const file = transcript('direct.jsonl', entries);
    const loaded = streamFeedOf(entries.map((e) => JSON.stringify(e)));

    const r = await search([{ sessionId: 's', file, loaded }], {
      sessionIds: ['s'],
      query: { term: 'NEEDLE' },
    });

    expect(r.groups[0].aligned).toBe(true);
    // The whole window maps, not just the block that carried the anchoring id:
    // the user's prompt has no id of its own and is still jumpable.
    const prompt = r.hits.find((h) => h.kind === 'user');
    expect(loaded.find((b) => b.seq === prompt?.seq)?.text).toBe('find me the NEEDLE');
    const answer = r.hits.find((h) => h.kind === 'assistant' && h.field === 'text');
    expect(loaded.find((b) => b.seq === answer?.seq)?.text).toContain('haystack');
  });

  it('lands on the message id alone, for a session that has called no tool', async () => {
    const entries = [ask('hello', 'f1'), said('msg_a', 'a NEEDLE in prose', 'f2')];
    const file = transcript('prose-only.jsonl', entries);
    const loaded = streamFeedOf(entries.map((e) => JSON.stringify(e)));

    const r = await search([{ sessionId: 's', file, loaded }], {
      sessionIds: ['s'],
      query: { term: 'NEEDLE' },
    });

    expect(r.groups[0].aligned).toBe(true);
    expect(loaded.find((b) => b.seq === r.hits[0].seq)?.text).toBe('a NEEDLE in prose');
  });

  // An id says WHERE; it does not say the two sequences are the same sequence.
  // A Feed holding a block the file does not — a turn whose tokens were never
  // written down — shifts every hit past it by one, and one wrong jump costs
  // more trust than a hundred honest refusals earn.
  it('refuses when the Feed holds a block the file does not', async () => {
    // ARRANGED SO THAT ONLY `shapeAgrees` CAN REFUSE IT, which took two goes to
    // get right and is worth writing down:
    //
    //  * the ghost must not sit BETWEEN two id-bearing blocks, or the ids on
    //    either side of it imply different offsets and the disagreement check
    //    refuses first;
    //  * the window must not start at the file's first block, or every offset
    //    comes out at 0 and the `firstLoadedIndex < 1` guard refuses first.
    //
    // So the ghost goes at the FRONT of a window that starts at file block 2,
    // where every id still agrees on an offset of 2 — and the only thing wrong
    // is that the ghost's `assistant` lands where the file says `tool`.
    const entries = [
      ask('a NEEDLE question', 'f1'),
      called('toolu_0', 'Read', 'src/x.ts', 'f2'),
      called('toolu_1', 'Bash', 'ls', 'f3'),
      said('msg_b', 'two NEEDLE', 'f4'),
      called('toolu_2', 'Grep', 'rg NEEDLE', 'f5'),
      said('msg_c', 'three', 'f6'),
    ];
    const file = transcript('extra-block.jsonl', entries);
    const loaded = streamFeedOf(
      [
        said('msg_ghost', 'a turn that was never written down'),
        entries[2],
        entries[3],
        entries[4],
        entries[5],
      ].map((e) => JSON.stringify(e))
    );
    expect(loaded).toHaveLength(5);

    const r = await search([{ sessionId: 's', file, loaded }], {
      sessionIds: ['s'],
      query: { term: 'NEEDLE' },
    });

    expect(r.groups[0].aligned).toBe(false);
    expect(r.hits.every((h) => h.seq === undefined)).toBe(true);
  });

  // ...and the SAME window without the ghost aligns. Without this, the test
  // above would pass just as well for a file shape that never lines up at all.
  it('...and lines the same window up once the ghost is gone', async () => {
    const entries = [
      ask('a NEEDLE question', 'f1'),
      called('toolu_0', 'Read', 'src/x.ts', 'f2'),
      called('toolu_1', 'Bash', 'ls', 'f3'),
      said('msg_b', 'two NEEDLE', 'f4'),
      called('toolu_2', 'Grep', 'rg NEEDLE', 'f5'),
      said('msg_c', 'three', 'f6'),
    ];
    const file = transcript('no-ghost.jsonl', entries);
    const loaded = streamFeedOf(entries.slice(1).map((e) => JSON.stringify(e)));

    const r = await search([{ sessionId: 's', file, loaded }], {
      sessionIds: ['s'],
      query: { term: 'NEEDLE' },
    });

    expect(r.groups[0].aligned).toBe(true);
    // block 4 is the third block of the window and resolves to its seq...
    const inWindow = r.hits.find((h) => h.blockIndex === 4);
    expect(loaded.find((b) => b.seq === inWindow?.seq)?.text).toBe('two NEEDLE');
    // ...while block 1, the prompt, is off the front of the view and stays
    // list-only, marked as earlier rather than silently unjumpable.
    const evicted = r.hits.find((h) => h.blockIndex === 1);
    expect(evicted?.seq).toBeUndefined();
    expect(evicted?.earlierThanLoaded).toBe(true);
  });

  it('refuses when two ids disagree about where the window starts', async () => {
    // EVERY BLOCK THE SAME KIND, so the shape check cannot be what refuses this
    // — otherwise the test passes with the disagreement check deleted, which is
    // how it was written the first time. All four are prose, so all four carry
    // a `msg:` id, and the ghost in the middle shifts the two after it.
    const entries = [
      said('msg_1', 'one NEEDLE', 'f1'),
      said('msg_2', 'two', 'f2'),
      said('msg_3', 'three NEEDLE', 'f3'),
      said('msg_4', 'four', 'f4'),
    ];
    const file = transcript('disagree.jsonl', entries);
    const loaded = streamFeedOf(
      [
        entries[0],
        entries[1],
        said('msg_ghost', 'never written down'),
        entries[2],
        entries[3],
      ].map((e) => JSON.stringify(e))
    );
    // ids before the ghost say the window starts at 1; ids after it say 0.
    expect(loaded).toHaveLength(5);

    const r = await search([{ sessionId: 's', file, loaded }], {
      sessionIds: ['s'],
      query: { term: 'NEEDLE' },
    });

    expect(r.groups[0].aligned).toBe(false);
    expect(r.hits.every((h) => h.seq === undefined)).toBe(true);
  });

  // The conservative guard, pinned so that relaxing it is a deliberate act with
  // a failing test in front of it rather than a quiet behaviour change. A view
  // holding MORE conversation at the front than the file does is a resumed
  // Direct session (#395 hydrates the previous conversation into the Feed); see
  // the note at the check in `search.ts`.
  it('refuses a window that starts before the file’s first block', async () => {
    const entries = [said('msg_2', 'two NEEDLE', 'f2'), said('msg_3', 'three', 'f3')];
    const file = transcript('resumed.jsonl', entries);
    // `msg_1` is in the view and in no file this scan can see.
    const loaded = streamFeedOf(
      [said('msg_1', 'one, from the replayed conversation'), ...entries].map((e) => JSON.stringify(e))
    );
    expect(loaded).toHaveLength(3);

    const r = await search([{ sessionId: 's', file, loaded }], {
      sessionIds: ['s'],
      query: { term: 'NEEDLE' },
    });

    expect(r.groups[0].aligned).toBe(false);
    expect(r.hits[0].seq).toBeUndefined();
  });

  // A message that produced several blocks stamps the same id on all of them.
  // "It matched" then does not say WHICH, and the answers are blocks apart.
  it('does not anchor on an id the file used more than once', async () => {
    const entries = [
      said('msg_twin', 'first half, NEEDLE', 'f1'),
      said('msg_twin', 'second half', 'f2'),
    ];
    const file = transcript('twin-ids.jsonl', entries);
    // Only the second survives in the view — so the id looks unique on screen
    // and is ambiguous in the file. Position would be a coin flip.
    const loaded = streamFeedOf([JSON.stringify(entries[1])]);

    const r = await search([{ sessionId: 's', file, loaded }], {
      sessionIds: ['s'],
      query: { term: 'NEEDLE' },
    });

    expect(r.groups[0].aligned).toBe(false);
  });

  // A TodoWrite call opens as an ordinary `tool` row on the strength of
  // `content_block_start` and only becomes a `todos` checklist when the message
  // lands. Comparing a block that is still becoming itself would refuse a good
  // alignment for as long as the model is typing — i.e. exactly while the user
  // is most likely to be searching.
  it('does not let a block still taking tokens veto the alignment', async () => {
    // The case has to be one where the FILE ALREADY HAS the line — otherwise
    // the streaming block sits past the end of the trail, `shapeAgrees` finds
    // no anchor to compare it against, and the skip is never exercised.
    //
    // So: the transcript has the TodoWrite turn written down (it derives a
    // `todos` block, no tool name), while the view still shows the `tool` row
    // that `content_block_start` opened, because the `assistant` message that
    // reveals it to be a checklist has not arrived. `todos` vs `tool` at the
    // same position is exactly the disagreement the skip exists to forgive.
    const entries = [
      ask('a NEEDLE question', 'f1'),
      called('toolu_1', 'Bash', 'ls', 'f2'),
      {
        type: 'assistant',
        timestamp: 'f3',
        message: {
          role: 'assistant',
          id: 'msg_todo',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_todo',
              name: 'TodoWrite',
              input: { todos: [{ content: 'step', status: 'pending' }] },
            },
          ],
        },
      },
    ];
    const file = transcript('mid-turn.jsonl', entries);
    const sf = new StreamFeed();
    for (const e of entries.slice(0, 2)) {
      const m = e as { type: string; message: unknown };
      sf.offer('s', { type: m.type, message: m.message, parent_tool_use_id: null });
    }
    sf.offer('s', {
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_todo', name: 'TodoWrite' },
      },
      parent_tool_use_id: null,
    });
    const loaded = sf.blocks('s');
    // the disagreement is real and present: `tool` on screen, `todos` in the file
    expect(loaded[2]).toMatchObject({ kind: 'tool', streaming: true });
    expect(loaded[2].tool?.name).toBe('TodoWrite');

    const r = await search([{ sessionId: 's', file, loaded }], {
      sessionIds: ['s'],
      query: { term: 'NEEDLE' },
    });

    expect(r.groups[0].aligned).toBe(true);
    expect(r.hits[0].seq).toBe(loaded[0].seq);
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
