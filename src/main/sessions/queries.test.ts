// The questions one session asks about another (P2-E11-01, §5.4).
//
// The transcript fixtures here are the real JSONL shape the CLI writes — the
// same one `feed/history.test.ts` uses — because the whole read path under test
// is `readTranscriptTail` -> `deriveIntents`, and a hand-rolled block would
// test this file against itself.
//
// HALF OF WHAT FOLLOWS IS NEGATIVE, deliberately. #635 shipped a bug to review
// because every case in its table was a constructed positive: it asked "does it
// handle the thing" and never "does it leave everything else alone". So the
// cases that matter most here are the ones where the RIGHT answer is empty, or
// a refusal, or an untouched value.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  DEFAULT_LAST_N,
  DIFF_CHAR_CAP,
  MAX_LAST_N,
  OUTPUT_CHAR_CAP,
  OUTPUT_FIRST_WINDOW,
  SessionQueries,
  TRIM_MARKER,
  type DiffSource,
  type QueryResult,
  type SessionSummary,
} from './queries';
import { cleanupTempDirs, tempDir } from '../../test-temp-dirs';
import { HISTORY_MAX_LINES, HISTORY_TAIL_BYTES, readTranscriptWindow } from '../feed/history';

let dir: string;

const session = (over: Partial<SessionSummary> = {}): SessionSummary => ({
  id: 'sess-1',
  name: 'TradingApp',
  folder: 'C:/Projects/TradingApp',
  providerId: 'claude-code',
  status: 'working',
  exited: false,
  ...over,
});

/** A transcript line as the CLI writes it. */
const userLine = (text: string) =>
  JSON.stringify({ type: 'user', message: { role: 'user', content: text } });
const assistantLine = (text: string) =>
  JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  });
const toolLine = (id: string, name: string, input: Record<string, unknown>) =>
  JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
  });
const toolResultLine = (id: string, out: string) =>
  JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, content: out }],
    },
  });

function writeTranscript(lines: string[]): string {
  const file = path.join(dir, 'conv.jsonl');
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

const noDiff: DiffSource = { diff: async () => ({ isRepo: false, text: '' }) };

/** Narrow a QueryResult to its value, failing the test if it refused. */
function resolved(r: QueryResult<SessionSummary>): SessionSummary {
  if (!r.ok) throw new Error(`expected a match, got refusal: ${r.reason}`);
  return r.value;
}

/** The common case: one session, one transcript, no git. */
function make(
  lines: string[],
  sessions: SessionSummary[] = [session()],
  git: DiffSource = noDiff
) {
  const file = lines.length ? writeTranscript(lines) : null;
  return new SessionQueries({
    list: () => sessions,
    transcriptFor: () => file,
    git,
  });
}

beforeEach(() => {
  dir = tempDir('sb-queries-');
});
afterEach(() => cleanupTempDirs());

describe('listSessions', () => {
  it('returns the fields a sibling addresses a session by', () => {
    const q = make([], [session(), session({ id: 'sess-2', name: 'PropaneMon' })]);
    const r = q.listSessions();
    if (!r.ok) throw new Error(r.reason);
    expect(r.value).toMatchObject([
      {
        id: 'sess-1',
        name: 'TradingApp',
        folder: 'C:/Projects/TradingApp',
        providerId: 'claude-code',
        status: 'working',
      },
      { id: 'sess-2', name: 'PropaneMon' },
    ]);
  });

  it('hands back a COPY — a caller cannot mutate the manager’s list through it', () => {
    const live = [session()];
    const q = new SessionQueries({ list: () => live, transcriptFor: () => null, git: noDiff });
    const listed = q.listSessions();
    if (!listed.ok) throw new Error(listed.reason);
    listed.value.push(session({ id: 'injected' }));
    expect(live).toHaveLength(1);
  });
});

describe('resolve', () => {
  it('finds by name, case-insensitively, and by id', () => {
    const q = make([], [session()]);
    expect(resolved(q.resolve('TradingApp')).id).toBe('sess-1');
    expect(resolved(q.resolve('tradingapp')).id).toBe('sess-1');
    expect(resolved(q.resolve('sess-1')).id).toBe('sess-1');
  });

  it('strips a leading @, so the composer can pass its token through unchanged', () => {
    expect(make([], [session()]).resolve('@TradingApp').ok).toBe(true);
  });

  it('REFUSES an ambiguous name and names every candidate rather than picking one', () => {
    const q = make(
      [],
      [session(), session({ id: 'sess-2', folder: 'C:/Projects/TradingApp-wt2' })]
    );
    const r = q.resolve('TradingApp');
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reason).toContain('ambiguous');
    // BOTH ids present: the refusal has to be actionable, and "2 matches" with
    // no way to disambiguate is a dead end dressed as an error message.
    expect(r.reason).toContain('sess-1');
    expect(r.reason).toContain('sess-2');
  });

  it('prefers an EXACT case match over a case-insensitive one instead of calling it ambiguous', () => {
    const q = make([], [session({ id: 'exact', name: 'api' }), session({ id: 'other', name: 'API' })]);
    expect(resolved(q.resolve('api')).id).toBe('exact');
  });

  it('an id wins over a name that collides with it', () => {
    const q = make(
      [],
      [session({ id: 'sess-1', name: 'Alpha' }), session({ id: 'sess-2', name: 'sess-1' })]
    );
    expect(resolved(q.resolve('sess-1')).name).toBe('Alpha');
  });

  it('refuses an unknown name and LISTS what is running, so the caller can retry', () => {
    const r = make([], [session()]).resolve('Nope');
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reason).toContain('TradingApp');
  });

  it('refuses an empty reference', () => {
    expect(make([], [session()]).resolve('   ').ok).toBe(false);
    expect(make([], [session()]).resolve('@').ok).toBe(false);
  });

  it('says so when nothing is running at all, rather than listing an empty set', () => {
    const r = make([], []).resolve('Anything');
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reason).toContain('no sessions are running');
  });
});

