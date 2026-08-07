import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { cleanupTempDirs, tempDir } from '../../test-temp-dirs';
import {
  HookListener,
  PermissionRequest,
  isInsideClaudeDir,
  isOutsideCwd,
  shouldHoldPermission,
} from './hook-listener';
import { LogSink, createLogger, Logger, LogFields } from '../log/logger';
import { SessionEvent } from '../sessions/state-machine';

let dir: string;
let listener: HookListener;
let applied: Array<{ sessionId: string; ev: SessionEvent }>;
let nativeIds: Array<{ sessionId: string; nativeId: string; cause?: 'clear' }>;
let port: number;

beforeEach(async () => {
  dir = tempDir('sb-hooks-');
  applied = [];
  nativeIds = [];
  listener = new HookListener({
    stateDir: dir,
    log: createLogger(new LogSink({ dir }), 'hooks'),
    manager: {
      apply: (sessionId, ev) => applied.push({ sessionId, ev }),
      setNativeSessionId: (sessionId, nativeId, cause) => nativeIds.push({ sessionId, nativeId, cause }),
    },
  });
  port = await listener.start();
});

// The FILE-level teardown, so it runs LAST: vitest works `afterEach` hooks from
// the innermost suite outwards, and the nested blocks below stop their own
// listeners first. Every temp dir this file makes goes here, per test — a
// listener holds its stateDir open, so the stop has to come before the rm
// (#213). Both stateDirs of the nested blocks are per-test too, so nothing
// still in use is ever swept.
afterEach(() => {
  // `finally`, not two statements: a `beforeEach` that threw before assigning
  // `listener` would TypeError on the stop and skip the cleanup it is there to
  // protect — the footgun PR #212 removed from watcher.test.ts.
  try {
    listener.stop();
  } finally {
    cleanupTempDirs();
  }
});

function post(body: string, headers: Record<string, string>, host?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/hook',
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(host ? { host } : {}), ...headers },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      }
    );
    req.on('error', reject);
    req.end(body);
  });
}

function tokenFor(sessionId: string): string {
  const { tokenPath } = listener.registerSession(sessionId);
  return fs.readFileSync(tokenPath, 'utf8');
}

describe('§5.29 floor (done-when: invalid requests rejected and logged)', () => {
  it('401 without a valid token; nothing reaches the manager', async () => {
    expect(await post('{}', {})).toBe(401);
    expect(await post('{}', { 'x-switchboard-token': 'wrong' })).toBe(401);
    expect(applied).toHaveLength(0);
    const log = fs.readFileSync(path.join(dir, 'switchboard.log'), 'utf8');
    expect(log).toContain('invalid token');
  });

  it('403 for non-loopback Host even with a valid token', async () => {
    const t = tokenFor('s1');
    expect(await post('{}', { 'x-switchboard-token': t }, 'evil.example')).toBe(403);
    expect(applied).toHaveLength(0);
  });
});

