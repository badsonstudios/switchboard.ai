import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { TranscriptWatcher, slugForCwd, conversationExists } from './watcher';
import { LogSink, createLogger } from '../log/logger';

let root: string;
let logDir: string;
let cwd: string;
let watcher: TranscriptWatcher;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-tw-root-'));
  // The log sink gets its OWN directory, deliberately. It used to write into
  // `root` — i.e. inside the very tree the watcher scans — which was harmless
  // while discovery was a blind 100ms poll (`scan` only collects `.jsonl`).
  // With P2-E15-11 the root is under `fs.watch`, so creating a log file raises
  // a `rename` event and prods discovery. That is not just noise: it silently
  // defeated a regression test, which passed against the very defect it was
  // written to catch because the watcher's own "transcript bound" log line was
  // re-dirtying the root for it.
  logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-tw-log-'));
  cwd = 'C:/tmp/tw-project';
  watcher = new TranscriptWatcher({
    projectsRoot: root,
    log: createLogger(new LogSink({ dir: logDir }), 'transcripts'),
    pollMs: 25,
  });
});

afterEach(() => watcher.stop());

function projectDir(): string {
  const d = path.join(root, slugForCwd(cwd));
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function writeLines(file: string, lines: string[]): void {
  fs.appendFileSync(file, lines.map((l) => l + '\n').join(''));
}

const entry = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'assistant', sessionId: 'native-1', cwd, timestamp: new Date().toISOString(), ...over });

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe('conversationExists (gate for --resume, avoids crash on empty id)', () => {
  it('true only when the transcript file exists under the (case-insensitive) slug', () => {
    const cwd = 'C:/tmp/tw-project';
    const dir = path.join(root, slugForCwd(cwd).toLowerCase());
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'native-abc.jsonl'), '{}');
    expect(conversationExists(root, cwd, 'native-abc')).toBe(true);
    expect(conversationExists(root, cwd, 'never-existed')).toBe(false);
    expect(conversationExists(root, 'C:/other/folder', 'native-abc')).toBe(false);
  });
});

describe('binding validation (the S-04 race fix)', () => {
  it('binds a transcript whose head matches cwd, tolerating late creation', async () => {
    watcher.watch('s1', { cwd });
    await sleep(80); // transcript does not exist yet — must not blow up
    expect(watcher.snapshot('s1')!.bound).toBe(false);

    const file = path.join(projectDir(), 'native-1.jsonl');
    writeLines(file, [entry()]);
    await sleep(120);
    const snap = watcher.snapshot('s1')!;
    expect(snap.bound).toBe(true);
    expect(snap.nativeSessionId).toBe('native-1');
  });

  it('refuses a transcript from another cwd in the same window', async () => {
    watcher.watch('s1', { cwd });
    const file = path.join(projectDir(), 'imposter.jsonl');
    writeLines(file, [entry({ cwd: 'C:/somewhere/else' })]);
    await sleep(120);
    expect(watcher.snapshot('s1')!.bound).toBe(false);
  });

  it('refuses a mismatched sessionId when the native id is known', async () => {
    watcher.watch('s1', { cwd, nativeSessionId: 'expected-id' });
    writeLines(path.join(projectDir(), 'other.jsonl'), [entry({ sessionId: 'different-id' })]);
    await sleep(120);
    expect(watcher.snapshot('s1')!.bound).toBe(false);
  });
});

describe('live usage totals + tolerant reader (the done-when)', () => {
  it('token counts update live across appends; malformed lines never crash', async () => {
    watcher.watch('s1', { cwd });
    const file = path.join(projectDir(), 'native-1.jsonl');
    writeLines(file, [entry({ message: { usage: { input_tokens: 5, output_tokens: 10 } } })]);
    await sleep(120);
    expect(watcher.snapshot('s1')!.usage).toMatchObject({ input: 5, output: 10 });

    const updates: number[] = [];
    const off = watcher.onUpdate((s) => updates.push(s.usage.output));
    writeLines(file, [
      'garbage {{{ not json',
      entry({ type: 'unknown-future-type' }),
      entry({
        message: {
          usage: { output_tokens: 7, cache_read_input_tokens: 100 },
          content: [{ type: 'tool_use', name: 'Write', input: { file_path: 'C:/tmp/tw-project/x.txt' } }],
        },
      }),
    ]);
    await sleep(120);
    off();
    const snap = watcher.snapshot('s1')!;
    expect(snap.usage).toMatchObject({ input: 5, output: 17, cacheRead: 100 });
    expect(snap.malformed).toBe(1);
    expect(snap.lines).toBe(4);
    expect(snap.toolsSeen).toContain('Write');
    expect(snap.filesTouched).toContain('C:/tmp/tw-project/x.txt');
    expect(updates.length).toBeGreaterThan(0);
    expect(snap.lastActivityAt).not.toBeNull();
  });
});

describe('plan-as-progress extraction (OQ #13 / E7-04)', () => {
  it('captures TodoWrite step counts from the transcript', async () => {
    watcher.watch('s1', { cwd });
    const file = path.join(projectDir(), 'native-1.jsonl');
    writeLines(file, [entry()]);
    await sleep(100);
    writeLines(file, [
      entry({
        message: {
          content: [
            {
              type: 'tool_use',
              name: 'TodoWrite',
              input: {
                todos: [
                  { content: 'a', status: 'completed' },
                  { content: 'b', status: 'in_progress' },
                  { content: 'c', status: 'pending' },
                ],
              },
            },
          ],
        },
      }),
    ]);
    await sleep(120);
    expect(watcher.snapshot('s1')!.plan).toEqual({ total: 3, completed: 1, inProgress: 1 });
  });
});