describe('sessionOutput', () => {
  it('renders prose and tool rows, oldest first', () => {
    const q = make([
      userLine('fix the bug'),
      assistantLine('on it'),
      toolLine('t1', 'Bash', { command: 'npm test' }),
      toolResultLine('t1', 'all green'),
    ]);
    const r = q.sessionOutput('TradingApp');
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(r.reason);
    expect(r.value.text).toContain('User: fix the bug');
    expect(r.value.text).toContain('Claude: on it');
    expect(r.value.text).toContain('[Bash]');
    // The tool RESULT is stitched onto the call it belongs to, not appended as
    // a stray block — that fold is the one piece of `FeedBuffer`'s job this
    // module reimplements, so it gets asserted rather than assumed.
    expect(r.value.text).toContain('-> all green');
    expect(r.value.text.indexOf('fix the bug')).toBeLessThan(r.value.text.indexOf('on it'));
  });

  it('a session with NO transcript answers empty and ok — not a refusal, not a throw', () => {
    const q = new SessionQueries({
      list: () => [session()],
      transcriptFor: () => null,
      git: noDiff,
    });
    const r = q.sessionOutput('TradingApp');
    if (!r.ok) throw new Error(r.reason);
    expect(r.value.session.id).toBe('sess-1');
    expect(r.value).toMatchObject({ text: '', blocks: 0, truncated: false });
  });

  it('a transcript path that does not exist answers empty — but says it is INCOMPLETE (#766)', () => {
    // The two empties above and this one look identical to a caller and are not
    // the same claim. A session with no transcript has genuinely produced
    // nothing; a session whose named transcript could not be read has produced
    // we-don't-know-what. An agent told `{text: '', truncated: false}` concludes
    // its sibling did nothing and acts on that — which is the confident wrong
    // answer this module's header exists to refuse, arriving as an empty value
    // rather than as a refusal.
    const q = new SessionQueries({
      list: () => [session()],
      transcriptFor: () => path.join(dir, 'gone.jsonl'),
      git: noDiff,
    });
    const r = q.sessionOutput('TradingApp');
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(r.reason);
    expect(r.value.text).toBe('');
    expect(r.value.truncated).toBe(true);
  });

  it('…while a transcript that exists and is EMPTY is honestly complete (#766)', () => {
    // The other half, and what stops the line above from being "always true".
    const file = path.join(dir, 'empty.jsonl');
    fs.writeFileSync(file, '');
    const q = new SessionQueries({
      list: () => [session()],
      transcriptFor: () => file,
      git: noDiff,
    });
    const r = q.sessionOutput('TradingApp');
    if (!r.ok) throw new Error(r.reason);
    expect(r.value).toMatchObject({ text: '', blocks: 0, truncated: false });
  });

  it('a transcript of pure garbage answers empty rather than throwing', () => {
    const file = path.join(dir, 'conv.jsonl');
    fs.writeFileSync(file, 'not json\n{"also":\nnope\n');
    const q = new SessionQueries({
      list: () => [session()],
      transcriptFor: () => file,
      git: noDiff,
    });
    expect(q.sessionOutput('TradingApp')).toMatchObject({ ok: true, value: { text: '', blocks: 0 } });
  });

  it('returns the LAST n blocks and reports the truncation', () => {
    const q = make(Array.from({ length: 10 }, (_, i) => assistantLine(`line ${i}`)));
    const r = q.sessionOutput('TradingApp', 3);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(r.reason);
    expect(r.value.blocks).toBe(3);
    expect(r.value.text).toContain('line 9');
    expect(r.value.text).not.toContain('line 6');
    expect(r.value.truncated).toBe(true);
  });

  it('does NOT report truncation when everything fits', () => {
    const q = make([assistantLine('a'), assistantLine('b')]);
    const r = q.sessionOutput('TradingApp', 5);
    if (!r.ok) throw new Error(r.reason);
    expect(r.value.truncated).toBe(false);
    expect(r.value.blocks).toBe(2);
  });

  it('defaults to DEFAULT_LAST_N when the caller does not say', () => {
    const q = make(Array.from({ length: DEFAULT_LAST_N + 5 }, (_, i) => assistantLine(`l${i}`)));
    const r = q.sessionOutput('TradingApp');
    if (!r.ok) throw new Error(r.reason);
    expect(r.value.blocks).toBe(DEFAULT_LAST_N);
  });

  it('CLAMPS an absurd lastN to MAX_LAST_N instead of refusing — a clumsy agent keeps working', () => {
    const q = make(Array.from({ length: MAX_LAST_N + 20 }, (_, i) => assistantLine(`l${i}`)));
    const r = q.sessionOutput('TradingApp', 1_000_000);
    if (!r.ok) throw new Error(r.reason);
    expect(r.value.blocks).toBe(MAX_LAST_N);
  });

  it('clamps a zero or negative lastN to something usable rather than returning nothing', () => {
    const q = make([assistantLine('only')]);
    for (const n of [0, -5, Number.NaN]) {
      const r = q.sessionOutput('TradingApp', n);
      if (!r.ok) throw new Error(r.reason);
      expect(r.value.blocks).toBeGreaterThan(0);
    }
  });

  it('ENFORCES the character cap — the point of the module, so it is asserted', () => {
    // One block far larger than the cap. `DISPLAY_CAPS.text` bounds each block
    // at TEXT_CAP (20k); the join of several still has to be cut to the cap.
    const q = make(Array.from({ length: 5 }, () => assistantLine('x'.repeat(19_000))));
    const r = q.sessionOutput('TradingApp', 5);
    if (!r.ok) throw new Error(r.reason);
    expect(r.value.text.length).toBe(OUTPUT_CHAR_CAP);
    expect(r.value.truncated).toBe(true);
  });

  it('refuses a bad reference without reading any transcript', () => {
    let read = 0;
    const q = new SessionQueries({
      list: () => [session()],
      transcriptFor: () => {
        read++;
        return null;
      },
      git: noDiff,
    });
    expect(q.sessionOutput('Nope').ok).toBe(false);
    expect(read).toBe(0);
  });

  it('skips CLI plumbing and meta lines rather than rendering them as conversation', () => {
    const q = make([
      JSON.stringify({ type: 'user', isMeta: true, message: { role: 'user', content: 'internal' } }),
      userLine('<local-command-stdout>noise</local-command-stdout>'),
      assistantLine('real answer'),
    ]);
    const r = q.sessionOutput('TradingApp');
    if (!r.ok) throw new Error(r.reason);
    expect(r.value.text).toContain('real answer');
    expect(r.value.text).not.toContain('internal');
  });
});

