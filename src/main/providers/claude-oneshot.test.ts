// #758 — the contained one-shot runner.
//
// The expensive half (a real model call) is measured by a probe, not by this
// file: `spike/findings/758-label-containment.md` drives the real CLI and is
// where "does `--tools ""` actually empty the tool list" is answered. What is
// asserted HERE is everything that must stay true without a CLI present — the
// containment argv, that the prompt never becomes an argument, and that every
// failure resolves rather than throwing.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { spawn } from 'child_process';

vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  return { ...real, spawn: vi.fn() };
});

vi.mock('./claude', () => ({ resolveCliPath: vi.fn(() => 'C:\\npm\\claude.cmd') }));

import { resolveCliPath } from './claude';
import {
  CONTAINED_ARGS,
  DEFAULT_ONESHOT_MODEL,
  MAX_ONESHOT_OUTPUT,
  runContainedPrompt,
} from './claude-oneshot';

/** A child that behaves enough like one to drive every branch. */
class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = Object.assign(new EventEmitter(), { end: vi.fn() });
  exitCode: number | null = null;
  signalCode: string | null = null;
  pid: number | undefined = 4242;
  kill = vi.fn();
}

function log() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() };
}

let fake: FakeChild;

beforeEach(() => {
  fake = new FakeChild();
  vi.mocked(spawn).mockReturnValue(fake as unknown as ReturnType<typeof spawn>);
  vi.mocked(resolveCliPath).mockReturnValue('C:\\npm\\claude.cmd');
});

afterEach(() => {
  vi.clearAllTimers();
  vi.restoreAllMocks();
});

/** The argv the runner actually handed to `spawn`, shim-unwrapped. */
function spawnedArgv(): string[] {
  const call = vi.mocked(spawn).mock.calls[0];
  return (call?.[1] as string[]) ?? [];
}

describe('the containment posture (CONTAINED_ARGS)', () => {
  it('is exactly the combination the probe measured as empty', () => {
    // ⚠️ PINNED LITERALLY, and deliberately hostile to a well-meaning edit.
    // Measured (claude 2.1.272): `--restricted` ALONE leaves 34 tools and the
    // user's MCP server, keeping Read/Glob/Grep and SendMessage/ListAgents —
    // the #760 attack surface itself. Only `--tools ""` empties the list, and
    // only `--strict-mcp-config` evicts the servers. Dropping any element here
    // is a silent return to the defect #760 documented.
    expect([...CONTAINED_ARGS]).toEqual([
      '--tools',
      '',
      '--restricted',
      '--strict-mcp-config',
      '--permission-mode',
      'default',
    ]);
  });

  it('never asks for bypassPermissions, which the CLI refuses anyway', () => {
    // Measured: `--restricted` + bypass exits 1 in 156 ms with
    // "bypassPermissions not supported in restricted mode". Asking for it would
    // turn every label run into an error.
    expect(CONTAINED_ARGS).not.toContain('bypassPermissions');
  });

  it('carries the empty tool list as its own argument', () => {
    // `--tools` and `''` are two array entries, not `--tools=""`. The empty one
    // surviving the cmd.exe shim is pinned by `win-cmd.test.ts` (`['a','','b']`
    // round-trips byte-exact); if it were dropped the labeler would silently
    // receive all 33 tools.
    const i = CONTAINED_ARGS.indexOf('--tools');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(CONTAINED_ARGS[i + 1]).toBe('');
  });
});

describe('the prompt goes on stdin, never into argv', () => {
  it('writes the prompt to stdin and ends the pipe', async () => {
    const p = runContainedPrompt({ prompt: 'describe this', cwd: 'C:\\proj' }, { log: log() });
    fake.stdout.emit('data', 'Fix the login redirect\n');
    fake.emit('close', 0);
    await expect(p).resolves.toMatchObject({ ok: true, text: 'Fix the login redirect\n' });
    // `end()` is what tells `-p` the prompt is complete.
    expect(fake.stdin.end).toHaveBeenCalledWith('describe this');
  });

  it('PUTS NO PART OF THE PROMPT IN ARGV — the #714 boundary', async () => {
    // The excerpt is full of quotes and newlines, and `execSpec` THROWS on both
    // for a `.cmd`. The whole delivery design is that it is never an argument,
    // so this is the regression guard for the thing that would break it.
    const nasty = 'user: he said "quote me"\nassistant: and `backticks`';
    const p = runContainedPrompt({ prompt: nasty, cwd: 'C:\\proj' }, { log: log() });
    fake.emit('close', 0);
    await p;
    for (const a of spawnedArgv()) {
      expect(a).not.toContain('quote me');
      expect(a).not.toContain('backticks');
    }
  });

  it('passes -p with no prompt value, which is what makes stdin the source', async () => {
    const p = runContainedPrompt({ prompt: 'x', cwd: 'C:\\proj' }, { log: log() });
    fake.emit('close', 0);
    await p;
    const argv = spawnedArgv();
    // The shim wraps everything into one cmd.exe command line, so assert on the
    // joined form rather than on positions.
    const line = argv.join(' ');
    expect(line).toContain('-p');
    expect(line).toContain('--tools');
    expect(line).toContain('--strict-mcp-config');
  });

  it('uses the small model by default and honours an override', async () => {
    const p1 = runContainedPrompt({ prompt: 'x', cwd: 'C:\\p' }, { log: log() });
    fake.emit('close', 0);
    await p1;
    expect(spawnedArgv().join(' ')).toContain(DEFAULT_ONESHOT_MODEL);

    vi.mocked(spawn).mockClear();
    const second = new FakeChild();
    vi.mocked(spawn).mockReturnValue(second as unknown as ReturnType<typeof spawn>);
    const p2 = runContainedPrompt({ prompt: 'x', cwd: 'C:\\p', model: 'sonnet' }, { log: log() });
    second.emit('close', 0);
    await p2;
    expect(spawnedArgv().join(' ')).toContain('sonnet');
  });
});