describe('subagent visibility (S-05 layout)', () => {
  it('tails nested agent files and reads meta sidecars', async () => {
    watcher.watch('s1', { cwd });
    const file = path.join(projectDir(), 'native-1.jsonl');
    writeLines(file, [entry()]);
    await sleep(100);

    const subDir = path.join(projectDir(), 'native-1', 'subagents');
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(
      path.join(subDir, 'agent-abc123.meta.json'),
      JSON.stringify({ agentType: 'general-purpose', description: 'count lines' })
    );
    writeLines(path.join(subDir, 'agent-abc123.jsonl'), [
      entry({ isSidechain: true, agentId: 'abc123', message: { usage: { output_tokens: 3 } } }),
    ]);
    // Agent tool_use in the main transcript triggers meta pickup
    writeLines(file, [
      entry({ message: { content: [{ type: 'tool_use', name: 'Agent', input: { description: 'count lines' } }] } }),
    ]);
    await sleep(150);
    const snap = watcher.snapshot('s1')!;
    expect(snap.subagents).toEqual([
      { agentId: 'abc123', agentType: 'general-purpose', description: 'count lines' },
    ]);
    expect(snap.usage.output).toBe(3); // subagent tokens counted
  });
});

describe('Feed block derivation (P2-E12-06 §5.10)', () => {
  it('derives user/assistant/thinking/tool blocks; tool_result plumbing is skipped', async () => {
    watcher.watch('s1', { cwd });
    const file = path.join(projectDir(), 'native-1.jsonl');
    const seen: Array<{ sessionId: string; kind: string }> = [];
    const off = watcher.onBlock((sid, b) => seen.push({ sessionId: sid, kind: b.kind }));
    writeLines(file, [
      entry({ type: 'user', message: { role: 'user', content: 'do the thing' } }),
      entry({
        message: {
          content: [
            { type: 'thinking', thinking: 'hmm let me think' },
            { type: 'text', text: '**Done** — here is `code`.' },
            { type: 'tool_use', name: 'Edit', input: { file_path: 'C:/x.ts', old_string: 'a', new_string: 'b' } },
          ],
        },
      }),
      entry({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'noise' }] } }),
    ]);
    await sleep(150);
    off();
    const blocks = watcher.blocks('s1');
    expect(blocks.map((b) => b.kind)).toEqual(['user', 'thinking', 'assistant', 'tool']);
    expect(blocks[0].text).toBe('do the thing');
    expect(blocks[3].tool).toMatchObject({ name: 'Edit', summary: 'C:/x.ts' });
    expect(blocks[3].tool!.detail).toContain('old_string');
    expect(blocks.every((b) => !b.sidechain)).toBe(true);
    expect(seen.length).toBe(4);
  });

  it('rich blocks v2 (E10-06): Edit fields, Bash OUT attach, todos, thought duration', async () => {
    watcher.watch('s1', { cwd });
    const file = path.join(projectDir(), 'native-1.jsonl');
    const t0 = new Date('2026-07-21T10:00:00.000Z').toISOString();
    const t3 = new Date('2026-07-21T10:00:03.000Z').toISOString();
    writeLines(file, [
      entry({
        timestamp: t0,
        message: {
          content: [
            { type: 'thinking', thinking: 'pondering' },
          ],
        },
      }),
      entry({
        timestamp: t3,
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'use-1',
              name: 'Bash',
              input: { command: 'echo hi', description: 'Say hi' },
            },
            {
              type: 'tool_use',
              id: 'use-2',
              name: 'Edit',
              input: { file_path: 'C:/a.ts', old_string: 'one\ntwo', new_string: 'three' },
            },
            {
              type: 'tool_use',
              name: 'TodoWrite',
              input: { todos: [{ content: 'step A', status: 'completed' }, { content: 'step B', status: 'pending' }] },
            },
          ],
        },
      }),
      entry({
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'use-1', content: 'hi' }] },
      }),
    ]);
    await sleep(150);
    const blocks = watcher.blocks('s1');
    const thinking = blocks.find((b) => b.kind === 'thinking')!;
    expect(thinking.durationMs).toBe(3000); // set when the next block landed
    const bash = blocks.find((b) => b.tool?.name === 'Bash')!;
    expect(bash.tool).toMatchObject({ summary: 'echo hi', description: 'Say hi', out: 'hi', category: 'shell' });
    const edit = blocks.find((b) => b.tool?.name === 'Edit')!;
    expect(edit.tool).toMatchObject({ filePath: 'C:/a.ts', oldString: 'one\ntwo', newString: 'three' });
    const todos = blocks.find((b) => b.kind === 'todos')!;
    expect(todos.todos).toEqual([
      { content: 'step A', status: 'completed' },
      { content: 'step B', status: 'pending' },
    ]);
    // the tool_result line produced NO user block of its own
    expect(blocks.filter((b) => b.kind === 'user')).toHaveLength(0);
  });

  it('stamps tool blocks with a presentation category — PowerShell is shell (review P1 #9)', async () => {
    watcher.watch('s1', { cwd });
    const file = path.join(projectDir(), 'native-1.jsonl');
    writeLines(file, [
      entry({
        message: {
          content: [
            { type: 'tool_use', name: 'PowerShell', input: { command: 'ls ~/Downloads' } },
            { type: 'tool_use', name: 'Write', input: { file_path: 'C:/x.ts', content: 'hi' } },
            { type: 'tool_use', name: 'Grep', input: { pattern: 'x' } },
            { type: 'tool_use', name: 'SomeFutureTool', input: {} },
          ],
        },
      }),
    ]);
    await sleep(150);
    const cats = watcher.blocks('s1').map((b) => [b.tool?.name, b.tool?.category]);
    expect(cats).toEqual([
      ['PowerShell', 'shell'],
      ['Write', 'edit'],
      ['Grep', 'read'],
      ['SomeFutureTool', 'other'],
    ]);
  });

  it('marks subagent-file lines as sidechain and caps the backlog', async () => {
    watcher.watch('s1', { cwd });
    const file = path.join(projectDir(), 'native-1.jsonl');
    writeLines(file, [entry()]);
    await sleep(100);
    const subDir = path.join(projectDir(), 'native-1', 'subagents');
    fs.mkdirSync(subDir, { recursive: true });
    writeLines(path.join(subDir, 'agent-x.jsonl'), [
      entry({ isSidechain: true, message: { content: [{ type: 'text', text: 'sub says hi' }] } }),
    ]);
    await sleep(150);
    const blocks = watcher.blocks('s1');
    expect(blocks.some((b) => b.sidechain && b.text === 'sub says hi')).toBe(true);
  });
});