describe('sessionDiff', () => {
  it('returns the unified diff text for the session’s folder', async () => {
    const asked: string[] = [];
    const git: DiffSource = {
      diff: async (folder) => {
        asked.push(folder);
        return { isRepo: true, text: 'diff --git a/x b/x\n+added' };
      },
    };
    const r = await make([], [session()], git).sessionDiff('TradingApp');
    if (!r.ok) throw new Error(r.reason);
    expect(asked).toEqual(['C:/Projects/TradingApp']);
    expect(r.value.diff).toContain('+added');
    expect(r.value.isRepo).toBe(true);
    expect(r.value.truncated).toBe(false);
  });

  it('a folder that is not a repo answers isRepo:false and empty — not a throw', async () => {
    const r = await make([], [session()], noDiff).sessionDiff('TradingApp');
    if (!r.ok) throw new Error(r.reason);
    expect(r.value.session.id).toBe('sess-1');
    expect(r.value).toMatchObject({ isRepo: false, diff: '', truncated: false });
  });

  it('a clean tree answers ok with an empty diff, distinctly from not-a-repo', async () => {
    const git: DiffSource = { diff: async () => ({ isRepo: true, text: '' }) };
    const r = await make([], [session()], git).sessionDiff('TradingApp');
    if (!r.ok) throw new Error(r.reason);
    expect(r.value).toMatchObject({ isRepo: true, diff: '', truncated: false });
  });

  it('ENFORCES the diff cap', async () => {
    const git: DiffSource = { diff: async () => ({ isRepo: true, text: 'z'.repeat(DIFF_CHAR_CAP * 2) }) };
    const r = await make([], [session()], git).sessionDiff('TradingApp');
    if (!r.ok) throw new Error(r.reason);
    // The CONTENT is bounded by the cap; the truncation marker is added on top,
    // so the string is a little longer than the cap by design. Asserting exact
    // equality here would forbid ever saying that the diff was cut.
    expect(r.value.diff.replace(/\n… \[diff truncated\]$/, '').length).toBeLessThanOrEqual(
      DIFF_CHAR_CAP
    );
    expect(r.value.truncated).toBe(true);
  });

  it('refuses a bad reference without shelling out to git', async () => {
    let called = 0;
    const git: DiffSource = {
      diff: async () => {
        called++;
        return { isRepo: false, text: '' };
      },
    };
    expect((await make([], [session()], git).sessionDiff('Nope')).ok).toBe(false);
    expect(called).toBe(0);
  });
});

