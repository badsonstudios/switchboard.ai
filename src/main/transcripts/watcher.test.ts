import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { TranscriptWatcher, slugForCwd, conversationExists } from './watcher';
import { LogSink, createLogger } from '../log/logger';
import { cleanupTempDirs, tempDir } from '../../test-temp-dirs';
import { readAiTitle } from '../providers/claude';
import { CapturedTitles, LATE, REPEAT_HEAVY, REVISED, rebuild, titlesOf } from './fixtures/ai-title';

let root: string;
let logDir: string;
let cwd: string;
let watcher: TranscriptWatcher;

/**
 * EVERY watcher this file starts — the shared one and the extras a test builds
 * for itself (#180).
 *
 * Registered centrally rather than stopped at the end of a test body, so a
 * FAILING assertion still releases the handle: a live watcher holds `fs.watch`
 * on its root, and on Windows that open directory handle is exactly what makes
 * the teardown rm fail with EBUSY — i.e. what turns a leak fix into a phantom
 * failure. Tests keep their own `stop()` calls; `stop()` is idempotent, and
 * stopping early is still the right thing when a test wants the watcher quiet
 * before its last assertions.
 */
const extras: TranscriptWatcher[] = [];

/** `new TranscriptWatcher(...)`, plus the bookkeeping teardown needs. Every
 *  watcher in this file is built through it. */
function makeWatcher(opts: ConstructorParameters<typeof TranscriptWatcher>[0]): TranscriptWatcher {
  const w = new TranscriptWatcher(opts);
  extras.push(w);
  return w;
}

function stopExtras(): void {
  for (const w of extras) {
    try {
      w.stop();
    } catch {
      /* teardown must never turn into a failure of its own */
    }
  }
  extras.length = 0;
}

beforeEach(() => {
  root = tempDir('sb-tw-root-');
  // The log sink gets its OWN directory, deliberately. It used to write into
  // `root` — i.e. inside the very tree the watcher scans — which was harmless
  // while discovery was a blind 100ms poll (`scan` only collects `.jsonl`).
  // With P2-E15-11 the root is under `fs.watch`, so creating a log file raises
  // a `rename` event and prods discovery. That is not just noise: it silently
  // defeated a regression test, which passed against the very defect it was
  // written to catch because the watcher's own "transcript bound" log line was
  // re-dirtying the root for it.
  logDir = tempDir('sb-tw-log-');
  cwd = 'C:/tmp/tw-project';
  watcher = makeWatcher({
    projectsRoot: root,
    log: createLogger(new LogSink({ dir: logDir }), 'transcripts'),
    pollMs: 25,
  });
});

afterEach(() => {
  // Un-skippable backstop for the one test that fakes `Date` (#183). It has
  // its own `finally`, but a frozen clock leaking into the rest of the file
  // would break the wall-clock-deadline tests far from the cause, so the
  // restore also lives somewhere no code path in a test body can miss. A
  // no-op when timers were never faked, which is every other test here.
  vi.useRealTimers();
  // Every watcher stopped — `watcher` included, it is registered like any other
  // — BEFORE the rm, so no handle on `root` survives into it. Nothing here is
  // allowed to throw on the way to the rm: that would leak the dirs AND report
  // a failed file with no failing test (#167).
  stopExtras();
  // Both dirs were leaked outright until this line — MEASURED at 102 orphaned
  // directories per run (two per test) against an isolated `TEMP`, and 0 after
  // — on a file that runs dozens of times a day on a dev machine (#180).
  //
  // Every directory this file makes is per-TEST, which is the precondition for
  // sweeping the whole registry here rather than naming dirs one by one. It
  // takes `rootB` too (the block below registers it and has no teardown of its
  // own), and it carries the Windows file-lock requeue this file used to spell
  // out for itself: whatever will not go stays pending, is retried by the next
  // teardown, and finally by `test-setup.ts`'s `afterAll` net — which is why
  // the local `afterAll` that used to do that last pass is gone (#213, #360).
  cleanupTempDirs();
});

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

/** Wait for a condition instead of guessing a sleep: discovery runs on a
 *  backoff ladder that reaches 2s while a session stays unbound, so a fixed
 *  wait would be a flake generator on a loaded machine. */
async function waitFor(cond: () => boolean, timeoutMs = 4000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (cond()) return;
    await sleep(25);
  }
  expect(cond(), 'condition never became true').toBe(true);
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

  // #156 / S-11. A LOCAL slash command (`/usage`, `/cost`, `/context`) writes
  // NO assistant entry — the output arrives as `system:local_command` — so the
  // Session view rendered nothing at all for one. This is the transcript half
  // of the fix, which every PTY session gets too.
  it('renders a local slash command\'s output, wrapper stripped (#156)', async () => {
    watcher.watch('s1', { cwd });
    const file = path.join(projectDir(), 'native-1.jsonl');
    writeLines(file, [
      entry({ type: 'user', isMeta: true, message: { role: 'user', content: '<local-command-caveat>x</local-command-caveat>' } }),
      entry({ type: 'user', message: { role: 'user', content: '<command-name>/usage</command-name>' } }),
      entry({
        type: 'system',
        subtype: 'local_command',
        level: 'info',
        isMeta: false,
        content: '<local-command-stdout>Current session: 2% used</local-command-stdout>',
        message: undefined,
      }),
    ]);
    await sleep(150);
    const blocks = watcher.blocks('s1');
    expect(blocks.map((b) => b.kind)).toEqual(['user', 'assistant']);
    // the invocation, which the renderer collapses to a `/usage` pill…
    expect(blocks[0].text).toBe('<command-name>/usage</command-name>');
    // …and the output, which used to be dropped on the floor entirely
    expect(blocks[1].text).toBe('Current session: 2% used');
  });

  // A stream session's Feed is built from typed messages (P2-E18-10). The
  // watcher still binds, counts usage and learns the native id for it — it just
  // must not ALSO derive blocks, or every one of them would render twice.
  it('derives no blocks at all when the Feed has another source (deriveFeed: false)', async () => {
    watcher.watch('s1', { cwd, deriveFeed: false });
    const file = path.join(projectDir(), 'native-1.jsonl');
    const seen: string[] = [];
    const off = watcher.onBlock((_sid, b) => seen.push(b.kind));
    writeLines(file, [
      entry({ type: 'user', message: { role: 'user', content: 'do the thing' } }),
      entry({ message: { content: [{ type: 'text', text: 'done' }] }, usage: undefined }),
    ]);
    await sleep(150);
    off();
    expect(seen).toEqual([]);
    expect(watcher.blocks('s1')).toEqual([]);
    // …and the rest of the watch is untouched: it still bound and read the file
    expect(watcher.snapshot('s1')!.bound).toBe(true);
    expect(watcher.snapshot('s1')!.lines).toBe(2);
  });
});

