import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { TranscriptWatcher, slugForCwd, conversationExists } from './watcher';
import { LogSink, createLogger } from '../log/logger';

let root: string;
let cwd: string;
let watcher: TranscriptWatcher;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-tw-root-'));
  cwd = 'C:/tmp/tw-project';
  watcher = new TranscriptWatcher({
    projectsRoot: root,
    log: createLogger(new LogSink({ dir: root }), 'transcripts'),
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
    expect(bash.tool).toMatchObject({ summary: 'echo hi', description: 'Say hi', out: 'hi' });
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

describe('pre-existing transcripts are never adopted', () => {
  it('ignores files that existed before the watcher started', async () => {
    const file = path.join(projectDir(), 'old.jsonl');
    writeLines(file, [entry()]);
    const w2 = new TranscriptWatcher({
      projectsRoot: root,
      log: createLogger(new LogSink({ dir: root }), 'transcripts'),
      pollMs: 25,
    });
    w2.watch('s1', { cwd });
    writeLines(file, [entry({ message: { usage: { output_tokens: 99 } } })]);
    await sleep(120);
    expect(w2.snapshot('s1')!.bound).toBe(false);
    expect(w2.snapshot('s1')!.usage.output).toBe(0);
    w2.stop();
  });
});