describe('event routing', () => {
  it('maps hook payloads to session events and captures the native id', async () => {
    const t = tokenFor('s1');
    const status = await post(
      JSON.stringify({
        hook_event_name: 'Notification',
        notification_type: 'permission_prompt',
        message: 'Claude needs your permission',
        session_id: 'native-abc',
      }),
      { 'x-switchboard-token': t }
    );
    expect(status).toBe(200);
    await new Promise((r) => setTimeout(r, 50)); // ingest happens post-ack
    expect(nativeIds).toEqual([{ sessionId: 's1', nativeId: 'native-abc' }]);
    expect(applied).toHaveLength(1);
    expect(applied[0].ev).toMatchObject({
      kind: 'hook',
      event: 'Notification',
      notificationType: 'permission_prompt',
    });
  });

  it("SessionStart(source:'clear') tags the new native id with cause 'clear' (E10-07)", async () => {
    const t = tokenFor('s1');
    await post(
      JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup', session_id: 'native-1' }),
      { 'x-switchboard-token': t }
    );
    await post(
      JSON.stringify({ hook_event_name: 'SessionStart', source: 'clear', session_id: 'native-2' }),
      { 'x-switchboard-token': t }
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(nativeIds).toEqual([
      { sessionId: 's1', nativeId: 'native-1', cause: undefined },
      { sessionId: 's1', nativeId: 'native-2', cause: 'clear' },
    ]);
  });

  it('tokens are per-session and revocable', async () => {
    const t1 = tokenFor('s1');
    listener.unregisterSession('s1');
    expect(await post('{}', { 'x-switchboard-token': t1 })).toBe(401);
  });

  it('unparseable bodies are logged, not fatal', async () => {
    const t = tokenFor('s1');
    expect(await post('{{{nope', { 'x-switchboard-token': t })).toBe(200);
    await new Promise((r) => setTimeout(r, 50));
    expect(applied).toHaveLength(0);
  });
});

describe('PreToolUse hold + decision round-trip (P2-E10-03, §5.16)', () => {
  // a listener with holds armed: ask-autonomy sessions, short fail-open timeout
  let held: HookListener;
  let heldPort: number;
  let requests: PermissionRequest[];
  let heldApplied: Array<{ sessionId: string; ev: SessionEvent }>;

  beforeEach(async () => {
    requests = [];
    heldApplied = [];
    held = new HookListener({
      stateDir: tempDir('sb-hold-'),
      log: createLogger(new LogSink({ dir }), 'hooks'),
      manager: {
        apply: (sessionId, ev) => heldApplied.push({ sessionId, ev }),
        setNativeSessionId: () => {},
      },
      autonomyFor: () => 'ask',
      holdTimeoutMs: 400,
    });
    heldPort = await held.start();
    held.onPermissionRequest((r) => requests.push(r));
  });

  afterEach(() => held.stop());

  function postHeld(body: string, token: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: heldPort,
          path: '/hook',
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-switchboard-token': token },
        },
        (res) => {
          let out = '';
          res.on('data', (d) => (out += d));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: out }));
        }
      );
      req.on('error', reject);
      req.end(body);
    });
  }

  function heldToken(sessionId: string): string {
    const { tokenPath } = held.registerSession(sessionId);
    return fs.readFileSync(tokenPath, 'utf8');
  }

  const preToolUse = (tool: string) =>
    JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: tool,
      tool_input: { file_path: 'C:/x.ts', old_string: 'a', new_string: 'b' },
    });

  it('holds a gated call until allow; verdict JSON returns to the hook', async () => {
    const t = heldToken('s1');
    const pending = postHeld(preToolUse('Edit'), t);
    await new Promise((r) => setTimeout(r, 100));
    // parked: the request surfaced, the session flipped to needs-permission
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ tool: 'Edit', sessionId: 's1' });
    expect(requests[0].input).toMatchObject({ file_path: 'C:/x.ts' });
    expect(heldApplied.some((a) => a.ev.kind === 'permission-held')).toBe(true);

    expect(held.decide(requests[0].requestId, 'allow')).toBe(true);
    const res = await pending;
    const verdict = JSON.parse(res.body).hookSpecificOutput;
    expect(verdict).toMatchObject({ hookEventName: 'PreToolUse', permissionDecision: 'allow' });
    expect(heldApplied.some((a) => a.ev.kind === 'permission-resolved')).toBe(true);
  });

  it('deny returns a deny verdict with the reason', async () => {
    const t = heldToken('s1');
    const pending = postHeld(preToolUse('Bash'), t);
    await new Promise((r) => setTimeout(r, 100));
    held.decide(requests[0].requestId, 'deny', 'not on my watch');
    const verdict = JSON.parse((await pending).body).hookSpecificOutput;
    expect(verdict).toMatchObject({ permissionDecision: 'deny', permissionDecisionReason: 'not on my watch' });
  });

  it("the DEFAULT deny reason tells the model a human refused — not that a gate blocked it", async () => {
    // Dan 2026-07-26: "Denied from switchboard" read as an infrastructure
    // block, so Claude announced it was "getting blocked by something called
    // switchboard" and routed around the denial with other tools until it got
    // the result anyway. The reason string is fed to the MODEL — it has to
    // close that door explicitly.
    const t = heldToken('s1');
    const pending = postHeld(preToolUse('Bash'), t);
    await new Promise((r) => setTimeout(r, 100));
    held.decide(requests[0].requestId, 'deny'); // no reason -> the default
    const verdict = JSON.parse((await pending).body).hookSpecificOutput;
    const why = verdict.permissionDecisionReason as string;
    expect(verdict.permissionDecision).toBe('deny');
    expect(why).toMatch(/user/i); // a human decided
    expect(why).toMatch(/denied/i);
    expect(why).toMatch(/do not retry/i); // and must not be worked around
    expect(why).toMatch(/another tool|different route/i);
    // the old wording is the actual defect — it must not come back
    expect(why).not.toBe('Denied from switchboard');
  });

  it('timeout fails OPEN: {} response, so the CLI runs its own TUI prompt', async () => {
    const t = heldToken('s1');
    const res = await postHeld(preToolUse('Write'), t); // resolves via the 400ms timeout
    expect(res.body).toBe('{}');
    // a late decide on the dead request is refused
    expect(held.decide(requests[0].requestId, 'allow')).toBe(false);
  });

  it('non-gated calls are never held (instant {} ack)', async () => {
    const t = heldToken('s1');
    const res = await postHeld(preToolUse('Read'), t); // Read isn't gated for ask
    expect(res.body).toBe('{}');
    expect(requests).toHaveLength(0);
  });

  it('pendingRequests() replays in-flight holds; empties after decide (P0#3)', async () => {
    const t = heldToken('s1');
    const pending = postHeld(preToolUse('Edit'), t);
    await new Promise((r) => setTimeout(r, 100));
    const replay = held.pendingRequests();
    expect(replay).toHaveLength(1);
    expect(replay[0]).toMatchObject({ tool: 'Edit', sessionId: 's1' });
    held.decide(replay[0].requestId, 'allow');
    await pending;
    expect(held.pendingRequests()).toHaveLength(0);
  });

  it('unregisterSession releases in-flight holds (fail-open)', async () => {
    const t = heldToken('s1');
    const pending = postHeld(preToolUse('Edit'), t);
    await new Promise((r) => setTimeout(r, 100));
    held.unregisterSession('s1');
    expect((await pending).body).toBe('{}');
  });

  it('allow-all answers gated calls at the server: no hold, no event, no push (P2 #19)', async () => {
    const t = heldToken('s1');
    held.setAllowAll('s1');
    const res = await postHeld(preToolUse('Edit'), t); // resolves immediately
    const verdict = JSON.parse(res.body).hookSpecificOutput;
    expect(verdict).toMatchObject({ permissionDecision: 'allow' });
    expect(requests).toHaveLength(0); // renderer never bothered
    expect(held.pendingRequests()).toHaveLength(0); // nothing parked
    // and crucially: NO permission-held event -> no needs-permission beep
    expect(heldApplied.some((a) => a.ev.kind === 'permission-held')).toBe(false);
  });

  it('allow-all is per-LIVE-session and ends with it', async () => {
    const t1 = heldToken('s1');
    held.setAllowAll('s1');
    held.unregisterSession('s1'); // session over — the grant dies with it
    const t2 = heldToken('s1'); // "respawn" under the same id
    void t1;
    const pending = postHeld(preToolUse('Edit'), t2);
    await new Promise((r) => setTimeout(r, 100));
    expect(requests).toHaveLength(1); // prompts again
    held.decide(requests[0].requestId, 'deny');
    await pending;
  });
});