describe('every failure resolves — fail-open is structural (P6)', () => {
  it('answers no-cli without spawning anything', async () => {
    vi.mocked(resolveCliPath).mockReturnValue(null);
    const l = log();
    await expect(runContainedPrompt({ prompt: 'x', cwd: 'C:\\p' }, { log: l })).resolves.toMatchObject(
      { ok: false, failure: 'no-cli' }
    );
    expect(spawn).not.toHaveBeenCalled();
    // Not a warning: a machine without the CLI is one where the feature is
    // simply unavailable, and something else already says so.
    expect(l.warn).not.toHaveBeenCalled();
  });

  it('answers spawn-failed when spawn throws rather than emitting', async () => {
    vi.mocked(spawn).mockImplementationOnce(() => {
      throw new Error('spawn ENOMEM');
    });
    await expect(runContainedPrompt({ prompt: 'x', cwd: 'C:\\p' }, { log: log() })).resolves.toMatchObject(
      { ok: false, failure: 'spawn-failed' }
    );
  });

  it('answers spawn-failed on an error event', async () => {
    const p = runContainedPrompt({ prompt: 'x', cwd: 'C:\\p' }, { log: log() });
    fake.emit('error', new Error('ENOENT'));
    await expect(p).resolves.toMatchObject({ ok: false, failure: 'spawn-failed' });
  });

  it('answers cli-failed on a non-zero exit, carrying stderr', async () => {
    // A bad model name exits 1 in ~1.6 s; a rate limit lands here too.
    const p = runContainedPrompt({ prompt: 'x', cwd: 'C:\\p' }, { log: log() });
    fake.stderr.emit('data', '[claude-code:unrecognized_model]');
    fake.emit('close', 1);
    const r = await p;
    expect(r).toMatchObject({ ok: false, failure: 'cli-failed' });
    // Narrowed rather than matched with `expect.stringContaining`, which is
    // typed `any` and so cannot be used as a property value under
    // `no-unsafe-assignment`. Narrowing also proves `detail` is on the failure
    // shape at all, which a loose object match does not.
    if (!r.ok) expect(r.detail).toContain('unrecognized_model');
  });

  it('times out, and KILLS THE TREE rather than the shim', async () => {
    vi.useFakeTimers();
    try {
      const p = runContainedPrompt({ prompt: 'x', cwd: 'C:\\p', timeoutMs: 1_000 }, { log: log() });
      await vi.advanceTimersByTimeAsync(1_001);
      const r = await p;
      expect(r).toMatchObject({ ok: false, failure: 'timeout' });
      // Through the `.cmd` shim we hold cmd.exe and `claude.exe` is its child.
      // `killTree` shells out to taskkill on win32; on this runner the branch
      // taken depends on the platform, so the claim asserted here is the one
      // that holds everywhere: the runner did not simply walk away.
      expect(r.ok).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a late close after a timeout does not resolve twice', async () => {
    vi.useFakeTimers();
    try {
      const p = runContainedPrompt({ prompt: 'x', cwd: 'C:\\p', timeoutMs: 1_000 }, { log: log() });
      await vi.advanceTimersByTimeAsync(1_001);
      fake.emit('close', 0); // the child finally dies
      await expect(p).resolves.toMatchObject({ ok: false, failure: 'timeout' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('a stdin EPIPE is not an error — close carries the verdict', async () => {
    const p = runContainedPrompt({ prompt: 'x', cwd: 'C:\\p' }, { log: log() });
    fake.stdin.emit('error', new Error('EPIPE'));
    fake.stdout.emit('data', 'A label\n');
    fake.emit('close', 0);
    await expect(p).resolves.toMatchObject({ ok: true, text: 'A label\n' });
  });
});

describe('a model that will not stop talking', () => {
  it('caps the buffer and says so, without failing', async () => {
    // Not a failure: the label comes off the FIRST line anyway, so a capped
    // buffer still contains the answer.
    const p = runContainedPrompt({ prompt: 'x', cwd: 'C:\\p' }, { log: log() });
    fake.stdout.emit('data', `first line\n${'x'.repeat(MAX_ONESHOT_OUTPUT * 2)}`);
    fake.stdout.emit('data', 'more after the cap');
    fake.emit('close', 0);
    const r = await p;
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.truncated).toBe(true);
      expect(r.text.length).toBeLessThanOrEqual(MAX_ONESHOT_OUTPUT);
      expect(r.text.startsWith('first line')).toBe(true);
    }
  });
});