describe('positive evidence required to claim (Dan 2026-07-22: summary-first files)', () => {
  it('a summary-first file (no cwd on line 1) is NOT claimed by a foreign-folder session', async () => {
    // widen quickly so the full-root scan definitely sees the foreign file
    const w2 = new TranscriptWatcher({
      projectsRoot: root,
      log: createLogger(new LogSink({ dir: logDir }), 'transcripts'),
      pollMs: 25,
      widenAfterMs: 50,
    });
    const otherDir = path.join(root, slugForCwd('C:/tmp/other-project'));
    fs.mkdirSync(otherDir, { recursive: true });
    const file = path.join(otherDir, 'native-foreign.jsonl');
    w2.watch('s1', { cwd }); // our session, DIFFERENT folder
    writeLines(file, [
      JSON.stringify({ type: 'summary', summary: 'compacted history' }), // no cwd, no sessionId
      entry({ sessionId: 'native-foreign', cwd: 'C:/tmp/other-project' }),
    ]);
    await sleep(300); // well past widen
    expect(w2.snapshot('s1')!.bound).toBe(false);
    w2.stop();
  });

  it('a summary-first file IS claimed when deeper lines prove the cwd', async () => {
    watcher.watch('s1', { cwd });
    const file = path.join(projectDir(), 'native-sum.jsonl');
    writeLines(file, [
      JSON.stringify({ type: 'summary', summary: 'compacted history' }),
      entry({ sessionId: 'native-sum' }), // carries cwd (ours) on line 2
    ]);
    await sleep(150);
    const snap = watcher.snapshot('s1')!;
    expect(snap.bound).toBe(true);
    expect(snap.nativeSessionId).toBe('native-sum');
  });
});

describe('huge unparseable head lines (file-history-snapshot) — Dan 2026-07-22', () => {
  it('binds by FILENAME once hooks deliver the id, even with an unreadable head', async () => {
    watcher.watch('s1', { cwd });
    const file = path.join(projectDir(), 'native-big.jsonl');
    // a first line far bigger than the head window, then real content
    writeLines(file, [
      JSON.stringify({ type: 'file-history-snapshot', blob: 'x'.repeat(300_000) }),
      entry({ sessionId: 'native-big', message: { content: [{ type: 'text', text: 'hi there' }] } }),
    ]);
    await sleep(120);
    expect(watcher.snapshot('s1')!.bound).toBe(false); // no evidence yet
    watcher.setNativeSessionId('s1', 'native-big'); // hooks deliver the id
    await sleep(150);
    expect(watcher.snapshot('s1')!.bound).toBe(true);
    expect(watcher.blocks('s1').some((b) => b.text === 'hi there')).toBe(true);
  });
});

describe('id known -> only id evidence binds (review P1 #6)', () => {
  it('does NOT cwd-bind a file with an unparseable head sessionId and a foreign filename', async () => {
    watcher.watch('s1', { cwd, nativeSessionId: 'expected-id' }); // alone in the folder
    const file = path.join(projectDir(), 'mystery.jsonl');
    // head yields {cwd, sessionId: undefined}: the id-bearing line is junk,
    // a later line proves the cwd but nothing proves the id
    writeLines(file, [
      'garbage {{{ not json ' + 'x'.repeat(500),
      JSON.stringify({ type: 'user', cwd, timestamp: new Date().toISOString() }),
    ]);
    await sleep(150);
    expect(watcher.snapshot('s1')!.bound).toBe(false);

    // the same evidence DOES bind once the filename matches our id
    const own = path.join(projectDir(), 'expected-id.jsonl');
    writeLines(own, [
      'garbage {{{ not json ' + 'x'.repeat(500),
      JSON.stringify({ type: 'user', cwd, timestamp: new Date().toISOString() }),
    ]);
    await sleep(150);
    expect(watcher.snapshot('s1')!.bound).toBe(true);
  });
});

describe('cwd fallback when hooks never deliver an id (review P1 #8, fail-open)', () => {
  it('two same-cwd sessions bind best-effort after the deadline, one file each', async () => {
    const w2 = new TranscriptWatcher({
      projectsRoot: root,
      log: createLogger(new LogSink({ dir: logDir }), 'transcripts'),
      pollMs: 25,
      cwdBindFallbackMs: 120,
    });
    w2.watch('s1', { cwd });
    w2.watch('s2', { cwd });
    const fileA = path.join(projectDir(), 'native-A.jsonl');
    writeLines(fileA, [entry({ sessionId: 'native-A' })]);
    await sleep(60);
    // inside the deadline the ambiguity rule still holds
    expect(w2.snapshot('s1')!.bound).toBe(false);
    expect(w2.snapshot('s2')!.bound).toBe(false);
    await sleep(200); // past the deadline: best-effort binding proceeds
    const fileB = path.join(projectDir(), 'native-B.jsonl');
    writeLines(fileB, [entry({ sessionId: 'native-B' })]);
    await sleep(150);
    const bound = [w2.snapshot('s1')!, w2.snapshot('s2')!].filter((s) => s.bound);
    expect(bound).toHaveLength(2);
    // never the SAME file twice (claim skips files another session owns)
    expect(new Set(bound.map((s) => s.nativeSessionId)).size).toBe(2);
    w2.stop();
  });
});