describe('a hold needs somebody to ask: window liveness (P2-E15-09, AR-P1-7)', () => {
  // The old guard was `permListeners.size === 0`, which can never fire in the
  // app: ipc.ts subscribes once at setup and never unsubscribes. So a closed
  // window or a crashed renderer left the CLI parked the full 300s per gated
  // call. These pin the real signal.
  let held: HookListener;
  let heldPort: number;
  let requests: PermissionRequest[];
  let heldApplied: Array<{ sessionId: string; ev: SessionEvent }>;
  let windowLive: boolean;
  let livenessChecks: number;
  let livenessThrows: boolean;
  /** every no-window line this listener logged, by level — #334's subject */
  let noWindowLines: { warn: number; debug: number };

  beforeEach(async () => {
    requests = [];
    heldApplied = [];
    windowLive = true;
    livenessChecks = 0;
    livenessThrows = false;
    noWindowLines = { warn: 0, debug: 0 };
    const realLog = createLogger(new LogSink({ dir }), 'hooks');
    const count =
      (level: 'warn' | 'debug') =>
      (msg: string, fields?: LogFields): void => {
        if (msg.startsWith('no live window to ask')) noWindowLines[level]++;
        realLog[level](msg, fields);
      };
    held = new HookListener({
      stateDir: tempDir('sb-live-'),
      log: { ...realLog, warn: count('warn'), debug: count('debug') } satisfies Logger,
      manager: {
        apply: (sessionId, ev) => heldApplied.push({ sessionId, ev }),
        setNativeSessionId: () => {},
      },
      autonomyFor: () => 'ask',
      // long on purpose: a fail-open here must be IMMEDIATE, not a timeout in
      // disguise — both produce '{}', only one of them is the fix
      holdTimeoutMs: 5_000,
      hasLiveWindow: () => {
        livenessChecks++;
        if (livenessThrows) throw new Error('window torn down mid-check');
        return windowLive;
      },
    });
    heldPort = await held.start();
    held.onPermissionRequest((r) => requests.push(r));
  });

  afterEach(() => held.stop());

  function postHeld(body: string, token: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: heldPort,
          path: '/hook',
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-switchboard-token': token },
        },
        (res) => {
          let out = '';
          res.on('data', (d) => (out += d));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: out }));
        }
      );
      req.on('error', reject);
      req.end(body);
    });
  }

  function heldToken(sessionId: string): string {
    const { tokenPath } = held.registerSession(sessionId);
    return fs.readFileSync(tokenPath, 'utf8');
  }

  const edit = JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: 'Edit',
    tool_input: { file_path: 'C:/x.ts', old_string: 'a', new_string: 'b' },
  });

  it('no live window: a gated call fails open IMMEDIATELY instead of parking the CLI', async () => {
    windowLive = false;
    const t = heldToken('s1');
    const started = Date.now();
    const res = await postHeld(edit, t);
    expect(res.body).toBe('{}'); // no opinion — the CLI's own prompt takes over
    expect(Date.now() - started).toBeLessThan(1_000); // not the 5s timeout
    expect(requests).toHaveLength(0); // nobody was asked
    expect(held.pendingRequests()).toHaveLength(0); // nothing parked
    // and no needs-permission state for a card that cannot be shown
    expect(heldApplied.some((a) => a.ev.kind === 'permission-held')).toBe(false);
    // but the event is STILL ingested — failing open must not make the session
    // go dark. The status path is what later surfaces the CLI's own prompt.
    expect(heldApplied.length).toBeGreaterThan(0);
  });

  it('an UNGATED call never consults the window (the gate sits after the policy)', async () => {
    // ordering matters for the log: checking liveness first would warn on every
    // PreToolUse a session makes, gated or not
    windowLive = false;
    const t = heldToken('s1');
    const read = JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'Read', // not gated at ask, inside the cwd
      tool_input: { file_path: 'C:/x.ts' },
    });
    expect((await postHeld(read, t)).body).toBe('{}');
    expect(livenessChecks).toBe(0);
  });

  it('live window: the same call still holds (the control — else the test above is vacuous)', async () => {
    const t = heldToken('s1');
    const pending = postHeld(edit, t);
    await new Promise((r) => setTimeout(r, 100));
    expect(requests).toHaveLength(1);
    expect(heldApplied.some((a) => a.ev.kind === 'permission-held')).toBe(true);
    held.decide(requests[0].requestId, 'allow');
    await pending;
  });

  it('the pendingPermissions replay path still works with a live window (must not regress)', async () => {
    const t = heldToken('s1');
    const pending = postHeld(edit, t);
    await new Promise((r) => setTimeout(r, 100));
    // this is what a reloading renderer re-reads on mount — a reload leaves the
    // window neither destroyed nor crashed, so it must still find its hold here
    const replay = held.pendingRequests();
    expect(replay).toHaveLength(1);
    expect(replay[0]).toMatchObject({ tool: 'Edit', sessionId: 's1' });
    held.decide(replay[0].requestId, 'allow');
    await pending;
    expect(held.pendingRequests()).toHaveLength(0);
  });

  it('allow-all is answered at the server even with no window — it never needed one', async () => {
    windowLive = false;
    const t = heldToken('s1');
    held.setAllowAll('s1');
    const res = await postHeld(edit, t);
    // the liveness gate sits AFTER allow-all on purpose: a granted session gets
    // its verdict, not a shrug
    expect(JSON.parse(res.body).hookSpecificOutput).toMatchObject({ permissionDecision: 'allow' });
    expect(requests).toHaveLength(0);
  });

  it('releaseHeld frees what was ALREADY parked when the window closed', async () => {
    // the liveness gate only helps calls arriving after the window dies; this is
    // the request that was already waiting when the user hit ✕
    const t = heldToken('s1');
    const pending = postHeld(edit, t);
    await new Promise((r) => setTimeout(r, 100));
    expect(held.pendingRequests()).toHaveLength(1);

    // deliberately NOT flipping windowLive: releaseHeld is the teardown path
    // and must free the request on its own, without consulting the gate
    held.releaseHeld('main window closed');
    expect((await pending).body).toBe('{}');
    expect(held.pendingRequests()).toHaveLength(0);
    // a decision arriving after the release is refused, not applied late
    expect(held.decide(requests[0].requestId, 'allow')).toBe(false);
  });

  it('a liveness check that THROWS counts as no window — never park on "I can\'t tell"', async () => {
    // the real provider touches Electron natives on an object that can be torn
    // down asynchronously. If it throws mid-request and we don't catch it, the
    // response is never ended and the CLI parks on ITS timeout instead — the
    // exact failure this item exists to remove.
    livenessThrows = true;
    const t = heldToken('s1');
    const started = Date.now();
    const res = await postHeld(edit, t);
    expect(res.body).toBe('{}');
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(held.pendingRequests()).toHaveLength(0);
  });

  it('releaseHeld with nothing parked is a no-op', () => {
    expect(() => held.releaseHeld('main window closed')).not.toThrow();
    expect(held.pendingRequests()).toHaveLength(0);
  });

  // #334. `noWindowWarned` means "already warned about the outage we are IN".
  // It was only ever cleared in `unregisterSession`, so within one session the
  // warning fired once and every later outage went out at `debug` — an operator
  // watching the log sees the first closed window and never the second.
  it('the no-window warning re-arms once a window comes back', async () => {
    const t = heldToken('s1');

    // Outage 1 — loud.
    windowLive = false;
    expect((await postHeld(edit, t)).body).toBe('{}');
    expect(noWindowLines).toEqual({ warn: 1, debug: 0 });

    // Still down — quiet. This is the flag's real job and must not regress:
    // one line per gated call is a log nobody reads.
    expect((await postHeld(edit, t)).body).toBe('{}');
    expect(noWindowLines).toEqual({ warn: 1, debug: 1 });

    // The window is back: this call holds like any other, and re-arms on its
    // way past the gate. A live window logs nothing at all here.
    windowLive = true;
    const pending = postHeld(edit, t);
    await new Promise((r) => setTimeout(r, 100));
    expect(requests).toHaveLength(1);
    held.decide(requests[0].requestId, 'allow');
    await pending;
    expect(noWindowLines).toEqual({ warn: 1, debug: 1 });

    // Outage 2 — loud AGAIN. Revert the `delete` in `maybeHold` and this is
    // the assertion that goes red (warn stays 1, debug becomes 2).
    windowLive = false;
    expect((await postHeld(edit, t)).body).toBe('{}');
    expect(noWindowLines).toEqual({ warn: 2, debug: 1 });
  });
});