describe('the values themselves', () => {
  // The constants ARE the contract — the module exists to bound what crosses
  // into a sibling's context window. Every cap test below builds its fixture
  // FROM the constant, so each assertion follows the number wherever it goes
  // and a change from 200 to 20,000 would stay green. These pin the numbers.
  it('the caps and clamps are the documented values', () => {
    expect(OUTPUT_CHAR_CAP).toBe(20_000);
    expect(DIFF_CHAR_CAP).toBe(20_000);
    expect(DEFAULT_LAST_N).toBe(20);
    expect(MAX_LAST_N).toBe(200);
  });
});

describe('the WORK behind an answer, not just the answer (#772)', () => {
  // `sessionOutput` runs synchronously on Electron's main thread, so the bytes
  // it parses are the user's UI stalling. The caps bound what comes BACK; these
  // pin what gets READ — which nothing in the suite looked at before, and which
  // is why the whole 4 MB tail was being parsed to return twenty blocks.

  /** An entry whose BYTES are large and whose RENDERED text is tiny. */
  const padded = (text: string, bytes: number) =>
    JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text }] },
      // A field the derivation never reads: bulk on disk, nothing on screen,
      // so the character cap cannot be what cuts in these tests.
      padding: 'p'.repeat(bytes),
    });

  /** Sum of bytes actually read from disk while `fn` runs. */
  function bytesRead(fn: () => void): number {
    let total = 0;
    const real = fs.readSync.bind(fs);
    const spy = vi.spyOn(fs, 'readSync').mockImplementation((...args: Parameters<typeof fs.readSync>) => {
      const n = real(...args);
      total += n;
      return n;
    });
    try {
      fn();
    } finally {
      spy.mockRestore();
    }
    return total;
  }

  it('answers the default from a SMALL window — it does not parse the whole tail', () => {
    // ~2 MB of transcript. Before #772 this read all of it (up to 4 MB) to
    // hand back twenty blocks.
    const lines = Array.from({ length: 2_000 }, (_, i) => padded(`block-${i}-end`, 1_000));
    const q = make(lines);
    let r: ReturnType<typeof q.sessionOutput> | undefined;
    const read = bytesRead(() => {
      r = q.sessionOutput('TradingApp');
    });
    if (!r?.ok) throw new Error('refused');
    expect(r.value.blocks).toBe(DEFAULT_LAST_N);
    expect(r.value.text).toContain('block-1999-end');
    expect(read).toBeLessThanOrEqual(OUTPUT_FIRST_WINDOW + 1);
  });

  it('GROWS the window when the small one lacks the blocks asked for, and returns exactly the newest n', () => {
    // 3 KB an entry: the first window holds ~85, and 200 were asked for.
    const lines = Array.from({ length: 400 }, (_, i) => padded(`block-${i}-end`, 3_000));
    const r = make(lines).sessionOutput('TradingApp', 200);
    if (!r.ok) throw new Error(r.reason);
    expect(r.value.blocks).toBe(200);
    // The boundary is the assertion: the oldest block wanted is present and
    // the one before it is not — what a whole-file read returns.
    expect(r.value.text).toContain('block-200-end');
    expect(r.value.text).not.toContain('block-199-end');
    expect(r.value.text).toContain('block-399-end');
  });

  it('grows in ONE step, straight to the old budget — never a ladder that re-reads on the way up', () => {
    // The probe caught a fixed 256 KB → 1 MB → 4 MB ladder making `lastN: 200`
    // slower than before it existed: a transcript that needs the whole 4 MB
    // paid for the 1 MB read on the way. 20 KB entries put ~12 blocks in the
    // first window and need ~4 MB for 200 — the case where a ladder takes two
    // extra reads. (3 KB entries would not tell them apart: a ladder reaches
    // 200 in one step there too.)
    const lines = Array.from({ length: 210 }, (_, i) => padded(`block-${i}-end`, 20_000));
    const q = make(lines);
    let r: ReturnType<typeof q.sessionOutput> | undefined;
    const read = bytesRead(() => {
      r = q.sessionOutput('TradingApp', 200);
    });
    if (!r?.ok) throw new Error('refused');
    expect(r.value.blocks).toBe(200);
    // first window + ONE read at the ceiling (each carries one byte of
    // boundary context — see `readTranscriptWindow`)
    expect(read).toBeLessThanOrEqual(OUTPUT_FIRST_WINDOW + 1 + HISTORY_TAIL_BYTES + 1);
  });

  it('does NOT read again when the first window already reached the start of the file', () => {
    // Fewer blocks than asked for, but nothing further back to read. A second
    // read here is pure waste on the main thread — and the commonest case,
    // since most transcripts are small.
    const lines = Array.from({ length: 30 }, (_, i) => padded(`block-${i}-end`, 1_000));
    const q = make(lines);
    const size = fs.statSync(path.join(dir, 'conv.jsonl')).size;
    const read = bytesRead(() => q.sessionOutput('TradingApp', 200));
    expect(read).toBe(size);
  });

  it('does NOT read again when the LINE budget cut, which a bigger byte window cannot lift', () => {
    // 7,000 lines that derive no blocks, ~45 bytes each (~315 KB): the first
    // window holds ~5,800 of them — more than `HISTORY_MAX_LINES` — so the
    // reader keeps the newest 5,000, and a 4 MB read would keep the SAME 5,000.
    const lines = Array.from({ length: 7_000 }, (_, i) =>
      JSON.stringify({ type: 'summary', n: i, pad: 'p'.repeat(8) })
    );
    const q = make(lines);
    // Guard the fixture itself: if the lines grow, the cap stops binding and
    // this test would pass or fail for a reason that has nothing to do with it.
    expect(readTranscriptWindow(path.join(dir, 'conv.jsonl'), OUTPUT_FIRST_WINDOW).entries).toHaveLength(
      HISTORY_MAX_LINES
    );
    expect(fs.statSync(path.join(dir, 'conv.jsonl')).size).toBeGreaterThan(OUTPUT_FIRST_WINDOW);
    const read = bytesRead(() => q.sessionOutput('TradingApp'));
    expect(read).toBeLessThanOrEqual(OUTPUT_FIRST_WINDOW + 1);
  });

  it('reports TRUNCATED when the window stopped short of the file start, even with fewer blocks than asked', () => {
    // ⚠️ THE BUG THIS PINS, which predates #772: a transcript whose last 4 MB
    // held fewer blocks than asked for came back `truncated: false` — every
    // block that was read got returned, so nothing LOOKED dropped — while
    // earlier history sat unread in front of the window. A sibling was told it
    // had the whole story. 1.2 MB entries: the 4 MB window holds three.
    const lines = [
      assistantLine('THE-OLDEST-LINE'),
      ...Array.from({ length: 4 }, (_, i) => padded(`big-${i}-end`, 1_200_000)),
    ];
    const r = make(lines).sessionOutput('TradingApp', DEFAULT_LAST_N);
    if (!r.ok) throw new Error(r.reason);
    expect(r.value.blocks).toBeLessThan(DEFAULT_LAST_N);
    expect(r.value.text).not.toContain('THE-OLDEST-LINE');
    expect(r.value.truncated).toBe(true);
  });
});