describe('same-cwd sessions never steal each other\'s transcript (E10 fix)', () => {
  it('two sessions in one folder: neither binds until hooks deliver ids, then each gets its own', async () => {
    watcher.watch('s1', { cwd });
    watcher.watch('s2', { cwd });
    const fileA = path.join(projectDir(), 'native-A.jsonl');
    writeLines(fileA, [entry({ sessionId: 'native-A' })]);
    await sleep(120);
    // ambiguous — nobody claims on cwd alone
    expect(watcher.snapshot('s1')!.bound).toBe(false);
    expect(watcher.snapshot('s2')!.bound).toBe(false);

    watcher.setNativeSessionId('s2', 'native-A'); // hooks: the file is s2's
    await sleep(120);
    expect(watcher.snapshot('s2')!.bound).toBe(true);
    expect(watcher.snapshot('s2')!.nativeSessionId).toBe('native-A');
    expect(watcher.snapshot('s1')!.bound).toBe(false);

    const fileB = path.join(projectDir(), 'native-B.jsonl');
    writeLines(fileB, [entry({ sessionId: 'native-B' })]);
    watcher.setNativeSessionId('s1', 'native-B');
    await sleep(120);
    expect(watcher.snapshot('s1')!.bound).toBe(true);
    expect(watcher.snapshot('s1')!.nativeSessionId).toBe('native-B');
  });

  it('a cwd-only mis-bind is corrected when the hooks deliver a different id', async () => {
    watcher.watch('s1', { cwd }); // alone in the folder: cwd-only binds allowed
    const resets: string[] = [];
    const offReset = watcher.onReset((sid) => resets.push(sid));
    const fileA = path.join(projectDir(), 'native-A.jsonl');
    writeLines(fileA, [
      entry({ sessionId: 'native-A', message: { content: [{ type: 'text', text: 'stolen words' }] } }),
    ]);
    await sleep(120);
    expect(watcher.snapshot('s1')!.bound).toBe(true); // bound to the WRONG file

    watcher.setNativeSessionId('s1', 'native-B'); // hooks: actually a different conversation
    expect(watcher.snapshot('s1')!.bound).toBe(false); // unbound + reset
    expect(watcher.blocks('s1')).toHaveLength(0); // stolen blocks dropped
    expect(resets).toEqual(['s1']); // renderer told to drop them too (P1 #7)
    offReset();

    const fileB = path.join(projectDir(), 'native-B.jsonl');
    writeLines(fileB, [
      entry({ sessionId: 'native-B', message: { content: [{ type: 'text', text: 'my words' }] } }),
    ]);
    await sleep(150);
    expect(watcher.snapshot('s1')!.bound).toBe(true);
    expect(watcher.blocks('s1').some((b) => b.text === 'my words')).toBe(true);
  });

  it("/clear's new id resets WITH cause 'clear' and rebinds to the fresh transcript (E10-07)", async () => {
    watcher.watch('s1', { cwd });
    const resets: Array<{ sid: string; cause?: 'clear' }> = [];
    const offReset = watcher.onReset((sid, cause) => resets.push({ sid, cause }));
    const fileA = path.join(projectDir(), 'native-A.jsonl');
    writeLines(fileA, [
      entry({ sessionId: 'native-A', message: { content: [{ type: 'text', text: 'old conversation' }] } }),
    ]);
    await sleep(120);
    expect(watcher.snapshot('s1')!.bound).toBe(true);

    // hooks deliver SessionStart(source:'clear') with the freshly minted id
    watcher.setNativeSessionId('s1', 'native-fresh', 'clear');
    expect(watcher.blocks('s1')).toHaveLength(0); // old conversation dropped
    expect(resets).toEqual([{ sid: 's1', cause: 'clear' }]); // renderer can say "cleared"
    offReset();

    const fileB = path.join(projectDir(), 'native-fresh.jsonl');
    writeLines(fileB, [
      entry({ sessionId: 'native-fresh', message: { content: [{ type: 'text', text: 'fresh start' }] } }),
    ]);
    await sleep(150);
    expect(watcher.snapshot('s1')!.bound).toBe(true);
    expect(watcher.blocks('s1').some((b) => b.text === 'fresh start')).toBe(true);
  });
});

describe('pre-existing transcripts are never adopted', () => {
  it('ignores files that existed before the watcher started', async () => {
    const file = path.join(projectDir(), 'old.jsonl');
    writeLines(file, [entry()]);
    const w2 = new TranscriptWatcher({
      projectsRoot: root,
      log: createLogger(new LogSink({ dir: logDir }), 'transcripts'),
      pollMs: 25,
    });
    w2.watch('s1', { cwd });
    writeLines(file, [entry({ message: { usage: { output_tokens: 99 } } })]);
    await sleep(120);
    expect(w2.snapshot('s1')!.bound).toBe(false);
    expect(w2.snapshot('s1')!.usage.output).toBe(0);
    w2.stop();
  });

  it("EXCEPT the session's own resumed conversation, replayed with history (E10 fix)", async () => {
    const file = path.join(projectDir(), 'native-res.jsonl');
    writeLines(file, [
      entry({ sessionId: 'native-res', message: { content: [{ type: 'text', text: 'history line' }] } }),
    ]);
    const w2 = new TranscriptWatcher({
      projectsRoot: root,
      log: createLogger(new LogSink({ dir: logDir }), 'transcripts'),
      pollMs: 25,
    });
    w2.watch('s1', { cwd, nativeSessionId: 'native-res' }); // a --resume spawn
    await sleep(150);
    const snap = w2.snapshot('s1')!;
    expect(snap.bound).toBe(true);
    // the Feed gets the conversation history back on resume
    expect(w2.blocks('s1').some((b) => b.text === 'history line')).toBe(true);
    // and new lines keep flowing
    writeLines(file, [
      entry({ sessionId: 'native-res', message: { content: [{ type: 'text', text: 'fresh line' }] } }),
    ]);
    await sleep(120);
    expect(w2.blocks('s1').some((b) => b.text === 'fresh line')).toBe(true);
    w2.stop();
  });
});