describe('never ask a question whose answer the CLI discards (#127)', () => {
  // Measured 2026-08-01: Claude Code accepts our `permissionDecision:"allow"`
  // for the ordinary permission layer, then applies its `.claude/` safety check
  // ON TOP — so the user answered our bar and was prompted again in the
  // terminal six seconds later. Holding it presents a decision we do not own
  // (PHILOSOPHY P7); the #125 handoff bar explains the CLI's prompt instead.
  //
  // Paths are platform-shaped: a `C:/...` literal is a RELATIVE path on POSIX,
  // so hard-coding drive letters makes the positive cases fail on the Linux and
  // macOS CI legs AND the negative cases pass vacuously — a green half-suite
  // proving nothing. Same guard the out-of-cwd tests below already use.
  const win = process.platform === 'win32';
  const CWD = win ? 'C:/proj' : '/proj';
  const inClaude = win ? 'C:/proj/.claude/scripts/coverage.sh' : '/proj/.claude/scripts/coverage.sh';
  const inSrc = win ? 'C:/proj/src/index.ts' : '/proj/src/index.ts';
  const lookalike = win ? 'C:/proj/.claude-backup/x' : '/proj/.claude-backup/x';
  const otherProject = win ? 'C:/other/.claude/settings.json' : '/other/.claude/settings.json';

  it("does not hold a write into the project's own .claude folder", () => {
    for (const tool of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']) {
      expect(
        shouldHoldPermission('ask', tool, { file_path: inClaude }, CWD),
        `held ${tool} into .claude`
      ).toBe(false);
    }
  });

  it('holds the same tools everywhere else — this is a carve-out, not a retreat', () => {
    expect(shouldHoldPermission('ask', 'Write', { file_path: inSrc }, CWD)).toBe(true);
    // a sibling whose name merely STARTS with .claude is not inside it
    expect(shouldHoldPermission('ask', 'Write', { file_path: lookalike }, CWD)).toBe(true);
  });

  it("still holds a write into ANOTHER project's .claude folder", () => {
    // Only the session's OWN folder is guarded by the CLI on its behalf; a
    // write into someone else's .claude is exactly what our bar exists for.
    expect(shouldHoldPermission('ask', 'Write', { file_path: otherProject }, CWD)).toBe(true);
  });

  it('resolves RELATIVE tool paths against the session folder', () => {
    expect(shouldHoldPermission('ask', 'Write', { file_path: '.claude/hooks.json' }, CWD)).toBe(false);
    expect(shouldHoldPermission('ask', 'Write', { file_path: 'src/app.ts' }, CWD)).toBe(true);
  });

  it('carves out the GLOBAL .claude too, when a session runs in the home folder', () => {
    // The highest-consequence instance: `<cwd>/.claude` is then global
    // settings, global CLAUDE.md, and hooks that fire in EVERY session. Still
    // correct — the CLI guards it identically and it is that session's own
    // `.claude` — but it must be a deliberate, recorded choice rather than a
    // surprise nobody considered.
    const home = win ? 'C:/Users/dan' : '/home/dan';
    const target = win ? 'C:/Users/dan/.claude/settings.json' : '/home/dan/.claude/settings.json';
    expect(shouldHoldPermission('ask', 'Write', { file_path: target }, home)).toBe(false);
  });

  it('leaves pathless and shell tools alone', () => {
    // WebFetch is MUTATING but not an EDIT tool, so the carve-out never
    // considers it — which is why the branch keys off toolCategory rather than
    // MUTATING. Bash could redirect into .claude and we cannot tell from the
    // command string; it keeps its normal hold. (Whether the CLI's guard is
    // tool-scoped, and therefore whether a Bash write double-prompts too, is
    // UNVERIFIED — worth a probe if it ever bites.)
    expect(shouldHoldPermission('ask', 'WebFetch', { url: 'https://x' }, CWD)).toBe(true);
    expect(shouldHoldPermission('ask', 'Bash', { command: 'echo hi > .claude/x' }, CWD)).toBe(true);
  });

  it('needs a cwd to judge containment, and does not guess without one', () => {
    expect(shouldHoldPermission('ask', 'Write', { file_path: '.claude/x' }, undefined)).toBe(true);
  });
});