describe('output goes to the RIGHT session', () => {
  it('reads the transcript of the session that was named, not any other', () => {
    // Nothing else in this file has two sessions WITH two transcripts, so
    // `transcriptFor(session.id)` -> `transcriptFor(ref)` would have survived
    // every other case here: the doubles all ignore their argument.
    const a = path.join(dir, 'a.jsonl');
    const b = path.join(dir, 'b.jsonl');
    fs.writeFileSync(a, assistantLine('I am ALPHA') + '\n');
    fs.writeFileSync(b, assistantLine('I am BETA') + '\n');
    const q = new SessionQueries({
      list: () => [session({ id: 'a', name: 'Alpha' }), session({ id: 'b', name: 'Beta' })],
      transcriptFor: (id) => (id === 'a' ? a : id === 'b' ? b : null),
      git: noDiff,
    });
    const ra = q.sessionOutput('Alpha');
    if (!ra.ok) throw new Error(ra.reason);
    expect(ra.value.text).toContain('ALPHA');
    expect(ra.value.text).not.toContain('BETA');
    const rb = q.sessionOutput('Beta');
    if (!rb.ok) throw new Error(rb.reason);
    expect(rb.value.text).toContain('BETA');
  });
});

describe('what the cap keeps', () => {
  it('keeps the NEWEST text and drops the oldest, and says it trimmed', () => {
    // The direction is the whole point: "what is my sibling up to" is answered
    // by the END of the window. Asserting only `length === CAP` — which the
    // first version of this suite did — passes for a cap that keeps the oldest
    // 20k and throws away the present.
    const big = 'x'.repeat(9_000);
    const q = make([
      assistantLine('OLDEST-MARKER ' + big),
      assistantLine(big),
      assistantLine('NEWEST-MARKER ' + big),
    ]);
    const r = q.sessionOutput('TradingApp', 3);
    if (!r.ok) throw new Error(r.reason);
    expect(r.value.text.length).toBeLessThanOrEqual(OUTPUT_CHAR_CAP);
    expect(r.value.text).toContain('NEWEST-MARKER');
    expect(r.value.text).not.toContain('OLDEST-MARKER');
    expect(r.value.text.startsWith(TRIM_MARKER)).toBe(true);
    expect(r.value.truncated).toBe(true);
  });

  it('derives with DISPLAY_CAPS, so one enormous block is bounded before joining', () => {
    const q = make([assistantLine('y'.repeat(60_000))]);
    const r = q.sessionOutput('TradingApp', 1);
    if (!r.ok) throw new Error(r.reason);
    expect(r.value.text.length).toBeLessThanOrEqual(OUTPUT_CHAR_CAP);
  });

  it('bounds a tool RESULT at the derivation cap, independently of the output cap', () => {
    // The derivation caps and the output cap are two different budgets, and a
    // test that only checks the total cannot tell them apart — swapping
    // DISPLAY_CAPS for uncapped derivation survives it, because the output cap
    // trims the result to the same length either way.
    //
    // So: keep the whole thing UNDER the output cap and make the per-result
    // budget the only thing that can cut. DETAIL_CAP is 4,000.
    const q = make([
      toolLine('t1', 'Bash', { command: 'noisy' }),
      toolResultLine('t1', 'A'.repeat(4_000) + 'TAIL-MARKER-BEYOND-DETAIL-CAP'),
    ]);
    const r = q.sessionOutput('TradingApp');
    if (!r.ok) throw new Error(r.reason);
    expect(r.value.text.length).toBeLessThan(OUTPUT_CHAR_CAP);
    expect(r.value.text).toContain('AAAA');
    expect(r.value.text).not.toContain('TAIL-MARKER-BEYOND-DETAIL-CAP');
  });

  it('counts only the blocks that contributed text', () => {
    // A `TodoWrite` with an empty list — an agent clearing its plan — derives a
    // real `todos` block that renders to nothing. Counting it makes `blocks` a
    // count of things the caller cannot see, and `{ blocks: 2, text: 'one
    // thing' }` is a lie the reader has no way to detect.
    const q = make([
      toolLine('t0', 'TodoWrite', { todos: [] }),
      assistantLine('the only real block'),
    ]);
    const r = q.sessionOutput('TradingApp');
    if (!r.ok) throw new Error(r.reason);
    expect(r.value.text).toBe('Claude: the only real block');
    expect(r.value.blocks).toBe(1);
  });

  it('separates blocks — concatenated prose is materially worse input', () => {
    const q = make([assistantLine('first'), assistantLine('second')]);
    const r = q.sessionOutput('TradingApp');
    if (!r.ok) throw new Error(r.reason);
    expect(r.value.text).toBe('Claude: first\n\nClaude: second');
  });
});