describe('per-session transcripts root (P2-E15-01)', () => {
  let rootB: string;

  beforeEach(() => {
    rootB = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-tw-rootb-'));
  });
  afterEach(() => fs.rmSync(rootB, { recursive: true, force: true }));

  it('a session watches under ITS provider root, not the watcher default', async () => {
    const dir = path.join(rootB, slugForCwd(cwd));
    fs.mkdirSync(dir, { recursive: true });

    watcher.watch('s1', { cwd, projectsRoot: rootB });
    writeLines(path.join(dir, 'native-b.jsonl'), [entry({ sessionId: 'native-b' })]);
    await sleep(150);

    const snap = watcher.snapshot('s1')!;
    expect(snap.bound).toBe(true);
    expect(snap.nativeSessionId).toBe('native-b');
  });

  it('an identically-slugged folder under the OTHER root is not offered', async () => {
    // same cwd, so the same slug — only the root separates them. A second
    // provider's conversations must never be handed to this one's session.
    const mine = path.join(rootB, slugForCwd(cwd));
    const theirs = path.join(root, slugForCwd(cwd));
    fs.mkdirSync(mine, { recursive: true });
    fs.mkdirSync(theirs, { recursive: true });

    watcher.watch('s1', { cwd, projectsRoot: rootB });
    writeLines(path.join(theirs, 'native-other.jsonl'), [entry({ sessionId: 'native-other' })]);
    await sleep(200);

    expect(watcher.snapshot('s1')!.bound).toBe(false);
  });

  it('the widened scan does not cross roots either', async () => {
    const w2 = new TranscriptWatcher({
      projectsRoot: root,
      log: createLogger(new LogSink({ dir: logDir }), 'transcripts'),
      pollMs: 25,
      widenAfterMs: 50, // widen almost immediately
    });
    const theirs = path.join(root, slugForCwd('C:/tmp/somewhere-else'));
    fs.mkdirSync(theirs, { recursive: true });
    fs.mkdirSync(path.join(rootB, slugForCwd(cwd)), { recursive: true });

    w2.watch('s1', { cwd, projectsRoot: rootB });
    // a file that WOULD be claimable on evidence, but lives under the other root
    writeLines(path.join(theirs, 'native-wide.jsonl'), [entry({ sessionId: 'native-wide' })]);
    await sleep(300);

    expect(w2.snapshot('s1')!.bound).toBe(false);
    w2.stop();
  });

  it('a transcript already on disk under a non-default root is not adopted', async () => {
    // The `known` set is what stops a fresh session replaying an old
    // conversation (the S-04/S-05 adoption race). It used to be seeded once,
    // from the watcher's own root — so any OTHER root was entirely unguarded
    // and a brand-new session would bind a pre-existing file on cwd evidence
    // alone. Seeding now follows the sessions.
    const dir = path.join(rootB, slugForCwd(cwd));
    fs.mkdirSync(dir, { recursive: true });
    writeLines(path.join(dir, 'old-conversation.jsonl'), [
      entry({ sessionId: 'native-ancient', message: { role: 'assistant', content: 'ANCIENT' } }),
    ]);

    watcher.watch('s1', { cwd, projectsRoot: rootB }); // no native id: fresh session
    await sleep(200);

    expect(watcher.snapshot('s1')!.bound).toBe(false);
    expect(watcher.blocks('s1')).toHaveLength(0);
  });

  it('refuses a relative root rather than crawling from the process cwd', async () => {
    watcher.watch('s1', { cwd, projectsRoot: 'relative/path' });
    await sleep(80);
    // refused outright — no session, so nothing polls
    expect(watcher.snapshot('s1')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// P2-E15-10 — binding transparency (§5.26, AR-P1-8)
//
// The Session view renders only if binding succeeds, and until this item every
// way of failing looked the same: a blank pane. These pin the four states the
// watcher can honestly tell apart — and, the part that matters, that only ONE
// of them means something is wrong.
// ---------------------------------------------------------------------------
describe('binding state (P2-E15-10)', () => {
  it('a fresh session is awaiting-prompt and STAYS there — an unprompted session is not late', async () => {
    // The give-up deadline is 20ms here; a session nobody has prompted must
    // still never age into "couldn't bind", because nothing is wrong with it.
    const w = new TranscriptWatcher({
      projectsRoot: root,
      log: createLogger(new LogSink({ dir: logDir }), 'transcripts'),
      pollMs: 10,
      bindGiveUpMs: 20,
    });
    w.watch('s1', { cwd });
    expect(w.snapshot('s1')!.binding).toBe('awaiting-prompt');
    await sleep(200);
    expect(w.snapshot('s1')!.binding).toBe('awaiting-prompt');
    expect(w.snapshot('s1')!.bindingDiag.searchingMs).toBeNull();
    w.stop();
  });

  it('a turn running is evidence: awaiting-prompt -> searching', () => {
    watcher.watch('s1', { cwd });
    expect(watcher.snapshot('s1')!.binding).toBe('awaiting-prompt');
    watcher.noteConversationStarted('s1');
    const snap = watcher.snapshot('s1')!;
    expect(snap.binding).toBe('searching');
    expect(snap.bindingDiag.conversationStarted).toBe(true);
    expect(snap.bindingDiag.searchingMs).not.toBeNull();
  });

  it('HOOK TRAFFIC ALONE is not evidence — an un-prompted session never goes red', async () => {
    // Regression for the bug this model was rebuilt around. `SessionStart`
    // fires at CLI launch and carries a session_id, so it reaches
    // `setNativeSessionId` about a second after every card spawns — while the
    // CLI does not create the transcript until the FIRST PROMPT. Taking that
    // as evidence meant every card you had opened and not typed into turned
    // red 45 seconds later, which is the exact false alarm this item exists to
    // remove.
    const w = new TranscriptWatcher({
      projectsRoot: root,
      log: createLogger(new LogSink({ dir: logDir }), 'transcripts'),
      pollMs: 10,
      bindGiveUpMs: 20,
    });
    w.watch('s1', { cwd });
    w.setNativeSessionId('s1', 'native-1'); // what SessionStart does, at spawn
    await sleep(200); // ten times the give-up deadline
    expect(w.snapshot('s1')!.binding).toBe('awaiting-prompt');
    expect(w.snapshot('s1')!.bindingDiag.conversationStarted).toBe(false);
    w.stop();
  });

  it('an unclaimable file under our own folder is INDEPENDENT evidence (hooks silent)', async () => {
    // AR-P1-8's actual complaint: binding rides two undocumented contracts in
    // series. A storage-layout change must be visible even when hooks never
    // fire, or the UI can only ever report one of the two failures.
    watcher.watch('s1', { cwd });
    writeLines(path.join(projectDir(), 'imposter.jsonl'), [entry({ cwd: 'C:/somewhere/else' })]);
    await sleep(120);
    const snap = watcher.snapshot('s1')!;
    expect(snap.binding).toBe('searching');
    expect(snap.bindingDiag.candidateSeen).toBe(true);
    expect(snap.bindingDiag.conversationStarted).toBe(false);
  });

  it('searching past the deadline becomes unbound, and says where it looked', async () => {
    const w = new TranscriptWatcher({
      projectsRoot: root,
      log: createLogger(new LogSink({ dir: logDir }), 'transcripts'),
      pollMs: 10,
      bindGiveUpMs: 30,
    });
    w.watch('s1', { cwd });
    w.noteConversationStarted('s1');
    expect(w.snapshot('s1')!.binding).toBe('searching');
    await sleep(200);
    const snap = w.snapshot('s1')!;
    expect(snap.binding).toBe('unbound');
    expect(snap.bindingDiag.projectsRoot).toBe(root);
    w.stop();
  });

  it('binding a real transcript reaches bound from any state', async () => {
    watcher.watch('s1', { cwd });
    watcher.noteConversationStarted('s1');
    expect(watcher.snapshot('s1')!.binding).toBe('searching');
    writeLines(path.join(projectDir(), 'native-1.jsonl'), [entry()]);
    await sleep(150);
    expect(watcher.snapshot('s1')!.binding).toBe('bound');
  });

  it('pushes a snapshot when the state MOVES, so the UI never waits on a line that is not coming', async () => {
    // The whole point: an unbound session produces no transcript lines, so the
    // usual emit-on-drain path never fires for it. Without this push the pane
    // would sit on its mount-time answer for ever.
    watcher.watch('s1', { cwd });
    const seen: string[] = [];
    const off = watcher.onUpdate((s) => seen.push(s.binding));
    watcher.noteConversationStarted('s1');
    await sleep(200); // ~8 poll ticks
    off();
    expect(seen).toContain('searching');
    // ...and it is a TRANSITION, not a 10Hz firehose: the poll re-derives the
    // state every tick, so without an early return on "nothing moved" this
    // would be one `sessions:usage` push per 100ms per unbound session.
    expect(seen).toHaveLength(1);
  });

  it('a corrected mis-bind restarts the clock instead of reporting failure on arrival', async () => {
    // `conversationStarted` survives a rebind (a turn demonstrably ran — that
    // is HOW we got here), so carrying the ORIGINAL evidence timestamp would
    // declare the fresh search failed the instant it began, ten minutes into a
    // healthy session.
    const w = new TranscriptWatcher({
      projectsRoot: root,
      log: createLogger(new LogSink({ dir: logDir }), 'transcripts'),
      pollMs: 10,
      bindGiveUpMs: 5_000,
    });
    w.watch('s1', { cwd });
    w.noteConversationStarted('s1');
    writeLines(path.join(projectDir(), 'native-1.jsonl'), [entry()]);
    await sleep(150);
    expect(w.snapshot('s1')!.binding).toBe('bound');

    w.setNativeSessionId('s1', 'a-different-conversation'); // mis-bind correction
    const snap = w.snapshot('s1')!;
    expect(snap.binding).toBe('searching');
    expect(snap.bindingDiag.searchingMs!).toBeLessThan(1_000);
    w.stop();
  });

  it('/clear drops the evidence too — a cleared, idle session is not a failure', async () => {
    // The same fact B1 rests on, one step further along: `/clear` mints a
    // BRAND-NEW conversation, and the CLI writes nothing for it until the next
    // prompt. Carrying the previous turn's evidence across the reset would put
    // a session you cleared and then walked away from into a red failure state
    // 45 seconds later. (A corrected MIS-BIND is the opposite case and must
    // keep its evidence — the test above covers that.)
    //
    // This needs TWO things to hold, and fails if either is dropped: the
    // cleared session must give up its `conversationStarted` latch, AND the
    // conversation it just abandoned — which stays on disk, unclaimable by us
    // for ever — must stop counting as a transcript we failed to pick up.
    const w = new TranscriptWatcher({
      projectsRoot: root,
      log: createLogger(new LogSink({ dir: logDir }), 'transcripts'),
      pollMs: 10,
      bindGiveUpMs: 30,
    });
    w.watch('s1', { cwd });
    w.noteConversationStarted('s1');
    writeLines(path.join(projectDir(), 'native-1.jsonl'), [entry()]);
    await sleep(150);
    expect(w.snapshot('s1')!.binding).toBe('bound');

    w.setNativeSessionId('s1', 'a-fresh-conversation', 'clear');
    await sleep(200); // many times the give-up deadline
    const snap = w.snapshot('s1')!;
    expect(snap.binding).toBe('awaiting-prompt');
    expect(snap.bindingDiag.conversationStarted).toBe(false);
    w.stop();
  });

  it('a bound session stops reporting search diagnostics about itself', async () => {
    // `searchingMs` kept counting up for the life of a healthy bound session,
    // and `candidateSeen` froze at whatever the binding sweep saw — two fields
    // that end up in a bug report saying the opposite of what is happening.
    watcher.watch('s1', { cwd });
    watcher.noteConversationStarted('s1');
    await sleep(60);
    expect(watcher.snapshot('s1')!.bindingDiag.searchingMs).not.toBeNull();

    writeLines(path.join(projectDir(), 'native-1.jsonl'), [entry()]);
    await sleep(150);
    const snap = watcher.snapshot('s1')!;
    expect(snap.binding).toBe('bound');
    expect(snap.bindingDiag.searchingMs).toBeNull();
    expect(snap.bindingDiag.candidateSeen).toBe(false);
  });

  it('evidence RETRACTS when a troubling file finds its rightful owner', async () => {
    // Two cards in one folder, neither bound: card 1's transcript is visible
    // to BOTH as an unclaimable candidate. Latching that would leave the
    // innocent card permanently marked and time it out into a red banner it
    // did nothing to deserve — so the flag is recomputed every poll.
    //
    // WATCH ORDER IS LOAD-BEARING. `poll()` iterates sessions in insertion
    // order, so with the owner watched FIRST it claims the file before the
    // other session ever sweeps, `isEvidence` already returns false, and the
    // end-state assertions below pass just as happily against a latching
    // implementation. Watching the innocent card first is what makes the
    // window real — verified: in this order `candidateSeen` genuinely goes
    // true and then back to false; in the other it is never true at all.
    watcher.watch('s2', { cwd, nativeSessionId: 'native-2' });
    watcher.watch('s1', { cwd, nativeSessionId: 'native-1' });

    const sawEvidence: boolean[] = [];
    const sampler = setInterval(() => {
      const s = watcher.snapshot('s2');
      if (s) sawEvidence.push(s.bindingDiag.candidateSeen);
    }, 5);
    writeLines(path.join(projectDir(), 'native-1.jsonl'), [entry({ sessionId: 'native-1' })]);
    await sleep(250);
    clearInterval(sampler);

    expect(watcher.snapshot('s1')!.binding).toBe('bound');
    // it WAS evidence for a moment — that is the state a latch would keep...
    expect(sawEvidence).toContain(true);
    // ...and it was given back the moment the file found its owner
    const s2 = watcher.snapshot('s2')!;
    expect(s2.bindingDiag.candidateSeen).toBe(false);
    expect(s2.bindingDiag.searchingMs).toBeNull(); // the clock reset with it
    expect(s2.binding).toBe('awaiting-prompt');
  });

  it('a sibling session bound file is not counted as evidence against us', async () => {
    // Two cards in one folder take turns; treating the other one's transcript
    // as "a file we could not claim" would make every same-folder pair report
    // a binding problem neither of them has.
    watcher.watch('s1', { cwd });
    writeLines(path.join(projectDir(), 'native-1.jsonl'), [entry()]);
    await sleep(150);
    expect(watcher.snapshot('s1')!.binding).toBe('bound');

    watcher.watch('s2', { cwd, nativeSessionId: 'native-2' });
    await sleep(150);
    const snap = watcher.snapshot('s2')!;
    expect(snap.bindingDiag.candidateSeen).toBe(false);
    expect(snap.binding).toBe('awaiting-prompt');
  });
});

// ---------------------------------------------------------------------------
// P2-E15-10 — the §5.26 drift detector, through the watcher
// ---------------------------------------------------------------------------
describe('transcript schema drift (P2-E15-10, §5.26)', () => {
  it('an unknown field warns ONCE naming it, and the line is ingested normally', async () => {
    // The done-when verbatim. The second clause is the one worth guarding: a
    // detector that quarantined the line it did not understand would trade a
    // silent schema break for outright data loss.
    const warnings: Array<{ msg: string; fields?: Record<string, unknown> }> = [];
    const base = createLogger(new LogSink({ dir: logDir }), 'transcripts');
    const log = {
      ...base,
      warn: (msg: string, fields?: Record<string, unknown>) => {
        warnings.push({ msg, fields });
        base.warn(msg, fields);
      },
    };
    const w = new TranscriptWatcher({ projectsRoot: root, log, pollMs: 20 });
    w.watch('s1', { cwd });
    const file = path.join(projectDir(), 'native-1.jsonl');
    const withUnknown = (n: number) =>
      entry({
        thinkingBudget: 4096,
        message: {
          usage: { input_tokens: n, output_tokens: n },
          content: [{ type: 'text', text: `line ${n}` }],
        },
      });
    writeLines(file, [withUnknown(1), withUnknown(2), withUnknown(3)]);
    await sleep(250);

    const drift = warnings.filter((x) => x.msg.includes('schema drift'));
    expect(drift).toHaveLength(1);
    expect(drift[0].fields?.key).toBe('thinkingBudget');

    // ...and nothing about ingestion changed
    const snap = w.snapshot('s1')!;
    expect(snap.bound).toBe(true);
    expect(snap.lines).toBe(3);
    expect(snap.malformed).toBe(0);
    expect(snap.usage).toMatchObject({ input: 6, output: 6 });
    expect(snap.driftKeys).toEqual(['thinkingBudget']);
    expect(w.blocks('s1').map((b) => b.text)).toEqual(['line 1', 'line 2', 'line 3']);
    w.stop();
  });

  it('a corpus-shaped transcript produces NO drift — the schema tracks reality', async () => {
    // The guard against the schema rotting away from the parser: these lines
    // carry the full shape measured across 250 real transcripts on 2026-07-31.
    // Teach the watcher a new field without declaring it, or let the declared
    // list decay, and this goes red.
    watcher.watch('s1', { cwd });
    const ts = new Date().toISOString();
    writeLines(path.join(projectDir(), 'native-1.jsonl'), [
      JSON.stringify({
        parentUuid: 'p', isSidechain: false, userType: 'external', cwd, sessionId: 'native-1',
        version: '2.1.220', gitBranch: 'main', entrypoint: 'cli', uuid: 'u1', requestId: 'r1',
        timestamp: ts, type: 'assistant', effort: 'high', promptId: 'pid',
        message: {
          id: 'm1', type: 'message', role: 'assistant', model: 'claude-opus-5',
          stop_reason: 'end_turn', stop_sequence: null, stop_details: null, diagnostics: {},
          content: [
            { type: 'thinking', thinking: 'hmm', signature: 'sig' },
            { type: 'text', text: 'answer' },
            { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a.md' }, caller: 'x' },
          ],
          usage: {
            input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3,
            cache_creation_input_tokens: 4, service_tier: 'standard',
            cache_creation: { ephemeral_5m_input_tokens: 4, ephemeral_1h_input_tokens: 0 },
            server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
            inference_geo: 'us', iterations: 1, speed: 'fast',
          },
        },
      }),
      JSON.stringify({ type: 'ai-title', aiTitle: 'A title', sessionId: 'native-1', timestamp: ts }),
      JSON.stringify({ type: 'file-history-snapshot', snapshot: {}, isSnapshotUpdate: false, messageId: 'm1' }),
      JSON.stringify({
        type: 'user', sessionId: 'native-1', cwd, timestamp: ts,
        toolUseResult: { stdout: 'x' }, sourceToolAssistantUUID: 'u1',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok', is_error: false }],
        },
      }),
    ]);
    await sleep(250);
    const snap = watcher.snapshot('s1')!;
    expect(snap.bound).toBe(true);
    expect(snap.driftKeys).toEqual([]);
    expect(snap.malformed).toBe(0);
  });
});

describe('discovery I/O is off the hot thread (P2-E15-11 / AR-P1-8)', () => {
  /** Count directory walking under the projects root. `drain()` uses statSync
   *  and readSync on a file it already holds; only discovery calls readdirSync,
   *  so this is a clean proxy for "walked the disk". */
  function countReaddirs(under: string): { calls: () => number; restore: () => void } {
    const real = fs.readdirSync;
    let n = 0;
    const spy = ((p: fs.PathLike, o?: unknown) => {
      if (String(p).startsWith(under)) n++;
      return (real as (p: fs.PathLike, o?: unknown) => unknown)(p, o);
    }) as typeof fs.readdirSync;
    fs.readdirSync = spy;
    return { calls: () => n, restore: () => { fs.readdirSync = real; } };
  }

  it('a bound session stops walking the disk every tick', async () => {
    const file = path.join(projectDir(), 'native-1.jsonl');
    writeLines(file, [entry()]);
    watcher.watch('s1', { cwd });
    await sleep(200);
    expect(watcher.snapshot('s1')!.bound).toBe(true);

    // Measure a quiet window AFTER binding: nothing is created, so the watch
    // has nothing to report and only the backoff can trigger a sweep.
    // try/finally: the spy replaces a global, and a leak would make every
    // later test in this file silently measure the wrong thing.
    const spy = countReaddirs(root);
    try {
      await sleep(500); // pollMs is 25 here => ~20 ticks
    } finally {
      spy.restore();
    }

    // Before this item every tick walked; the ladder caps at 2s, so a 500ms
    // quiet window allows at most a couple of sweeps. The assertion is against
    // TICKS, which is what makes it a regression test rather than a magic
    // number: revert the gate and this is ~20.
    expect(spy.calls()).toBeLessThan(5);
  });

  it('a bind prods the siblings on the NEXT tick, not a backoff step later', async () => {
    // The blocker review round 1 found: `claim()` marks the root dirty when it
    // binds, and `claim()` only ever runs from inside the poll loop — so
    // committing `noteSwept` AFTER the loop cleared, on the very same tick, the
    // flag the bind had just raised. The retraction mechanism was dead in the
    // only path that raises it, and the sibling waited out the ladder instead.
    //
    // Timing is what makes this discriminate: with the defect the sibling
    // re-sweeps at backoff[1] = 500ms, so a 120ms window fails.
    watcher.watch('s1', { cwd });
    watcher.watch('s2', { cwd }); // same folder => ambiguous, neither can claim yet
    writeLines(path.join(projectDir(), 'native-A.jsonl'), [entry({ sessionId: 'native-A' })]);
    await sleep(150);

    // Both see a file they cannot take: that is evidence against each of them.
    expect(watcher.snapshot('s1')!.bindingDiag.candidateSeen).toBe(true);
    expect(watcher.snapshot('s2')!.bindingDiag.candidateSeen).toBe(true);

    // Hooks name the owner; s2 binds it and s1's evidence must retract.
    watcher.setNativeSessionId('s2', 'native-A');
    await sleep(120);
    expect(watcher.snapshot('s2')!.bound).toBe(true);
    expect(watcher.snapshot('s1')!.bindingDiag.candidateSeen).toBe(false);
  });

  it('a permanently-unbound session does not starve its sibling of sweeps', async () => {
    // The bug this pins: `noteSwept` mutates the backoff, so calling it inside
    // the session loop lets the FIRST session on a root consume every sweep
    // opportunity — and `sessions` iterates in insertion order, so the same
    // session wins every time and the second one never discovers anything.
    //
    // It has to be set up carefully or it proves nothing (this test passed
    // against the broken implementation on the first attempt): s1 must stay
    // unbound for the whole window, because the moment it binds it stops
    // taking the discovery branch and releases the sweeps it was hogging. And
    // the watch must be OFF, or real filesystem events keep re-dirtying the
    // root and hand out the extra opportunities that hide the starvation.
    const w = new TranscriptWatcher({
      projectsRoot: root,
      log: createLogger(new LogSink({ dir: logDir }), 'transcripts'),
      pollMs: 25,
      discovery: { watchFactory: () => null, watchFailedMs: 50 },
    });
    try {
      const cwd2 = 'C:/tmp/tw-project-two';
      w.watch('s1', { cwd }); // first in insertion order, and never gets a transcript
      w.watch('s2', { cwd: cwd2 });

      const d2 = path.join(root, slugForCwd(cwd2));
      fs.mkdirSync(d2, { recursive: true });
      writeLines(path.join(d2, 'native-2.jsonl'), [
        JSON.stringify({ type: 'assistant', sessionId: 'native-2', cwd: cwd2, timestamp: new Date().toISOString() }),
      ]);

      await sleep(400);
      expect(w.snapshot('s1')!.bound).toBe(false); // the setup is still honest
      expect(w.snapshot('s2')!.bound).toBe(true);
    } finally {
      w.stop();
    }
  });
});

describe('discovery still works with no filesystem watch at all (P2-E15-11 fail-open)', () => {
  // Recursive fs.watch is unsupported on some Linux builds and unreliable over
  // network homes. The watch is an ACCELERATOR; every guarantee below is met by
  // the timed sweeps alone. If these fail, the feature is not shippable.
  function blindWatcher(over: Partial<ConstructorParameters<typeof TranscriptWatcher>[0]> = {}) {
    return new TranscriptWatcher({
      projectsRoot: root,
      log: createLogger(new LogSink({ dir: logDir }), 'transcripts'),
      pollMs: 25,
      discovery: { watchFactory: () => null, watchFailedMs: 50 },
      ...over,
    });
  }

  it('binds a transcript that appears, on the backoff alone', async () => {
    const w = blindWatcher();
    try {
      w.watch('s1', { cwd });
      await sleep(80);
      expect(w.snapshot('s1')!.bound).toBe(false);
      writeLines(path.join(projectDir(), 'native-1.jsonl'), [entry()]);
      await sleep(300);
      expect(w.snapshot('s1')!.bound).toBe(true);
    } finally {
      w.stop();
    }
  });

  it('the widen-after-grace fallback still binds when slug math fails', async () => {
    // The session's cwd hashes to one slug; the transcript is written under a
    // DIFFERENT directory, so only the widened full-root scan can find it —
    // and here it has to get there with no watch events to prod it.
    const w = blindWatcher({ widenAfterMs: 50 });
    try {
      w.watch('s1', { cwd });
      const odd = path.join(root, 'slug-rules-changed-under-us');
      fs.mkdirSync(odd, { recursive: true });
      writeLines(path.join(odd, 'native-1.jsonl'), [entry()]);
      await sleep(400);
      expect(w.snapshot('s1')!.bound).toBe(true);
    } finally {
      w.stop();
    }
  });
});