describe('isInsideClaudeDir', () => {
  const win = process.platform === 'win32';
  const cwd = win ? 'C:/proj' : '/proj';
  const abs = (rest: string) => (win ? `C:/proj/${rest}` : `/proj/${rest}`);

  it('is true for the directory itself and anything under it', () => {
    expect(isInsideClaudeDir(abs('.claude'), cwd)).toBe(true);
    expect(isInsideClaudeDir(abs('.claude/skills/a/b.md'), cwd)).toBe(true);
    expect(isInsideClaudeDir('.claude/settings.json', cwd)).toBe(true);
  });

  it('is false for siblings, parents and lookalikes', () => {
    expect(isInsideClaudeDir(abs('src/x.ts'), cwd)).toBe(false);
    expect(isInsideClaudeDir(abs('.claude-backup/x'), cwd)).toBe(false);
    expect(isInsideClaudeDir(win ? 'C:/other/.claude/x' : '/other/.claude/x', cwd)).toBe(false);
    expect(isInsideClaudeDir('../.claude/x', cwd)).toBe(false);
  });

  it('escapes fail toward HOLDING, which is the safe direction', () => {
    expect(isInsideClaudeDir('.claude/../../escape.txt', cwd)).toBe(false);
    expect(isInsideClaudeDir('', cwd)).toBe(false);
  });

  it('handles a drive-root / filesystem-root session folder', () => {
    // The case string-prefixing broke on (review P1 #10): resolve() keeps the
    // trailing separator, so `base + sep` matches nothing.
    const root = win ? 'C:/' : '/';
    expect(isInsideClaudeDir(win ? 'C:/.claude/x' : '/.claude/x', root)).toBe(true);
    expect(isInsideClaudeDir(win ? 'C:/src/x' : '/src/x', root)).toBe(false);
  });
});