describe('block kinds a sibling actually cares about', () => {
  it('labels thinking as thinking, not as the assistant answer', () => {
    const q = make([
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'weighing it up' }] },
      }),
      assistantLine('the answer'),
    ]);
    const r = q.sessionOutput('TradingApp');
    if (!r.ok) throw new Error(r.reason);
    // Presenting extended thinking to another agent as the ANSWER is a
    // misattribution the reader cannot detect.
    expect(r.value.text).toContain('Thinking: weighing it up');
    expect(r.value.text).toContain('Claude: the answer');
  });

  it('renders a TodoWrite plan — one of the most useful things to ask a sibling', () => {
    const q = make([
      toolLine('t9', 'TodoWrite', {
        todos: [
          { content: 'ship the bus', status: 'in_progress' },
          { content: 'write the docs', status: 'pending' },
        ],
      }),
    ]);
    const r = q.sessionOutput('TradingApp');
    if (!r.ok) throw new Error(r.reason);
    expect(r.value.text).toContain('[in_progress] ship the bus');
    expect(r.value.text).toContain('[pending] write the docs');
  });

  it('MARKS a subagent turn instead of passing it off as the main conversation', () => {
    const q = make([
      JSON.stringify({
        type: 'assistant',
        isSidechain: true,
        message: { role: 'assistant', content: [{ type: 'text', text: 'subagent speaking' }] },
      }),
      assistantLine('main speaking'),
    ]);
    const r = q.sessionOutput('TradingApp');
    if (!r.ok) throw new Error(r.reason);
    expect(r.value.text).toContain('[subagent] Claude: subagent speaking');
    expect(r.value.text).toContain('Claude: main speaking');
    expect(r.value.text).not.toContain('[subagent] Claude: main speaking');
  });
});

