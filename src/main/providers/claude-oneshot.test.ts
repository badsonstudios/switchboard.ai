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

/** The argv the runner actually handed to `spawn`. */
function spawnedArgv(): string[] {
  const call = vi.mocked(spawn).mock.calls[0];
  return (call?.[1] as string[]) ?? [];
}

/**
 * The arguments AS THE CLI WILL RECEIVE THEM, on either platform.
 *
 * ⚠️ THIS IS A TOKENISER AND NOT A STRING MATCH, after two failed attempts that
 * are worth recording because both looked right:
 *
 *   1. `expect(joined).toContain('-p')` is vacuous — `--permission-mode`
 *      contains `-p`, so removing `-p` entirely left the test green.
 *   2. Matching `-p` with quote/space boundaries fails on Windows: `quoteArg`
 *      wraps every argument in quotes and `escapeForCmd` turns each `"` into
 *      `^"`, so the real line is `"^"…claude.cmd^" ^"--tools^" ^"^" …` and the
 *      character after `-p` is a CARET. Guessing the escaping instead of
 *      reading it cost two rounds.
 *
 * And a quoted-token pattern fails the other way: `execSpec` only wraps for a
 * `.cmd` on win32, and passes argv straight through everywhere else — so on
 * CI's ubuntu leg there are no quotes at all. Tokenising is the only form that
 * asserts the same claim on both.
 */
function containedArgs(): string[] {
  const argv = spawnedArgv();
  // Not the cmd.exe shim: these already ARE the arguments.
  if (argv[0] !== '/d') return [...argv];
  // Undo `escapeForCmd`'s carets, drop `execSpec`'s outer quotes, then take each
  // quoted run — including `""`, the empty tool list, which is the argument
  // whose loss would silently hand the labeler all 33 tools.
  const line = (argv[argv.length - 1] ?? '').replace(/\^([()%!^"<>&|])/g, '$1');
  const inner = line.replace(/^"/, '').replace(/"$/, '');
  const tokens = (inner.match(/"(?:[^"]|"")*"/g) ?? []).map((t) =>
    t.slice(1, -1).replace(/""/g, '"')
  );
  // token 0 is the CLI itself on this path; the argv branch above excludes it,
  // so drop it to make both platforms answer the same question.
  return /claude\.(cmd|exe)$/i.test(tokens[0] ?? '') ? tokens.slice(1) : tokens;
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
    // ⚠️ MATCHED AS WHOLE TOKENS, AND UNWRAPPED FIRST. Two traps here, both hit
    // on the way to this version:
    //
    //   1. `expect(joinedLine).toContain('-p')` is VACUOUS — `--permission-mode`
    //      contains `-p`, so deleting `-p` from the argv left the test green
    //      while stdin stopped being the prompt source at all.
    //   2. `expect(argv).toContain('-p')` is WRONG ON WINDOWS. With a `.cmd`,
    //      `execSpec` hands `spawn` the cmd.exe wrapper — `/d /v:off /s /c
    //      "<the whole command line>"` — so the flags are inside one string, not
    //      argv entries. On Linux the same call passes the flags through
    //      directly, so an array assertion passes on CI's ubuntu leg and fails
    //      on its windows one.
    const args = containedArgs();
    expect(args).toContain('-p');
    expect(args).toContain('--tools');
    expect(args).toContain('--strict-mcp-config');
    // THE EMPTY TOOL LIST SURVIVED THE SHIM. If this argument is ever dropped
    // the labeler silently receives all 33 tools — measured — which is the
    // loudest possible silent failure on this path.
    expect(args[args.indexOf('--tools') + 1]).toBe('');
    // `-p` carries NO VALUE and is LAST, so no prompt was smuggled into argv
    // (the #714 boundary — the excerpt only ever travels on stdin).
    expect(args[args.length - 1]).toBe('-p');
    // The containment claim is "strict-mcp-config WITH NO `--mcp-config`", so
    // the absence is half of it and was asserted nowhere before.
    expect(args).not.toContain('--mcp-config');
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
      // ⚠️ THE KILL IS ASSERTED, not just the verdict. This test's name claims
      // the tree is killed and its two assertions used to say only "it timed
      // out" — deleting the `killTree` call left it green while a 230 MB
      // `claude.exe` was orphaned holding a model call, which is the entire
      // reason the line exists. Caught in review.
      //
      // The branch differs by platform, so each is asserted where it applies:
      // on win32 `killTree` spawns taskkill (a SECOND spawn, ours being the
      // first); elsewhere it calls `child.kill()`.
      if (process.platform === 'win32') {
        const calls = vi.mocked(spawn).mock.calls;
        expect(calls.length).toBeGreaterThan(1);
        expect(calls[calls.length - 1][0]).toBe('taskkill');
        expect(calls[calls.length - 1][1]).toEqual(['/pid', String(fake.pid), '/T', '/F']);
      } else {
        expect(fake.kill).toHaveBeenCalled();
      }
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