describe('shouldHoldPermission policy', () => {
  it('NEVER holds an interactive question tool, at any autonomy (#92)', () => {
    // The tool is in the PreToolUse matcher purely so we learn the session is
    // blocked. Holding it would park the CLI behind our approval bar for a
    // dialog only the Terminal can answer — nothing to click, and a verdict
    // that can never come.
    for (const autonomy of ['ask', 'plan', 'auto-edit', 'full-auto', undefined]) {
      expect(
        shouldHoldPermission(autonomy, 'AskUserQuestion', {}, 'C:/proj'),
        `held AskUserQuestion at autonomy=${autonomy}`
      ).toBe(false);
    }
  });

  it('gates by autonomy exactly as the CLI would prompt', () => {
    expect(shouldHoldPermission('ask', 'Edit')).toBe(true);
    expect(shouldHoldPermission('ask', 'Read')).toBe(false);
    expect(shouldHoldPermission('auto-edit', 'Edit')).toBe(false);
    expect(shouldHoldPermission('auto-edit', 'Bash')).toBe(true);
    expect(shouldHoldPermission('full-auto', 'Bash')).toBe(false);
    expect(shouldHoldPermission(undefined, 'Bash')).toBe(false); // unknown: fail open
  });

  it('plan NEVER holds — the CLI\'s own plan enforcement is authoritative (P0#1, Option A)', () => {
    expect(shouldHoldPermission('plan', 'Edit')).toBe(false);
    expect(shouldHoldPermission('plan', 'Bash')).toBe(false);
    expect(shouldHoldPermission('plan', 'PowerShell')).toBe(false);
    expect(shouldHoldPermission('plan', 'Read', { file_path: 'C:/elsewhere/x' }, 'C:/proj')).toBe(false);
  });

  it('gates the Windows PowerShell tool like Bash (2026-07-22 probe)', () => {
    expect(shouldHoldPermission('ask', 'PowerShell')).toBe(true);
    expect(shouldHoldPermission('auto-edit', 'PowerShell')).toBe(true);
    expect(shouldHoldPermission('full-auto', 'PowerShell')).toBe(false);
  });

  it('read tools hold ONLY when they leave the session folder', () => {
    // platform-real paths: 'C:/...' is a RELATIVE path on POSIX, and the
    // fixed isOutsideCwd resolves relative targets against the session
    // folder (review P1 #10) — so drive-letter literals only mean
    // "absolute" on Windows
    const win = process.platform === 'win32';
    const cwd = win ? 'C:/proj/app' : '/proj/app';
    const inside = win ? 'C:/proj/app/src/x.ts' : '/proj/app/src/x.ts';
    const downloads = win ? 'C:/Users/dan/Downloads/w2.pdf' : '/home/dan/Downloads/w2.pdf';
    const elsewhere = win ? 'C:/elsewhere' : '/elsewhere';
    expect(shouldHoldPermission('ask', 'Read', { file_path: inside }, cwd)).toBe(false);
    expect(shouldHoldPermission('ask', 'Read', { file_path: downloads }, cwd)).toBe(true);
    expect(shouldHoldPermission('auto-edit', 'Glob', { path: elsewhere }, cwd)).toBe(true);
    expect(shouldHoldPermission('ask', 'Grep', {}, cwd)).toBe(false); // no target = stays in cwd
    expect(shouldHoldPermission('full-auto', 'Read', { file_path: `${elsewhere}/x` }, cwd)).toBe(false);
  });
});

describe('isOutsideCwd path handling (review P1 #10)', () => {
  const win = process.platform === 'win32';
  it('relative tool paths resolve against the SESSION folder, not the app cwd', () => {
    const cwd = win ? 'C:/proj/app' : '/proj/app';
    expect(isOutsideCwd('src/x.ts', cwd)).toBe(false);
    expect(isOutsideCwd('./deep/y.ts', cwd)).toBe(false);
    expect(isOutsideCwd('../sibling/z.ts', cwd)).toBe(true);
    expect(isOutsideCwd('..', cwd)).toBe(true);
  });

  it('a drive-root/filesystem-root session folder contains its own files', () => {
    const root = win ? 'D:\\' : '/';
    expect(isOutsideCwd(win ? 'D:\\x.txt' : '/x.txt', root)).toBe(false);
    expect(isOutsideCwd(win ? 'D:\\deep\\y.txt' : '/deep/y.txt', root)).toBe(false);
    if (win) expect(isOutsideCwd('C:\\other.txt', 'D:\\')).toBe(true); // cross-drive
  });

  it('the base folder itself is inside; case differences fold on win32', () => {
    const cwd = win ? 'C:/proj/app' : '/proj/app';
    expect(isOutsideCwd(cwd, cwd)).toBe(false);
    if (win) expect(isOutsideCwd('c:/PROJ/app/x.ts', cwd)).toBe(false);
  });

  it('a sibling folder whose name starts with dots is still outside-aware', () => {
    const cwd = win ? 'C:/proj/app' : '/proj/app';
    expect(isOutsideCwd(win ? 'C:/proj/app/..config/x' : '/proj/app/..config/x', cwd)).toBe(false);
    expect(isOutsideCwd(win ? 'C:/proj/other/x' : '/proj/other/x', cwd)).toBe(true);
  });
});