describe('tool results attach to the RIGHT call', () => {
  it('interleaved calls each get their own result', () => {
    // Two calls open at once, results arriving out of order. "Attach to the
    // most recent tool block" passes a single-call fixture and fails here.
    const q = make([
      toolLine('t1', 'Bash', { command: 'one' }),
      toolLine('t2', 'Read', { file_path: 'two.txt' }),
      toolResultLine('t2', 'RESULT-TWO'),
      toolResultLine('t1', 'RESULT-ONE'),
    ]);
    const r = q.sessionOutput('TradingApp');
    if (!r.ok) throw new Error(r.reason);
    const bash = r.value.text.indexOf('[Bash]');
    const read = r.value.text.indexOf('[Read]');
    expect(bash).toBeGreaterThanOrEqual(0);
    expect(read).toBeGreaterThan(bash);
    expect(r.value.text.slice(bash, read)).toContain('RESULT-ONE');
    expect(r.value.text.slice(read)).toContain('RESULT-TWO');
  });

  it('a result for a tool_use id never seen is dropped, not attached to something else', () => {
    const q = make([toolLine('t1', 'Bash', { command: 'one' }), toolResultLine('nope', 'STRAY')]);
    const r = q.sessionOutput('TradingApp');
    if (!r.ok) throw new Error(r.reason);
    expect(r.value.text).not.toContain('STRAY');
  });

  it('a tool call that never gets a result still renders, without an arrow', () => {
    const q = make([toolLine('t1', 'Bash', { command: 'hangs' })]);
    const r = q.sessionOutput('TradingApp');
    if (!r.ok) throw new Error(r.reason);
    expect(r.value.text).toContain('[Bash]');
    expect(r.value.text).not.toContain('->');
  });
});