describe('positive evidence required to claim (Dan 2026-07-22: summary-first files)', () => {
  it('a summary-first file (no cwd on line 1) is NOT claimed by a foreign-folder session', async () => {
    // widen quickly so the full-root scan definitely sees the foreign file
    const w2 = makeWatcher({
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
  // The deadline this test is about is read off the WALL CLOCK inside the
  // watcher (`claim()`: `Date.now() - w.watchedSince < deadline`), but the
  // "inside the deadline" assertion is reached after a real `await sleep()`.
  // Those are two different clocks the moment the machine is busy: under CPU
  // saturation the sleep overshoots, the poll catches up while it is still
  // pending, and the assertion lands OUTSIDE the window it was written to
  // probe — measured at 182ms against the 120ms deadline, failing with
  // "expected true to be false" for a reason that has nothing to do with the
  // rule under test (#183; seen by two independent workers under load).
  //
  // The fix is to stop racing: fake ONLY `Date`, so setTimeout, the poll and
  // `fs.watch` all still run for real, and the clock the watcher measures its
  // own deadline against becomes the test's to move rather than the machine's.
  // The pre-deadline assertion is then unfalsifiable by load — no number of
  // poll ticks can cross a deadline whose clock has not moved.
  //
  // What freezing `Date` DOES change, and why it is still sound: the discovery
  // sweep ladder is on the same clock (`shouldSweep` compares `now` against
  // `lastSweepAt`), so exactly ONE sweep happens in the frozen window instead
  // of the ladder's several. That one is guaranteed and is all the test needs
  // — `DiscoverySchedule.register()` marks a newly watched root dirty, and
  // `dirty` short-circuits the ladder. The setup below (mkdir, write, both
  // `watch()` calls) is synchronous, so that first sweep necessarily lands
  // AFTER fileA exists. It is therefore not waiting on an `fs.watch` event
  // either, which is what makes the frozen half deterministic rather than
  // merely lucky.
  it('two same-cwd sessions bind best-effort after the deadline, one file each', async () => {
    let w2: TranscriptWatcher | undefined;
    try {
      // Installed before `watch()`, which stamps `watchedSince` — the other
      // half of the deadline subtraction. (The constructor reads no clock.)
      vi.useFakeTimers({ toFake: ['Date'] }); // Date only — setTimeout stays real
      w2 = makeWatcher({
        projectsRoot: root,
        log: createLogger(new LogSink({ dir: logDir }), 'transcripts'),
        pollMs: 25,
        cwdBindFallbackMs: 120,
      });
      w2.watch('s1', { cwd });
      w2.watch('s2', { cwd });
      const fileA = path.join(projectDir(), 'native-A.jsonl');
      writeLines(fileA, [entry({ sessionId: 'native-A' })]);
      // Deliberately longer than the 120ms deadline in real time: with the
      // watcher's clock frozen this is now "let discovery run", not "stay
      // inside the window". ~6 real poll ticks, one of which sweeps.
      await sleep(150);
      // inside the deadline the ambiguity rule still holds
      expect(w2.snapshot('s1')!.bound).toBe(false);
      expect(w2.snapshot('s2')!.bound).toBe(false);
      // ...and it is a REFUSAL, not "discovery hasn't looked yet" — both
      // sessions swept, found fileA, and declined it. `candidateSeen` is only
      // ever set from a sweep that ran `claim()` and got `false` back, so with
      // the elapsed deadline pinned at exactly 0 these two lines pin the
      // refusal to the ambiguity branch and nothing else. Without them the
      // frozen clock could buy a vacuous pass.
      expect(w2.snapshot('s1')!.bindingDiag.candidateSeen).toBe(true);
      expect(w2.snapshot('s2')!.bindingDiag.candidateSeen).toBe(true);

      // Hand the clock back: real time is already past the 120ms deadline
      // (a forward-only jump of ~150ms — well under `widenAfterMs` 10s and
      // `bindGiveUpMs` 45s, so neither of those changes behaviour), and from
      // here the test runs exactly as it always did. What remains is one
      // monotone assertion and one load-INVARIANT one, so load has nothing
      // left to break. It does still ride an `fs.watch` event to pick up
      // fileB inside the last sleep — but that is unchanged by this fix and
      // is the same shape as the sibling tests below.
      vi.useRealTimers();
      await sleep(200); // past the deadline: best-effort binding proceeds
      const fileB = path.join(projectDir(), 'native-B.jsonl');
      writeLines(fileB, [entry({ sessionId: 'native-B' })]);
      await sleep(150);
      const bound = [w2.snapshot('s1')!, w2.snapshot('s2')!].filter((s) => s.bound);
      expect(bound).toHaveLength(2);
      // never the SAME file twice (claim skips files another session owns)
      expect(new Set(bound.map((s) => s.nativeSessionId)).size).toBe(2);
    } finally {
      // Both must survive a failed assertion: leaked fake timers would freeze
      // `Date` for every test after this one — and the tests after this one
      // are the OTHER wall-clock-deadline tests, so the damage would surface
      // nowhere near its cause — and a leaked watcher keeps polling and holds
      // an fs.watch on the root for the rest of the file's run. The clock goes
      // back FIRST so that a throwing `stop()` cannot strand it.
      vi.useRealTimers();
      w2?.stop();
    }
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
    const w2 = makeWatcher({
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
    const w2 = makeWatcher({
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

  // No teardown of its own, deliberately. These tests point a watcher at
  // `rootB` and discovery puts it under `fs.watch` — an open directory handle,
  // closed synchronously by `stop()` — so the rm MUST come after every watcher
  // is stopped. An inner `afterEach` runs BEFORE the outer one, i.e. before
  // `stopExtras()`, so deleting from here used to need its own `stopExtras()`
  // call to avoid an EBUSY that vitest reports as a failed FILE with zero
  // failing tests (the #167 shape). Registering the directory instead puts it
  // in the outer teardown's sweep, which is already on the right side of the
  // stop. (`extras` lives at file scope since #180 — EVERY watcher in the file
  // is registered with it, not just this block's.)
  beforeEach(() => {
    rootB = tempDir('sb-tw-rootb-');
  });

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
    const w2 = makeWatcher({
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
    const w = makeWatcher({
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
    const w = makeWatcher({
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
    const w = makeWatcher({
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
    const w = makeWatcher({
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
    const w = makeWatcher({
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
    const w = makeWatcher({ projectsRoot: root, log, pollMs: 20 });
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
    const w = makeWatcher({
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

  // --- #129: a session that has GIVEN UP stops full-scanning the root --------
  //
  // AR-P1-8 left one population paying for ever: once `widen` is true every
  // swept tick is a full `scan(root)` — ~2,100 syscalls on Dan's tree — and the
  // ladder's floor (2s) or the watch-failed rung (500ms) kept that going long
  // after `deriveBinding` said `unbound` at 45s and the UI told the user we had
  // given up. These use the watch-failed rung deliberately: it is the worst
  // measured case (~4,200 syscalls/sec per card), and with no `fs.watch` the
  // ONLY thing that can find a transcript is a sweep, so "it stopped sweeping"
  // and "it can still bind" are both real claims here rather than artefacts of
  // an event arriving to save us.
  function blindGiveUpWatcher(over: Partial<ConstructorParameters<typeof TranscriptWatcher>[0]> = {}) {
    return makeWatcher({
      projectsRoot: root,
      log: createLogger(new LogSink({ dir: logDir }), 'transcripts'),
      pollMs: 25,
      widenAfterMs: 30, // the expensive branch — a full walk of the root
      bindGiveUpMs: 60,
      discovery: { watchFactory: () => null, watchFailedMs: 50, givenUpMs: 5_000, backoffMs: [25, 50] },
      ...over,
    });
  }

  it('a session that GAVE UP stops walking the tree — and still binds on evidence', async () => {
    const w = blindGiveUpWatcher();
    try {
      w.watch('s1', { cwd });
      w.noteConversationStarted('s1'); // a turn ran: the give-up clock starts
      await waitFor(() => w.snapshot('s1')!.binding === 'unbound');
      await sleep(150); // spend the fast sweeps the start-up prods bought

      const spy = countReaddirs(root);
      let quiet = 0;
      try {
        await sleep(500); // 20 ticks
      } finally {
        quiet = spy.calls();
        spy.restore();
      }
      // The assertion is against TICKS, like its sibling above: on the
      // watch-failed rung this window is ~10 full scans of the root, and before
      // P2-E15-11 it was ~20. The slow rung here is 5s, so it is 0 or the one
      // sweep a slow machine might still owe from before the give-up.
      expect(quiet).toBeLessThan(2);

      // The other half of the done-when, and the reason the rung is slow rather
      // than off: a give-up must never become a session that can NEVER bind.
      // The transcript is on disk and nothing can see it appear — no watch —
      // so the only thing that can find it is a prod putting discovery back on
      // the fast ladder.
      writeLines(path.join(projectDir(), 'native-1.jsonl'), [entry()]);
      await sleep(150);
      expect(w.snapshot('s1')!.bound).toBe(false); // still quiet: 6 ticks, no sweep

      w.setNativeSessionId('s1', 'native-1'); // a late hook — a markDirty site
      await waitFor(() => w.snapshot('s1')!.bound === true, 1_000);
      expect(w.snapshot('s1')!.binding).toBe('bound');
    } finally {
      w.stop();
    }
  });

  it('a LATER turn prods it — the evidence latch is not a bookkeeping latch', async () => {
    // The prod a user who simply keeps typing produces, and the one this item
    // most needs to work: `conversationStarted` is a one-way latch, so every
    // turn after the first used to reach it and stop — and by construction
    // EVERY given-up session has that latch closed already (the give-up clock
    // only starts once a turn has run). With no watch and no hooks changing the
    // native id, this is the only thing between such a card and the slow rung.
    const w = blindGiveUpWatcher();
    try {
      w.watch('s1', { cwd });
      w.noteConversationStarted('s1'); // the turn that starts the give-up clock
      await waitFor(() => w.snapshot('s1')!.binding === 'unbound');
      await sleep(150);

      writeLines(path.join(projectDir(), 'native-1.jsonl'), [entry()]);
      await sleep(150);
      expect(w.snapshot('s1')!.bound).toBe(false); // the slow rung is holding

      w.noteConversationStarted('s1'); // ...and the user prompts it again
      await waitFor(() => w.snapshot('s1')!.bound === true, 1_000);
    } finally {
      w.stop();
    }
  });

  it('one live BOUND session keeps the whole root fast — subagents still turn up', async () => {
    // The populations this must not conflate. A bound session is not done with
    // discovery: `subagentFiles()` only runs on a swept tick, so dropping a
    // root to 30s because a NEIGHBOURING card gave up would hide a subagent
    // transcript for half a minute. Its vote is `binding !== 'unbound'`, which
    // is why the quorum is not "nothing here is searching".
    const w = blindGiveUpWatcher();
    try {
      const cwd2 = 'C:/tmp/tw-project-bound';
      const d2 = path.join(root, slugForCwd(cwd2));
      fs.mkdirSync(d2, { recursive: true });

      w.watch('s1', { cwd }); // never gets a transcript: gives up at 60ms
      w.noteConversationStarted('s1');
      w.watch('s2', { cwd: cwd2 });
      writeLines(path.join(d2, 'native-2.jsonl'), [
        JSON.stringify({ type: 'assistant', sessionId: 'native-2', cwd: cwd2, timestamp: new Date().toISOString() }),
      ]);
      await waitFor(() => w.snapshot('s2')!.bound === true);
      await waitFor(() => w.snapshot('s1')!.binding === 'unbound');
      await sleep(150);

      const spy = countReaddirs(root);
      try {
        await sleep(300);
      } finally {
        expect(spy.calls()).toBeGreaterThan(0);
        spy.restore();
      }
    } finally {
      w.stop();
    }
  });

  it('a QUIESCED session casts no vote — a corpse cannot hold the root fast (#200)', async () => {
    // The same set-up as above with s2 CRASHED. Its watch is frozen: it does no
    // I/O and can learn nothing, so counting its `bound` as "still looking"
    // would keep the root scanning for ever on behalf of a dead session — the
    // exact leak #200 removed for the corpse's own watch, re-created via its
    // neighbour's.
    //
    // WHAT THIS STILL PROVES, after #388: that s1 stops walking beside a corpse,
    // and that the corpse stays readable. It no longer ISOLATES the `quiesced`
    // clause of `stillLooking` — deleting that clause leaves this green, because
    // the per-session gate throttles s1 to the same rung whether the root is
    // fast or not. That is not a hole in the test; it is what #388 did to the
    // cost. See `stillLooking` for the claim the clause makes now.
    const w = blindGiveUpWatcher({ postExitSettleMs: 20 });
    try {
      const cwd2 = 'C:/tmp/tw-project-corpse';
      const d2 = path.join(root, slugForCwd(cwd2));
      fs.mkdirSync(d2, { recursive: true });

      w.watch('s1', { cwd });
      w.noteConversationStarted('s1');
      w.watch('s2', { cwd: cwd2 });
      writeLines(path.join(d2, 'native-2.jsonl'), [
        JSON.stringify({ type: 'assistant', sessionId: 'native-2', cwd: cwd2, timestamp: new Date().toISOString() }),
      ]);
      await waitFor(() => w.snapshot('s2')!.bound === true);
      await waitFor(() => w.snapshot('s1')!.binding === 'unbound');

      w.noteSessionExited('s2'); // the CLI died; the watch drains, then freezes
      await sleep(200); // past the settle window, and past the fast sweeps

      const spy = countReaddirs(root);
      try {
        await sleep(400);
      } finally {
        expect(spy.calls()).toBeLessThan(2);
        spy.restore();
      }
      // ...and the corpse is still fully readable, which is the whole of #200.
      expect(w.snapshot('s2')!.bound).toBe(true);
    } finally {
      w.stop();
    }
  });

  // --- #388: the throttle is per ROOT, but the cost is per SESSION -----------
  //
  // #129 stopped the tree being walked for a root nobody was looking at. It did
  // not stop it being walked FOR a session nobody is looking for, because
  // `poll()` runs `discoveryCandidates(w, widen)` — a full `scan(root)` once
  // widened — for EVERY unbound session on a swept tick. One live card is enough
  // to keep the root on the fast ladder, so every card beside it that had
  // already given up kept paying ~2,100 syscalls a sweep, for ever. That is the
  // normal multi-card state of this app.
  //
  // These separate the two costs, which is what makes the claim provable rather
  // than merely plausible. `atRoot` counts `readdirSync` OF THE ROOT ITSELF —
  // where a widened discovery scan starts, and where a bound session's
  // `subagentFiles()` never goes. `under` counts anything below it, which on
  // these roots is `subagentFiles()` and nothing else. So one window measures
  // both "the throttled card stopped walking" AND "the root is still sweeping
  // for the card that needs it"; without the second, every assertion here would
  // pass just as well against a poll timer that had stopped altogether.
  function countWalks(root: string): {
    atRoot: () => number;
    under: () => number;
    restore: () => void;
  } {
    const real = fs.readdirSync;
    let atRoot = 0;
    let under = 0;
    const spy = ((p: fs.PathLike, o?: unknown) => {
      const s = String(p);
      if (s === root) atRoot++;
      else if (s.startsWith(root)) under++;
      return (real as (p: fs.PathLike, o?: unknown) => unknown)(p, o);
    }) as typeof fs.readdirSync;
    fs.readdirSync = spy;
    return { atRoot: () => atRoot, under: () => under, restore: () => { fs.readdirSync = real; } };
  }

  /** A root with a LIVE bound card (s2) holding it on the fast ladder, and a
   *  card that has given up beside it (s1) — the state #129 leaves behind. No
   *  `fs.watch`, so a sweep is the only thing that can find anything. */
  async function mixedRoot(over: Partial<ConstructorParameters<typeof TranscriptWatcher>[0]> = {}) {
    const w = blindGiveUpWatcher(over);
    const cwd2 = 'C:/tmp/tw-project-live';
    const d2 = path.join(root, slugForCwd(cwd2));
    fs.mkdirSync(d2, { recursive: true });
    w.watch('s1', { cwd }); // never gets a transcript
    w.noteConversationStarted('s1'); // ...but a turn ran, so it gives up at 60ms
    w.watch('s2', { cwd: cwd2 });
    writeLines(path.join(d2, 'native-2.jsonl'), [
      JSON.stringify({ type: 'assistant', sessionId: 'native-2', cwd: cwd2, timestamp: new Date().toISOString() }),
    ]);
    await waitFor(() => w.snapshot('s2')!.bound === true);
    await waitFor(() => w.snapshot('s1')!.binding === 'unbound');
    await sleep(250); // spend the fast sweeps the start-up prods bought
    return w;
  }

  it('a card that gave up stops full-scanning even while a live card keeps the root fast', async () => {
    const w = await mixedRoot();
    try {
      const spy = countWalks(root);
      let atRoot = 0;
      let under = 0;
      try {
        await sleep(400); // ~16 ticks; the root is on the 50ms watch-failed rung
      } finally {
        atRoot = spy.atRoot();
        under = spy.under();
        spy.restore();
      }
      // Before this item s1 walked the root on every one of the root's ~8 sweeps
      // in this window. Its own rung here is 5s, so it walks 0 or the one sweep
      // a slow machine might still owe it.
      expect(atRoot).toBeLessThan(2);
      // ...and the root really IS still sweeping — `subagentFiles()` runs for
      // bound s2 on every swept tick. Without this the assertion above would
      // pass against a watcher that had simply stopped polling, which is the
      // regression this item is most able to cause.
      expect(under).toBeGreaterThan(0);
      // ...and the ROOT is still on the fast ladder, which is the other half of
      // "per session, not per root". Counting syscalls cannot show this any
      // more — that is exactly what #388 changed — so the schedule is asked
      // directly. Without it, deleting the give-up quorum from `poll()` passes
      // every test in this file.
      expect(w.discoveryStats(root)!.givenUp).toBe(false);
    } finally {
      w.stop();
    }
  });

  it('...and the root DOES go quiet once the live card stops looking too (#129)', async () => {
    // The per-root rung is still the outer bound, and after #388 this is the
    // only way to see it: every byte of disk work is now decided per session, so
    // a root that gave up and a root on the fast ladder cost the same in
    // syscalls. Mutation-checked — with `stillLooking` ignored in the quorum,
    // nothing else in this file fails.
    const w = await mixedRoot({ postExitSettleMs: 20 });
    try {
      expect(w.discoveryStats(root)!.givenUp).toBe(false); // s2 is bound and live
      w.noteSessionExited('s2'); // ...and now it is a corpse, which casts no vote
      await waitFor(() => w.discoveryStats(root)!.givenUp === true, 2_000);
      // The death is an evidence site, so it buys one last pass down the ladder
      // (#200) before the rung applies — the reprieve and the rung, in order.
      await waitFor(() => w.discoveryStats(root)!.backoffMs === 5_000, 2_000);
      // The corpse is still fully readable, which is the whole of #200.
      expect(w.snapshot('s2')!.bound).toBe(true);
    } finally {
      w.stop();
    }
  });

  it('...and any evidence puts it straight back to looking properly', async () => {
    // The recovery half, per session — a session that has stopped looking must
    // never become one that can NEVER bind. Its own state does not change here
    // (it is still `unbound`, and stays so until it binds), so the ONLY thing
    // that can restore it is the reprieve `noteSwept` reports.
    const w = await mixedRoot();
    try {
      writeLines(path.join(projectDir(), 'native-1.jsonl'), [entry()]);
      const spy = countWalks(root);
      let under = 0;
      try {
        await sleep(300);
      } finally {
        under = spy.under();
        spy.restore();
      }
      // The root really was sweeping throughout — s1 sat those sweeps out.
      expect(under).toBeGreaterThan(0);
      expect(w.snapshot('s1')!.bound).toBe(false); // the per-session rung holds

      w.noteConversationStarted('s1'); // the user simply prompts it again
      await waitFor(() => w.snapshot('s1')!.bound === true, 1_000);
    } finally {
      w.stop();
    }
  });

  it('...and it still binds with no evidence at all, once its own rung comes round', async () => {
    // The floor that stops the gate becoming an off switch: with the watch dead,
    // the hooks silent and every sibling quiet, nothing prods anything — so the
    // only thing that can bind this transcript is the session's own quiet rung
    // coming round. `GIVEN_UP_MS` in production; 300ms here.
    const w = await mixedRoot({ discovery: { watchFactory: () => null, watchFailedMs: 50, givenUpMs: 300, backoffMs: [25, 50] } });
    try {
      writeLines(path.join(projectDir(), 'native-1.jsonl'), [entry()]);
      await waitFor(() => w.snapshot('s1')!.bound === true, 2_000);
    } finally {
      w.stop();
    }
  });

  it('a card nobody ever prompted stops holding its root fast', async () => {
    // The second half of the item. `awaiting-prompt` never times out as a
    // VERDICT, deliberately — a card you opened and walked away from is not
    // broken — but it used to vote to keep its root on the fast ladder for the
    // life of the process while doing exactly what a given-up card does: walking
    // 2,090 entries to look for a transcript the CLI does not write until the
    // first prompt.
    const w = blindGiveUpWatcher({ unpromptedFastMs: 60 });
    try {
      w.watch('s1', { cwd }); // opened, never typed into
      await sleep(300); // past the 60ms window and the start-up reprieve

      const spy = countWalks(root);
      let atRoot = 0;
      try {
        await sleep(400);
      } finally {
        atRoot = spy.atRoot();
        spy.restore();
      }
      // This card is alone on the root, so both halves of the item point the
      // same way: it stops voting, so #129's rung applies to the root, and it
      // would be gated even if the root were fast for somebody else.
      expect(atRoot).toBeLessThan(2);
      // ...and the card still says what it always said. This is a scheduling
      // change, not a verdict: nobody has prompted it, so nothing is wrong.
      expect(w.snapshot('s1')!.binding).toBe('awaiting-prompt');
    } finally {
      w.stop();
    }
  });

  it('...and it picks the conversation up the moment you do prompt it', async () => {
    const w = blindGiveUpWatcher({ unpromptedFastMs: 60 });
    try {
      w.watch('s1', { cwd });
      await sleep(300);
      writeLines(path.join(projectDir(), 'native-1.jsonl'), [entry()]);
      await sleep(300);
      expect(w.snapshot('s1')!.bound).toBe(false); // quiet, with no watch to help

      w.noteConversationStarted('s1'); // the first prompt
      await waitFor(() => w.snapshot('s1')!.bound === true, 1_000);
    } finally {
      w.stop();
    }
  });

  it('a card you DO prompt promptly is untouched — this is a timeout, not a veto', async () => {
    // The case the timeout exists to protect, and the reason `awaiting-prompt`
    // is not simply excluded from the quorum: for the window in which a first
    // prompt is actually likely, a fresh card gets the full fast ladder even
    // with both accelerators dead. Break the timeout into "never votes" and this
    // card waits out the 5s quiet rung instead.
    //
    // The 400ms matters and cost a mutation round to find. The `widen` latch
    // marks the root dirty at 30ms, which buys a full pass down the ladder — so
    // a transcript written a hundred milliseconds in is found by that reprieve
    // whether this card votes or not, and the test proves nothing. This one is
    // written long after the reprieve is spent, where the only thing that can
    // still find it is the fast rung the card's vote is holding open.
    const w = blindGiveUpWatcher({ unpromptedFastMs: 5_000 });
    try {
      w.watch('s1', { cwd });
      await sleep(400); // way past a 60ms timeout, still well inside a 5s one
      writeLines(path.join(projectDir(), 'native-1.jsonl'), [entry()]);
      await waitFor(() => w.snapshot('s1')!.bound === true, 1_000);
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
    return makeWatcher({
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

describe('descriptor hygiene on the read error path (#179)', () => {
  // Fail-open has a second half nobody wrote down until this bug: our failures
  // must not cost the user their FILES either. A read that threw between
  // `openSync` and `closeSync` used to leak the descriptor, and on Windows an
  // open handle pins the transcript — the CLI's own rotation/delete then fails
  // with EBUSY for as long as the app runs.

  /** Instrument `fs` so every descriptor we take on a `.jsonl` is tracked and
   *  every read of one throws. The caller MUST call `restore()` in a `finally`
   *  — vitest is not configured to restore mocks between tests. */
  function trapTranscriptReads() {
    const realOpen = fs.openSync.bind(fs);
    const realClose = fs.closeSync.bind(fs);
    const realRead = fs.readSync.bind(fs) as (...args: unknown[]) => number;
    const opened = new Map<number, string>();
    const closed = new Set<number>();
    vi.spyOn(fs, 'openSync').mockImplementation(((file: fs.PathLike, flags: never, mode: never) => {
      const fd = realOpen(file, flags, mode);
      if (String(file).endsWith('.jsonl')) opened.set(fd, String(file));
      return fd;
    }) as typeof fs.openSync);
    vi.spyOn(fs, 'closeSync').mockImplementation((fd: number) => {
      closed.add(fd);
      realClose(fd);
    });
    vi.spyOn(fs, 'readSync').mockImplementation((fd: number, ...rest: unknown[]) => {
      if (opened.has(fd)) throw Object.assign(new Error('EIO: simulated read failure'), { code: 'EIO' });
      return realRead(fd, ...rest);
    });
    return {
      /** how many transcript descriptors were taken — 0 means the test proved
       *  nothing, because the code path under test never ran */
      get attempts(): number {
        return opened.size;
      },
      get leaked(): string[] {
        return [...opened].filter(([fd]) => !closed.has(fd)).map(([, file]) => file);
      },
      restore(): void {
        vi.restoreAllMocks();
      },
    };
  }

  it('closes the descriptor when the drain read throws, and recovers afterwards', async () => {
    watcher.watch('s1', { cwd });
    const file = path.join(projectDir(), 'native-1.jsonl');
    writeLines(file, [entry()]);
    await waitFor(() => watcher.snapshot('s1')!.bound);
    const before = watcher.snapshot('s1')!.lines;

    const trap = trapTranscriptReads();
    try {
      writeLines(file, [entry({ message: { usage: { output_tokens: 3 } } })]);
      await waitFor(() => trap.attempts > 0); // the drain really did run
      await sleep(100); // ...and keep failing for a few more polls
      expect(trap.leaked).toEqual([]); // every descriptor was handed back
      expect(watcher.snapshot('s1')!.lines).toBe(before); // fail-open: no crash, nothing bogus ingested
    } finally {
      trap.restore();
    }

    // The failure was transient, and the offset never advanced past bytes we
    // never read — so a later poll picks the append up.
    await waitFor(() => watcher.snapshot('s1')!.lines > before);
  });

  it('closes the descriptor when the head read throws while judging a candidate', async () => {
    const trap = trapTranscriptReads();
    try {
      watcher.watch('s1', { cwd });
      writeLines(path.join(projectDir(), 'native-1.jsonl'), [entry()]);
      await waitFor(() => trap.attempts > 0); // a candidate really was examined
      expect(trap.leaked).toEqual([]);
      expect(watcher.snapshot('s1')!.bound).toBe(false); // unreadable head = no evidence = no bind
    } finally {
      trap.restore();
    }

    // and the refusal is not sticky: once the reads work, it binds
    await waitFor(() => watcher.snapshot('s1')!.bound);
  });
});

describe('multi-byte characters split across drain chunks (#194)', () => {
  // A drain reads everything that landed since the last tick, so the chunk
  // boundary falls wherever the CLI happened to flush — routinely in the MIDDLE
  // of a multi-byte character, which any non-ASCII content produces: an emoji
  // in a prompt, an accented path, a diff of a UTF-8 source file. Decoding each
  // chunk on its own replaced the straddling character with U+FFFD on BOTH
  // sides of the boundary, and because the line still parsed as JSON nothing
  // was ever counted as malformed — the corruption went straight into the
  // Feed / the file list / the tool arguments, silently.

  /** Every UTF-8 CONTINUATION byte (10xxxxxx) in the line — each one is a byte
   *  provably INSIDE a multi-byte character, so splitting there is a boundary
   *  the old decode could not survive. Deterministic: the test never depends on
   *  where a poll tick happens to fall. */
  function insideChar(bytes: Buffer): number[] {
    return [...bytes.keys()].filter((i) => (bytes[i] & 0xc0) === 0x80);
  }

  /** A transcript line that carries a path through to `filesTouched`, which is
   *  where a corrupted decode becomes visible from outside. */
  const touching = (p: string) =>
    entry({ message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: p } }] } });

  /** Two-, three- AND four-byte sequences in one fixture (é / 日本語 / 😀 —
   *  the last of which is also a surrogate pair on the JS side). `n` is
   *  fixed-width on purpose: the byte offsets are computed once from a probe
   *  line, so every path in the run must serialise to the same length. */
  const unicodePath = (n: number) =>
    `C:/tmp/tw-project/café-日本語-😀-${String(n).padStart(2, '0')}.txt`;

  async function bound(file: string): Promise<void> {
    watcher.watch('s1', { cwd });
    writeLines(file, [entry()]);
    await waitFor(() => watcher.snapshot('s1')!.bound && watcher.snapshot('s1')!.lines >= 1);
  }

  it('carries a partial character across drains instead of decoding it to U+FFFD', async () => {
    const file = path.join(projectDir(), 'native-1.jsonl');
    await bound(file);

    // EVERY inside-a-character boundary the fixture offers, not just the first
    // one: that covers 2-, 3- and 4-byte sequences and every position within
    // them, including the case where the decoder must hold three bytes back.
    const probe = Buffer.from(touching(unicodePath(0)) + '\n', 'utf8');
    const splits = insideChar(probe);
    expect(splits.length).toBe(10); // é=1 + 日本語=6 + 😀=3 continuation bytes

    for (const [n, at] of splits.entries()) {
      const bytes = Buffer.from(touching(unicodePath(n)) + '\n', 'utf8');
      const before = watcher.snapshot('s1')!.lines;
      // A COMPLETE line in front of the half character, appended in ONE write.
      // The drain reads to end-of-file in a single chunk, so the moment that
      // line is ingested we know for certain the same chunk also contained the
      // incomplete character — no sleeping and hoping the tick landed in the
      // right place, and no risk of the test quietly degenerating into "both
      // halves arrived together", which would prove nothing.
      fs.appendFileSync(file, Buffer.concat([Buffer.from(entry() + '\n', 'utf8'), bytes.subarray(0, at)]));
      await waitFor(() => watcher.snapshot('s1')!.lines === before + 1);

      fs.appendFileSync(file, bytes.subarray(at));
      await waitFor(() => watcher.snapshot('s1')!.lines === before + 2);
    }

    const snap = watcher.snapshot('s1')!;
    for (const n of splits.keys()) expect(snap.filesTouched).toContain(unicodePath(n));
    expect(snap.filesTouched.join('')).not.toContain('\uFFFD');
    expect(snap.malformed).toBe(0);
  });

  it('drops the half character (and the partial line) when the file is truncated under us', async () => {
    const file = path.join(projectDir(), 'native-1.jsonl');
    await bound(file);
    const malformedBefore = watcher.snapshot('s1')!.malformed;

    // Same trick: a complete line proves the chunk that reached the decoder
    // also held the first half of the character on the end of it.
    const orphan = Buffer.from(touching('C:/tmp/tw-project/ORPHAN-日本語.txt') + '\n', 'utf8');
    const head = orphan.subarray(0, insideChar(orphan)[0]);
    const marker = 'C:/tmp/tw-project/before-truncate.txt';
    fs.appendFileSync(file, Buffer.concat([Buffer.from(touching(marker) + '\n', 'utf8'), head]));
    await waitFor(() => watcher.snapshot('s1')!.filesTouched.includes(marker));

    // The CLI rewrote the transcript. Give the poll a tick to SEE the smaller
    // size before the file grows again — a truncate-and-regrow entirely between
    // two ticks is invisible to any poller, so this is the one place the test
    // has to wait rather than watch for a condition.
    fs.truncateSync(file, 0);
    await sleep(200); // 8 poll intervals at pollMs: 25

    writeLines(file, [touching(unicodePath(0))]);
    await waitFor(() => watcher.snapshot('s1')!.filesTouched.includes(unicodePath(0)));

    const snap = watcher.snapshot('s1')!;
    // The stale partial LINE was dropped: had it survived, it would have been
    // glued to the front of the line above and the pair would have failed to
    // parse (counted malformed) instead of yielding this path.
    expect(snap.malformed).toBe(malformedBefore);
    expect(snap.filesTouched.join('')).not.toContain('\uFFFD');
    expect(snap.filesTouched.some((p) => p.includes('ORPHAN'))).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #200. Reported out of #187: the reap in `sessions:create` retires a crashed
// session's watch only when the card RESPAWNS. Crash a session and leave the
// card alone and the watch went on polling — and, while unbound, went on
// recursively scanning ~/.claude/projects (1,128 transcripts on Dan's machine)
// on the backoff ladder, for ever, on behalf of a process that will never write
// again.
//
// The call this item had to make was NOT "unwatch on exit". `unwatch` deletes
// the entry that holds the Feed backlog (`blocks`) and the binding state
// (`snapshot`) — exactly what the crashed card SHOWS. So the watch quiesces
// instead: it finishes what it could still learn, then freezes.
describe('post-exit quiesce: stop polling, keep everything readable (#200)', () => {
  /** Every disk touch discovery or the tail drain could make under a root.
   *  `readdirSync` is discovery walking; `statSync` is the drain checking a
   *  file it already holds. Together they are every I/O a tick can do. */
  function countDiskTouches(under: string): { calls: () => number; restore: () => void } {
    // `fs.statSync` is declared read-only, so the patch goes through a mutable
    // view of the module object rather than a cast per assignment.
    const mut = fs as unknown as Record<string, (p: fs.PathLike, o?: unknown) => unknown>;
    const realDir = mut.readdirSync;
    const realStat = mut.statSync;
    let n = 0;
    const counting =
      (real: (p: fs.PathLike, o?: unknown) => unknown) =>
      (p: fs.PathLike, o?: unknown): unknown => {
        if (String(p).startsWith(under)) n++;
        return real(p, o);
      };
    mut.readdirSync = counting(realDir);
    mut.statSync = counting(realStat);
    return {
      calls: () => n,
      restore: () => {
        mut.readdirSync = realDir;
        mut.statSync = realStat;
      },
    };
  }

  /** A watcher with the post-exit windows shrunk to test scale. The defaults
   *  are 3s / 90s; every claim here is about the SHAPE, not the numbers. */
  function crashable(over: Record<string, unknown> = {}): TranscriptWatcher {
    return makeWatcher({
      projectsRoot: root,
      log: createLogger(new LogSink({ dir: logDir }), 'transcripts'),
      pollMs: 25,
      postExitSettleMs: 60,
      ...over,
    });
  }

  const said = (text: string) => entry({ message: { content: [{ type: 'text', text }] } });

  it('a bound session that dies touches the disk zero times afterwards', async () => {
    const w = crashable();
    const file = path.join(projectDir(), 'native-1.jsonl');
    w.watch('s1', { cwd });
    writeLines(file, [said('the last thing it managed to say')]);
    await waitFor(() => w.snapshot('s1')!.lines >= 1);

    w.noteSessionExited('s1');
    await sleep(150); // past the 60ms settle window

    const spy = countDiskTouches(root);
    try {
      await sleep(400); // ~16 ticks at pollMs: 25
    } finally {
      // the spy replaces two globals; a leak would corrupt every later test
      spy.restore();
    }
    // ZERO, not "a few". A live session still sweeps on the ladder — see the
    // AR-P1-8 block above, which can only claim `< 5` — but nothing is writing
    // a dead session's transcript, so there is nothing to be even occasionally
    // right about.
    expect(spy.calls()).toBe(0);
  });

  it('an UNBOUND frozen session walks nothing, while a neighbour keeps the poll alive', async () => {
    // The test above passes even without the poll loop's `quiesced` guard: with
    // nothing else running the interval itself has stopped. This is the shape
    // that discriminates, and it is the worse defect of the two.
    //
    // A frozen session gave its root registration back, and `shouldSweep`
    // answers TRUE for a root it holds no state for ("never block discovery on
    // bookkeeping"). So an unguarded tick over a frozen UNBOUND session walks
    // its whole tree with no backoff ladder underneath it at all — every 100ms,
    // for ever. That is #200's own defect, amplified by the release.
    //
    // Two ROOTS, so the spy can say "nothing, at all, for the dead one" rather
    // than compare counts: the living session's I/O happens somewhere else.
    const rootB = tempDir('sb-tw-rootb-quiesce-');
    const cwd2 = 'C:/tmp/tw-project-two';
    const w = crashable({ postExitHuntMs: 50 });
    w.watch('s1', { cwd }); // the watcher's own root, and never binds
    w.watch('s2', { cwd: cwd2, projectsRoot: rootB });

    const aliveDir = path.join(rootB, slugForCwd(cwd2));
    fs.mkdirSync(aliveDir, { recursive: true });
    const alive = path.join(aliveDir, 'native-2.jsonl');
    const live = (text: string) =>
      JSON.stringify({
        type: 'assistant',
        sessionId: 'native-2',
        cwd: cwd2,
        timestamp: new Date().toISOString(),
        message: { content: [{ type: 'text', text }] },
      });
    writeLines(alive, [live('still working')]);
    await waitFor(() => w.snapshot('s2')!.bound);

    w.noteSessionExited('s1');
    await sleep(150); // past the 50ms ceiling: frozen while still unbound

    const spy = countDiskTouches(root);
    let before = 0;
    try {
      await sleep(300); // ~12 ticks, every one of which used to scan
      before = w.snapshot('s2')!.lines;
    } finally {
      spy.restore();
    }
    expect(spy.calls()).toBe(0);
    // ...and the guard does not over-reach: the living session still ingests.
    writeLines(alive, [live('and still going')]);
    await waitFor(() => w.snapshot('s2')!.lines > before);
  });

  it('keeps the Feed backlog and the binding a crashed card reads', async () => {
    const w = crashable();
    const file = path.join(projectDir(), 'native-1.jsonl');
    w.watch('s1', { cwd });
    writeLines(file, [said('hello from before the crash')]);
    await waitFor(() => w.snapshot('s1')!.lines >= 1);

    w.noteSessionExited('s1');
    await sleep(150);

    // This is the regression an `unwatch`-on-exit fix would have shipped: the
    // pane mounts AFTER the crash and pulls both of these.
    expect(w.blocks('s1').some((b) => b.text === 'hello from before the crash')).toBe(true);
    const snap = w.snapshot('s1');
    expect(snap!.bound).toBe(true);
    expect(snap!.binding).toBe('bound');
    expect(snap!.lines).toBe(1);
  });

  it('reads the bytes that were still unread when the process died', async () => {
    // Everything the CLI ever wrote is on disk by the time its exit reaches us,
    // and up to a poll interval of it may be unread — the last words of the
    // crashed turn. Nothing is awaited between the write and the notice, so no
    // tick can have run in between: this is exactly that window, and with the
    // settle window at 0 the notice is the only chance those bytes ever get.
    const w = crashable({ postExitSettleMs: 0 });
    const file = path.join(projectDir(), 'native-1.jsonl');
    w.watch('s1', { cwd });
    writeLines(file, [said('first')]);
    await waitFor(() => w.snapshot('s1')!.lines >= 1);

    writeLines(file, [said('dying words')]);
    w.noteSessionExited('s1');

    expect(w.snapshot('s1')!.lines).toBe(2);
    expect(w.blocks('s1').some((b) => b.text === 'dying words')).toBe(true);
  });

  it('keeps draining for the settle window, then stops', async () => {
    // What `POST_EXIT_SETTLE_MS` is FOR: the reasoning that one drain is enough
    // has seams (SMB `stat` lag, a transport reporting the exit a beat early),
    // so bytes that show up shortly after the death still land. Without this,
    // deleting the settle branch entirely — freezing the moment the notice
    // returns — passes every other test in this block.
    const w = crashable({ postExitSettleMs: 400 });
    const file = path.join(projectDir(), 'native-1.jsonl');
    w.watch('s1', { cwd });
    writeLines(file, [said('first')]);
    await waitFor(() => w.snapshot('s1')!.lines >= 1);

    w.noteSessionExited('s1');
    await sleep(100); // still inside the 400ms window
    writeLines(file, [said('late arrival')]);
    await waitFor(() => w.blocks('s1').some((b) => b.text === 'late arrival'));

    await sleep(500); // ...and now it is over
    writeLines(file, [said('far too late')]);
    await sleep(200);
    expect(w.snapshot('s1')!.lines).toBe(2);
  });

  it('a subagent transcript written just before the crash still gets picked up', async () => {
    // The death is an evidence site, and this is what it buys. A BOUND session
    // only looks for subagent files on a SWEEP tick, and the ladder decays to
    // 2s while nothing is happening — so with the settle window shorter than
    // the ladder step, the last subagent's transcript would miss its only
    // chance and be lost from the Feed for good. Marking the root dirty at the
    // death gives it the very next tick.
    //
    // The watch is off (`watchFactory: () => null`) so no filesystem event can
    // hand out the sweep the mark is supposed to provide.
    const w = crashable({
      postExitSettleMs: 300,
      discovery: { watchFactory: () => null, watchFailedMs: 2_000 },
    });
    const file = path.join(projectDir(), 'native-1.jsonl');
    w.watch('s1', { cwd });
    writeLines(file, [said('main transcript')]);
    await waitFor(() => w.snapshot('s1')!.bound);
    await sleep(150); // let the ladder settle onto its slow rung

    const subDir = path.join(projectDir(), 'native-1', 'subagents');
    fs.mkdirSync(subDir, { recursive: true });
    writeLines(path.join(subDir, 'agent-abc123.jsonl'), [
      entry({ isSidechain: true, agentId: 'abc123', message: { usage: { output_tokens: 3 } } }),
    ]);
    w.noteSessionExited('s1');

    await waitFor(() => w.snapshot('s1')!.usage.output === 3, 1_000);
  });

  it('an UNBOUND session keeps hunting after the crash — the transcript is still on disk', async () => {
    // The case that rules out quiescing at the moment of death. A crash during
    // the first turn routinely leaves a transcript we have not claimed yet (the
    // widen grace alone is 10s), and stopping here would leave that card's Feed
    // empty for ever where today it fills seconds later.
    const w = crashable();
    w.watch('s1', { cwd });
    w.noteSessionExited('s1');
    expect(w.snapshot('s1')!.bound).toBe(false);

    writeLines(path.join(projectDir(), 'native-1.jsonl'), [said('written just before it died')]);
    await waitFor(() => w.snapshot('s1')!.bound);
    await waitFor(() => w.blocks('s1').some((b) => b.text === 'written just before it died'));
  });

  it('...and freezes once the binding question is ANSWERED', async () => {
    // `bindGiveUpMs` is the watcher's own verdict that there is nothing left to
    // find. Reaching it is what ends the hunt — not a timer of this feature's
    // own, which could cut a bind short or outlive the answer.
    const w = crashable({ bindGiveUpMs: 60 });
    w.watch('s1', { cwd });
    w.noteConversationStarted('s1'); // a turn ran => the give-up clock is armed
    w.noteSessionExited('s1');
    await waitFor(() => w.snapshot('s1')!.binding === 'unbound');
    await sleep(80);

    // Frozen: a transcript appearing now is not looked for, and the pane keeps
    // the honest verdict rather than counting `searchingMs` up for ever.
    writeLines(path.join(projectDir(), 'native-1.jsonl'), [said('too late')]);
    await sleep(200);
    expect(w.snapshot('s1')!.bound).toBe(false);
    expect(w.snapshot('s1')!.binding).toBe('unbound');
  });

  it('the ceiling stops a hunt that would never reach a verdict, and stops claiming to search', async () => {
    // `awaiting-prompt` deliberately never times out (a session you opened and
    // walked away from is not broken), so without a ceiling a card that crashed
    // before its first prompt would sweep for the rest of the run.
    const w = crashable({ postExitHuntMs: 50 });
    w.watch('s1', { cwd });
    w.noteConversationStarted('s1');
    await waitFor(() => w.snapshot('s1')!.binding === 'searching');
    w.noteSessionExited('s1');
    await sleep(150);

    const spy = countDiskTouches(root);
    try {
      await sleep(300);
    } finally {
      spy.restore();
    }
    expect(spy.calls()).toBe(0);
    // We stopped looking, so "Looking for this session's transcript…" would be
    // a lie the pane told for the rest of the run.
    expect(w.snapshot('s1')!.binding).toBe('unbound');
    // ...and so would a search timer still counting. `searchingMs` is computed
    // live from `evidenceSince`, so leaving it set means a bug report written
    // an hour later says this session has been searching for an hour.
    expect(w.snapshot('s1')!.bindingDiag.searchingMs).toBeNull();
  });

  it('a late native id cannot blank the frozen Feed', async () => {
    // The sharpest reason quiescing switches the evidence sites off rather than
    // merely stopping the poll: `setNativeSessionId` with an id we did not bind
    // reaches `resetBinding`, which drops the blocks and zeroes the snapshot —
    // with nothing left polling to rebuild either.
    const w = crashable();
    const file = path.join(projectDir(), 'native-1.jsonl');
    w.watch('s1', { cwd });
    writeLines(file, [said('everything it said')]);
    await waitFor(() => w.snapshot('s1')!.lines >= 1);
    w.noteSessionExited('s1');
    await sleep(150);

    const resets: string[] = [];
    const off = w.onReset((id) => resets.push(id));
    w.setNativeSessionId('s1', 'some-other-native-id');
    w.noteConversationStarted('s1');
    off();

    expect(resets).toEqual([]);
    expect(w.blocks('s1').some((b) => b.text === 'everything it said')).toBe(true);
    expect(w.snapshot('s1')!.nativeSessionId).toBe('native-1');
  });

  it('a late turn notice cannot restart a clock nothing is left to resolve', async () => {
    // The other half of "frozen means frozen". A session that crashed before
    // anyone prompted it freezes at `awaiting-prompt`, which is the truth and
    // shows no alarm. Latching evidence afterwards would walk it to `searching`
    // and arm the give-up clock — and with no polling left, nothing would ever
    // deliver the verdict, so the pane would say "Looking for this session's
    // transcript…" with a counter climbing, for the rest of the run.
    const w = crashable({ postExitHuntMs: 30 });
    w.watch('s1', { cwd });
    w.noteSessionExited('s1');
    await sleep(150); // past the ceiling: frozen, and never prompted
    expect(w.snapshot('s1')!.binding).toBe('awaiting-prompt');

    w.noteConversationStarted('s1');

    expect(w.snapshot('s1')!.binding).toBe('awaiting-prompt');
    expect(w.snapshot('s1')!.bindingDiag.searchingMs).toBeNull();
    // and it really is frozen — the notice did not quietly restart discovery
    writeLines(path.join(projectDir(), 'native-1.jsonl'), [said('too late')]);
    await sleep(200);
    expect(w.snapshot('s1')!.bound).toBe(false);
  });

  it('the reap can still unwatch a frozen session without closing a live one’s watch', async () => {
    // The double-free this had to avoid. Quiescing gives the root's recursive
    // `fs.watch` reference back; `unwatch` gives it back too, and the reap in
    // `sessions:create` runs `unwatch` on exactly the session that just froze.
    // Release it twice and the refcount hits zero underneath the sibling that
    // is still binding through that watch.
    const closes: string[] = [];
    let opens = 0;
    const w = crashable({
      discovery: {
        watchFactory: (r: string) => {
          opens++;
          return { close: () => closes.push(r) };
        },
        backoffMs: [25],
      },
    });
    const cwd2 = 'C:/tmp/tw-project-two';
    w.watch('s1', { cwd });
    w.watch('s2', { cwd: cwd2 }); // same ROOT, different folder: one watch, two refs
    expect(opens).toBe(1);

    // BOUND before it dies, so the settle window really does freeze it — an
    // unbound one would still be hunting, and this test would then prove
    // nothing about the double release it exists for.
    writeLines(path.join(projectDir(), 'native-1.jsonl'), [said('bound before the crash')]);
    await waitFor(() => w.snapshot('s1')!.lines >= 1);
    w.noteSessionExited('s1');
    await waitFor(() => w.blocks('s1').length > 0);
    await sleep(150); // past the 60ms settle: frozen, reference given back
    w.unwatch('s1'); // ...and now the card is respawned, so the reap retires it

    expect(closes).toEqual([]); // s2 is alive and still needs that handle

    const d2 = path.join(root, slugForCwd(cwd2));
    fs.mkdirSync(d2, { recursive: true });
    writeLines(path.join(d2, 'native-2.jsonl'), [
      JSON.stringify({ type: 'assistant', sessionId: 'native-2', cwd: cwd2, timestamp: new Date().toISOString() }),
    ]);
    await waitFor(() => w.snapshot('s2')!.bound); // the survivor still discovers

    w.unwatch('s2');
    expect(closes).toEqual([root]); // exactly once, when the last one really left
  });

  it('stops the poll timer once every session left is frozen, and restarts it for the next card', async () => {
    // The interval is stopped when nothing left would DO anything on a tick,
    // which is not the same test as "the map is empty" — a crashed session's
    // entry stays, for the overlay to read. Watching `clearInterval` is the
    // only honest observation of that: a tick over none-but-frozen sessions
    // has no other effect to catch it by. And the second half matters more
    // than the first: stopping it and never starting again would break the
    // next card the user opens.
    const w = crashable();
    w.watch('s1', { cwd });
    writeLines(path.join(projectDir(), 'native-1.jsonl'), [said('before the crash')]);
    await waitFor(() => w.snapshot('s1')!.lines >= 1);

    const cleared = vi.spyOn(globalThis, 'clearInterval');
    try {
      w.noteSessionExited('s1');
      await waitFor(() => cleared.mock.calls.length > 0);
    } finally {
      cleared.mockRestore();
    }

    const cwd2 = 'C:/tmp/tw-project-two';
    w.watch('s2', { cwd: cwd2 });
    const d2 = path.join(root, slugForCwd(cwd2));
    fs.mkdirSync(d2, { recursive: true });
    writeLines(path.join(d2, 'native-2.jsonl'), [
      JSON.stringify({ type: 'assistant', sessionId: 'native-2', cwd: cwd2, timestamp: new Date().toISOString() }),
    ]);
    await waitFor(() => w.snapshot('s2')!.bound);
  });

  it('a refused re-watch is the other way the last live session can leave', async () => {
    // `watch()` with an unusable root deletes the entry and returns false
    // WITHOUT going through `unwatch` — the one path that can empty the live
    // set behind the timer's back, leaving the interval ticking over an
    // all-frozen map for the rest of the run.
    const w = crashable();
    w.watch('s1', { cwd });
    w.watch('s2', { cwd: 'C:/tmp/tw-project-two' });
    writeLines(path.join(projectDir(), 'native-1.jsonl'), [said('before the crash')]);
    await waitFor(() => w.snapshot('s1')!.lines >= 1);
    w.noteSessionExited('s1');
    await sleep(150); // s1 frozen; s2 is the only live session left

    const cleared = vi.spyOn(globalThis, 'clearInterval');
    try {
      expect(w.watch('s2', { cwd: 'C:/tmp/tw-project-two', projectsRoot: 'not/absolute' })).toBe(
        false
      );
      expect(cleared).toHaveBeenCalled();
    } finally {
      cleared.mockRestore();
    }
  });

  it('an exit for an id it never watched changes nothing', () => {
    const w = crashable();
    w.watch('s1', { cwd });
    expect(() => w.noteSessionExited('never-heard-of-it')).not.toThrow();
    // Every death arrives here, including the ones the app asked for — a
    // Restart tears down first and the exit lands afterwards, on an id that is
    // already gone.
    w.noteSessionExited('s1');
    expect(() => w.unwatch('s1')).not.toThrow();
    expect(() => w.noteSessionExited('s1')).not.toThrow();
    expect(w.snapshot('s1')).toBeUndefined();
  });

  it('a SECOND exit notice cannot push the windows out', async () => {
    // The latch is load-bearing in the gap between the death and the freeze: a
    // duplicate notice would re-anchor `exitedAt` and buy a corpse another full
    // window. Driven by the clock rather than by sleeping, so the two cases are
    // ten seconds apart instead of milliseconds.
    const w = crashable({ postExitHuntMs: 10_000 });
    w.watch('s1', { cwd }); // unbound: the hunt window is the one in play
    w.noteSessionExited('s1');

    const real = Date.now;
    const clock = vi.spyOn(Date, 'now');
    try {
      // Nine seconds on, a second notice arrives. Re-anchoring here would move
      // the ceiling from 10s to 19s.
      clock.mockImplementation(() => real.call(Date) + 9_000);
      w.noteSessionExited('s1');
      // Eleven seconds after the FIRST one: the ceiling has passed, so the
      // watch is frozen and a transcript appearing now is never looked for.
      clock.mockImplementation(() => real.call(Date) + 11_000);
      await sleep(100);
      writeLines(path.join(projectDir(), 'native-1.jsonl'), [said('too late')]);
      await sleep(250);
      expect(w.snapshot('s1')!.bound).toBe(false);
    } finally {
      clock.mockRestore();
    }
  });

  it('a clock that steps BACKWARDS does not park the watch on the disk', async () => {
    // Same hazard `DiscoverySchedule.shouldSweep` guards against: an NTP
    // correction or a VM resume makes `now - exitedAt` negative, and every
    // window would then wait out real time — an hour of scanning for an
    // hour-sized jump, on behalf of a process that died before it happened.
    const w = crashable({ postExitSettleMs: 100 });
    const file = path.join(projectDir(), 'native-1.jsonl');
    w.watch('s1', { cwd });
    writeLines(file, [said('before the crash')]);
    await waitFor(() => w.snapshot('s1')!.lines >= 1);
    w.noteSessionExited('s1');

    const real = Date.now;
    const clock = vi.spyOn(Date, 'now');
    try {
      clock.mockImplementation(() => real.call(Date) - 3_600_000);
      await sleep(300); // three settle windows of shifted-but-advancing time
      writeLines(file, [said('after the freeze')]);
      await sleep(200);
    } finally {
      clock.mockRestore();
    }
    expect(w.snapshot('s1')!.lines).toBe(1);
  });

  it('re-watching a frozen id takes its own reference rather than a second release', async () => {
    // No first-party caller does this — live ids are minted per spawn, so a
    // frozen id is never watched again — but `watch()` is a public method and
    // the refcount underneath it is shared with every other session on the
    // root. Getting it wrong closes a live card's watch.
    const closes: string[] = [];
    const w = crashable({
      discovery: {
        watchFactory: (r: string) => ({ close: () => closes.push(r) }),
        backoffMs: [25],
      },
    });
    const cwd2 = 'C:/tmp/tw-project-two';
    w.watch('s1', { cwd });
    w.watch('s2', { cwd: cwd2 });
    writeLines(path.join(projectDir(), 'native-1.jsonl'), [said('bound before the crash')]);
    await waitFor(() => w.snapshot('s1')!.lines >= 1);
    w.noteSessionExited('s1');
    await sleep(150); // frozen: its reference is already back

    w.watch('s1', { cwd }); // the same id, watched again, no unwatch in between

    w.unwatch('s1');
    expect(closes).toEqual([]); // s2 still holds the root
    w.unwatch('s2');
    expect(closes).toEqual([root]);
  });
});

// ── P2-E7-06: the CLI's own conversation title ─────────────────────────────
//
// Driven by REAL captured `ai-title` lines, replayed at the line numbers they
// really occupied — see `fixtures/ai-title.ts` for why a hand-written fixture
// would not have caught the three things these tests turn on.
describe('the conversation title off the transcript (P2-E7-06)', () => {
  /** Claude's reader, imported rather than re-spelled: the key lives in the
   *  adapter, and a second copy here would let the two drift apart silently. */
  const readTitle = readAiTitle;

  /** Write a captured transcript into the project dir, `filler` on every other
   *  line, and return the file it went to. */
  function writeCapture(c: CapturedTitles, file = 'native-1.jsonl'): string {
    const full = path.join(projectDir(), file);
    fs.writeFileSync(full, rebuild(c, () => entry({ message: { content: [] } })));
    return full;
  }

  it('fills in the title the CLI settled on, revisions included', async () => {
    // REVISED's first answer is on line 8 and its SECOND, different answer is
    // on line 9 — so a reader that latched the first title it saw would end
    // this test holding "…preview windows" for ever.
    writeCapture(REVISED);
    watcher.watch('s1', { cwd, readTitle });
    const settled = titlesOf(REVISED)[1];
    await waitFor(() => watcher.snapshot('s1')?.title === settled);
    expect(watcher.snapshot('s1')!.title).toBe('Add markdown and file preview feature');
  });

  it('a repeat costs nothing: 13 real title lines, ONE snapshot change', async () => {
    // The de-dupe, asserted against the repeat-heavy capture rather than
    // assumed. Undeduped this is a persist and a renderer push per turn, on
    // every open session at once.
    let titleChanges = 0;
    let last: string | undefined;
    watcher.onUpdate((s) => {
      if (s.sessionId === 's1' && s.title !== last) {
        last = s.title;
        titleChanges++;
      }
    });
    writeCapture(REPEAT_HEAVY);
    watcher.watch('s1', { cwd, readTitle });
    await waitFor(() => watcher.snapshot('s1')!.lines >= REPEAT_HEAVY.totalLines);
    await sleep(120); // any further change would have landed by now
    expect(watcher.snapshot('s1')!.title).toBe('Analyze and improve Playwright test coverage');
    expect(titleChanges).toBe(1);
  });

  it('a title that arrives on line 510 still arrives', async () => {
    // "It shows up early" is not a property of this key. Written in two halves
    // so the watcher genuinely tails past 500 title-less lines rather than
    // ingesting the whole file in its first drain.
    const file = path.join(projectDir(), 'native-1.jsonl');
    const all = rebuild(LATE, () => entry({ message: { content: [] } })).split('\n');
    fs.writeFileSync(file, all.slice(0, 400).join('\n') + '\n');
    watcher.watch('s1', { cwd, readTitle });
    await waitFor(() => watcher.snapshot('s1')!.lines >= 400);
    expect(watcher.snapshot('s1')!.title).toBeUndefined(); // nothing to say yet

    writeLines(file, all.slice(400).filter(Boolean));
    await waitFor(() => watcher.snapshot('s1')?.title !== undefined);
    expect(watcher.snapshot('s1')!.title).toBe('Review next steps after PR merge');
  });

  it('an adapter that declares no titles gets no title watch at all', async () => {
    // Not "we looked and found nothing": with no reader there is no shared
    // spelling of a title to look FOR, which is the whole point of putting it
    // behind a §5.3 capability.
    writeCapture(REVISED);
    watcher.watch('s1', { cwd }); // no readTitle
    await waitFor(() => watcher.snapshot('s1')!.lines >= REVISED.totalLines);
    expect(watcher.snapshot('s1')!.title).toBeUndefined();
  });

  it('a transcript with no ai-title line looks exactly as it did before', async () => {
    // The fail-open case, and it gets a test because the key is undocumented:
    // any CLI release may rename or drop it, and the day it does this is what
    // every session looks like.
    const file = path.join(projectDir(), 'native-1.jsonl');
    writeLines(file, [
      entry({ message: { content: [{ type: 'text', text: 'hello' }] } }),
      // the key RENAMED, which is the realistic version of it disappearing
      JSON.stringify({ type: 'ai-title', sessionId: 'native-1', cwd, conversationTitle: 'nope' }),
    ]);
    watcher.watch('s1', { cwd, readTitle });
    await waitFor(() => watcher.snapshot('s1')!.lines >= 2);
    expect(watcher.snapshot('s1')!.title).toBeUndefined();
    expect(watcher.snapshot('s1')!.malformed).toBe(0); // it is a LINE, not a fault
  });

  it("a subagent's title never becomes the card's", async () => {
    // A subagent transcript is a different conversation with a title of its
    // own; letting one through relabels the card with whatever a Task call was
    // doing. The watcher tails both files, so only the bound one may speak.
    const file = path.join(projectDir(), 'native-1.jsonl');
    writeLines(file, [
      entry({ message: { content: [] } }),
      REVISED.lines[1][1], // the settled title, on the BOUND file
    ]);
    watcher.watch('s1', { cwd, readTitle });
    await waitFor(() => watcher.snapshot('s1')?.title !== undefined);

    const subDir = path.join(projectDir(), 'native-1', 'subagents');
    fs.mkdirSync(subDir, { recursive: true });
    writeLines(path.join(subDir, 'agent-a.jsonl'), [
      JSON.stringify({ type: 'ai-title', sessionId: 'native-1', cwd, aiTitle: 'Subagent doing its own thing' }),
    ]);
    await sleep(200);
    expect(watcher.snapshot('s1')!.title).toBe('Add markdown and file preview feature');
  });

  it('a /clear drops the old title with the old conversation', async () => {
    // The title describes the conversation, and a /clear starts a new one. A
    // stale label surviving the reset would describe work the session is no
    // longer doing.
    writeCapture(REPEAT_HEAVY);
    watcher.watch('s1', { cwd, nativeSessionId: 'native-1', readTitle });
    await waitFor(() => watcher.snapshot('s1')?.title !== undefined);
    watcher.setNativeSessionId('s1', 'native-2', 'clear');
    expect(watcher.snapshot('s1')!.title).toBeUndefined();
  });
});