describe('buildHookSettings', () => {
  it('produces a valid injectable hook config with token-by-path (S-03)', () => {
    const settings = listener.buildHookSettings('s9') as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string; timeout: number }> }>>;
    };
    for (const ev of ['SessionStart', 'UserPromptSubmit', 'Notification', 'SubagentStop', 'Stop']) {
      expect(settings.hooks[ev]).toHaveLength(1);
      const h = settings.hooks[ev][0].hooks[0];
      expect(h.timeout).toBe(10);
      expect(h.command).toContain('hook-forwarder.cjs');
      expect(h.command).toContain('hook-token'); // path, not the token itself
      expect(h.command).not.toMatch(/[0-9a-f]{32}/); // no raw token on argv
    }
    // PreToolUse: its own entry — long-wait forwarder, CLI timeout above ours,
    // and a MATCHER (required for tool hooks; its absence silently disabled
    // approvals in production — Dan 2026-07-21). Must cover the Windows shell
    // tool and the read tools the out-of-cwd rule gates.
    const preEntry = settings.hooks['PreToolUse'][0] as { matcher?: string; hooks: Array<{ command: string; timeout: number }> };
    const pre = preEntry.hooks[0];
    expect(pre.timeout).toBeGreaterThan(60);
    expect(pre.command).toMatch(/hook-forwarder\.cjs.*\d{4,}$/); // waitMs argv
    for (const tool of ['Bash', 'PowerShell', 'Write', 'Edit', 'Read', 'Glob']) {
      expect(preEntry.matcher).toContain(tool);
    }
    expect(fs.existsSync(path.join(dir, 'hook-forwarder.cjs'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 's9', 'hook-token'))).toBe(true);
  });
});