describe('a dependency that throws is fail-open, not a crash', () => {
  const boom = (): never => {
    throw new Error('dep exploded');
  };

  it('list() throwing refuses rather than escaping the module', () => {
    const q = new SessionQueries({ list: boom, transcriptFor: () => null, git: noDiff });
    expect(() => q.listSessions()).not.toThrow();
    expect(q.listSessions().ok).toBe(false);
    expect(q.resolve('anything').ok).toBe(false);
  });

  it('transcriptFor() throwing answers EMPTY — a normal state, not a refusal', () => {
    const q = new SessionQueries({ list: () => [session()], transcriptFor: boom, git: noDiff });
    const r = q.sessionOutput('TradingApp');
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(r.reason);
    expect(r.value.text).toBe('');
  });

  it('git.diff() rejecting REFUSES — reporting it as not-a-repo would be a lie', async () => {
    const q = make([], [session()], {
      diff: () => Promise.reject(new Error('git exploded')),
    });
    const r = await q.sessionDiff('TradingApp');
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reason).toContain('could not read the diff');
  });
});

describe('a reference that is not even a string', () => {
  // Both consumers cross a boundary where types are not enforced: MCP tool
  // arguments are JSON a model wrote, IPC arguments come from the renderer.
  it.each([42, null, undefined, { name: 'x' }, ['a']])('refuses %p without throwing', (bad) => {
    const q = make([], [session()]);
    expect(() => q.resolve(bad as unknown as string)).not.toThrow();
    expect(q.resolve(bad as unknown as string).ok).toBe(false);
    expect(q.sessionOutput(bad as unknown as string).ok).toBe(false);
  });

  it('trims surrounding whitespace off a valid name', () => {
    expect(make([], [session()]).resolve('  TradingApp  ').ok).toBe(true);
    expect(make([], [session()]).resolve(' @TradingApp ').ok).toBe(true);
  });

  it('the empty-reference refusal says WHY, not just that it failed', () => {
    const r = make([], [session()]).resolve('   ');
    if (r.ok) throw new Error('unreachable');
    expect(r.reason).toBe('no session named');
  });
});

describe('the ambiguity refusal is actionable', () => {
  it('names the folder — the only thing telling two checkouts of one repo apart', () => {
    const q = make(
      [],
      [
        session({ id: 'sess-1', folder: 'C:/Projects/TradingApp' }),
        session({ id: 'sess-2', folder: 'C:/Projects/TradingApp-wt2' }),
      ]
    );
    const r = q.resolve('TradingApp');
    if (r.ok) throw new Error('unreachable');
    expect(r.reason).toContain('TradingApp-wt2');
  });
});

describe('the diff cut', () => {
  it('ends on a line boundary and says it was truncated', async () => {
    const line = 'x'.repeat(99) + '\n';
    const git: DiffSource = {
      diff: async () => ({ isRepo: true, text: line.repeat(Math.ceil(DIFF_CHAR_CAP / 100) + 10) }),
    };
    const r = await make([], [session()], git).sessionDiff('TradingApp');
    if (!r.ok) throw new Error(r.reason);
    // A diff cut mid-hunk still LOOKS like a valid patch, which is worse than
    // one that is visibly incomplete.
    expect(r.value.diff.endsWith('[diff truncated]')).toBe(true);
    expect(r.value.truncated).toBe(true);
  });
});

describe('the transport-free constraint', () => {
  // The whole value of this module is that BOTH the bus (#764, a child process
  // over stdio) and the composer (#768-era, the renderer over IPC) can call it.
  // That stops being true the first time someone reaches for a convenience
  // import, and nothing else in the suite would notice — so assert it against
  // the source text rather than trusting the header comment.
  const source = fs.readFileSync(path.join(__dirname, 'queries.ts'), 'utf8');
  const imports = [...source.matchAll(/^\s*(?:import|export)\s[^;]*?from\s+'([^']+)'/gm)].map(
    (m) => m[1]
  );

  it('imports nothing MCP, IPC, Electron or transport-shaped', () => {
    expect(imports.length).toBeGreaterThan(0); // the regex still matches something
    for (const spec of imports) {
      expect(spec).not.toMatch(/mcp|ipc|electron|transport|preload|renderer/i);
    }
  });

  it('imports nothing from the renderer tree', () => {
    for (const spec of imports) expect(spec).not.toContain('renderer');
  });

  it('names nothing transport-shaped ANYWHERE, not just in a static import', () => {
    // The import regex above only sees `import … from '…'`. A `require()`, a
    // dynamic `await import()`, or a bare side-effect import would all slip
    // past it, so scan the raw text for the identifiers themselves.
    expect(source).not.toMatch(/\b(ipcMain|ipcRenderer|BrowserWindow|webContents)\b/);
    expect(source).not.toMatch(/require\(|await import\(/);
    expect(source).not.toMatch(/@modelcontextprotocol/);
  });
});