describe('hook-token files follow their session (#282)', () => {
  // Listeners in this block own their stateDir so the sweep under test can
  // never see another test's leavings — and are stopped HERE, before the
  // file-level `cleanupTempDirs()` removes the directory out from under them.
  let own: HookListener | null;
  let logged: Array<{ level: string; msg: string; fields?: LogFields }>;

  /** A Logger that keeps what it was told, so "fail-open" is assertable as
   *  "warned and carried on" rather than merely "did not throw". */
  function capturingLog(): Logger {
    const at =
      (level: string) =>
      (msg: string, fields?: LogFields): void => {
        logged.push({ level, msg, fields });
      };
    const l: Logger = {
      debug: at('debug'),
      info: at('info'),
      warn: at('warn'),
      error: at('error'),
      child: () => l,
    };
    return l;
  }

  function listenerOn(stateDir: string): HookListener {
    return new HookListener({
      stateDir,
      log: capturingLog(),
      manager: { apply: () => {}, setNativeSessionId: () => {} },
    });
  }

  /** POST to a listener on its own port, resolving with the RESPONSE BODY —
   *  which for a held PreToolUse is the verdict the CLI applies. */
  function postTo(p: number, body: string, token: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: p,
          path: '/hook',
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-switchboard-token': token },
        },
        (res) => {
          let out = '';
          res.on('data', (d) => (out += d));
          res.on('end', () => resolve(out));
        }
      );
      req.on('error', reject);
      req.end(body);
    });
  }

  /** Warnings this block is about — `start()` may also warn about node not
   *  being on PATH, which is nothing to do with tokens. */
  const tokenWarnings = (): typeof logged =>
    logged.filter((l) => l.level === 'warn' && /token/.test(l.msg));

  beforeEach(() => {
    logged = [];
    own = null;
  });

  afterEach(() => {
    own?.stop();
  });

  it('unregisterSession deletes the token file, not just the map entry', () => {
    const { tokenPath } = listener.registerSession('s-gone');
    expect(fs.existsSync(tokenPath)).toBe(true);
    listener.unregisterSession('s-gone');
    expect(fs.existsSync(tokenPath)).toBe(false);
    // the DIRECTORY is not ours to remove — `settings.json` lives there too
    expect(fs.existsSync(path.join(dir, 's-gone'))).toBe(true);
  });

  it('a session that never got a token unregisters quietly', () => {
    own = listenerOn(tempDir('sb-token-'));
    // no directory, no file: a session torn down before `buildHookSettings`
    // ever ran, or one on a provider with no hooks capability. Not a fault, so
    // it says nothing — and it gets commoner once PR #281 makes the teardown
    // path unregister twice.
    expect(() => own!.unregisterSession('never-registered')).not.toThrow();
    expect(tokenWarnings()).toEqual([]);
  });

  it('a token file that will not delete is logged and swallowed', () => {
    own = listenerOn(tempDir('sb-token-'));
    const { tokenPath } = own.registerSession('s-stuck');
    // Fail the unlink the same way on every platform: put a DIRECTORY where the
    // file was (EISDIR on POSIX, EPERM on win32) — the closest stand-in for the
    // Windows case that actually happens, a scanner holding the handle.
    fs.rmSync(tokenPath);
    fs.mkdirSync(tokenPath);
    expect(() => own!.unregisterSession('s-stuck')).not.toThrow();
    expect(tokenWarnings()).toHaveLength(1);
    expect(tokenWarnings()[0].fields?.sessionId).toBe('s-stuck');
  });

  it('...and a parked hold is still released — the step AFTER the removal', async () => {
    // The removal is not the last thing `unregisterSession` does: the fail-open
    // hold release is. Asserting the token is revoked would prove nothing (the
    // map is emptied BEFORE the removal, so it survives a throw); this is the
    // half a throw would actually skip, and skipping it parks the CLI for the
    // full hold with nobody left to answer.
    const stateDir = tempDir('sb-token-');
    own = new HookListener({
      stateDir,
      log: capturingLog(),
      manager: { apply: () => {}, setNativeSessionId: () => {} },
      autonomyFor: () => 'ask',
      holdTimeoutMs: 30_000, // long enough that a timeout can't fake the pass
    });
    own.onPermissionRequest(() => {}); // without a subscriber nothing is held
    const heldPort = await own.start();
    const { tokenPath } = own.registerSession('s-stuck');
    const token = fs.readFileSync(tokenPath, 'utf8').trim();
    const inFlight = postTo(
      heldPort,
      JSON.stringify({
        hook_event_name: 'PreToolUse',
        tool_name: 'Edit',
        tool_input: { file_path: 'C:/x.ts', old_string: 'a', new_string: 'b' },
      }),
      token
    );
    await new Promise((r) => setTimeout(r, 100));
    expect(own.pendingRequests()).toHaveLength(1);

    fs.rmSync(tokenPath);
    fs.mkdirSync(tokenPath); // the unlink will now throw
    own.unregisterSession('s-stuck');

    expect(own.pendingRequests()).toEqual([]);
    expect(await inFlight).toBe('{}'); // fail-open: the CLI runs its own prompt
  });

  it('start() sweeps the tokens a previous run left behind', async () => {
    const stateDir = tempDir('sb-token-');
    for (const id of ['s-old-1', 's-old-2']) {
      fs.mkdirSync(path.join(stateDir, id), { recursive: true });
      fs.writeFileSync(path.join(stateDir, id, 'hook-token'), 'deadbeefdeadbeef');
    }
    own = listenerOn(stateDir);
    await own.start();
    // Dead weight by definition: the token map is memory, so a file this
    // process did not write can never authenticate again.
    expect(fs.existsSync(path.join(stateDir, 's-old-1', 'hook-token'))).toBe(false);
    expect(fs.existsSync(path.join(stateDir, 's-old-2', 'hook-token'))).toBe(false);
    const swept = logged.find((l) => l.msg === 'swept orphaned hook tokens');
    expect(swept?.fields?.count).toBe(2);
  });

  it('the sweep takes hook-token files and NOTHING else', async () => {
    const stateDir = tempDir('sb-token-');
    fs.mkdirSync(path.join(stateDir, 's-old'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 's-old', 'hook-token'), 'deadbeef');
    fs.writeFileSync(path.join(stateDir, 's-old', 'settings.json'), '{}'); // providers/claude.ts
    fs.writeFileSync(path.join(stateDir, 's-old', 'notes.txt'), 'x');
    fs.mkdirSync(path.join(stateDir, 's-empty'));
    fs.writeFileSync(path.join(stateDir, 'loose-file'), 'x');
    own = listenerOn(stateDir);
    await own.start();
    expect(fs.existsSync(path.join(stateDir, 's-old', 'hook-token'))).toBe(false);
    expect(fs.existsSync(path.join(stateDir, 's-old', 'settings.json'))).toBe(true);
    expect(fs.existsSync(path.join(stateDir, 's-old', 'notes.txt'))).toBe(true);
    expect(fs.existsSync(path.join(stateDir, 's-old'))).toBe(true); // dirs stay
    expect(fs.existsSync(path.join(stateDir, 's-empty'))).toBe(true);
    expect(fs.existsSync(path.join(stateDir, 'loose-file'))).toBe(true);
    expect(fs.existsSync(path.join(stateDir, 'hook-forwarder.cjs'))).toBe(true);
  });

  it('a first run has nothing to sweep and says nothing about it', async () => {
    own = listenerOn(tempDir('sb-token-'));
    expect(await own.start()).toBeGreaterThan(0);
    expect(tokenWarnings()).toEqual([]);
    expect(logged.some((l) => l.msg === 'swept orphaned hook tokens')).toBe(false);
  });
});
