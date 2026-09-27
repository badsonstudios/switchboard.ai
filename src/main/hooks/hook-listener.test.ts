import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { cleanupTempDirs, tempDir } from '../../test-temp-dirs';
import { HookListener } from './hook-listener';
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

// `HookResponse` and `verdictOf` went with the hold path (#952). They typed and
// unwrapped the listener's answer to a HELD `PreToolUse` POST — the
// `hookSpecificOutput` envelope carrying `permissionDecision` and
// `permissionDecisionReason`. Nothing is held now, every POST is answered `{}`,
// and there is no verdict to read. `e2e/approval.spec.ts` declared the same
// shape independently; if that copy is still there, it is stale for the same
// reason.

/** The file-level log, or '' before anything has been written to it. */
function logText(): string {
  try {
    return fs.readFileSync(path.join(dir, 'switchboard.log'), 'utf8');
  } catch {
    return ''; // nothing logged yet
  }
}

/**
 * Wait until `what` is true, or fail at a real deadline (#627).
 *
 * Replaces `await new Promise((r) => setTimeout(r, 100))` — a fixed sleep
 * betting that an HTTP round-trip into the listener finishes inside 100ms.
 * It usually does; under machine load (a parallel e2e run pinning the box) it
 * does not, and the assertion after it goes red for reasons that have nothing
 * to do with the code under test. This waits for the signal the test actually
 * needs, for as long as the machine needs — and fails LOUDLY, naming the
 * signal, if the signal never comes.
 *
 * Waiting on ONE signal is enough to assert on the rest of the handler's work,
 * because `handle`'s `end` callback — maybeHold, the listener fan-out, ingest,
 * the `permission-held` apply — contains no `await` at all. Test code cannot
 * run part-way through it, in any tick, so observing any signal at all means
 * the whole callback finished. Prefer a MONOTONIC signal (`requests.length`,
 * `applied.length`) over one that clears itself: `pendingRequests()` empties
 * again when the hold times out, so polling for it in a short-`holdTimeoutMs`
 * suite could miss its window and report "never parked" for something that
 * parked and then expired.
 *
 * Hand-rolled rather than `vi.waitFor` (used across `health/service.test.ts`)
 * on purpose: `waitFor` only retries when its callback THROWS, so a boolean
 * predicate returning `false` would satisfy it immediately and every call site
 * would have to be written as an `expect` — losing the plain-English signal
 * name that makes the failure message worth reading.
 *
 * The deadline is a failure detector, not a timing assertion — deliberately
 * generous, and under vitest's own 5s test timeout so the failure carries this
 * message rather than an anonymous timeout.
 */
async function until(signal: string, what: () => boolean, timeoutMs = 3_000): Promise<void> {
  const started = Date.now();
  const deadline = started + timeoutMs;
  for (;;) {
    if (what()) return;
    if (Date.now() >= deadline) {
      // the elapsed time as well as the budget: on a box loaded enough for this
      // to fire, "waited 3012ms" and "waited 9400ms" mean different things
      throw new Error(
        `timed out waiting for ${signal} (budget ${timeoutMs}ms, waited ${Date.now() - started}ms)`
      );
    }
    await new Promise((r) => setTimeout(r, 2));
  }
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
  // AN *IDLE* NOTIFICATION, NOT A PERMISSION ONE, AND THE SWAP IS THE POINT.
  //
  // This used to post `permission_prompt`. Since #952 made #313's guard
  // unconditional, a permission Notification is dropped before it reaches the
  // manager for EVERY session — so the old payload would have asserted routing
  // through a path that deliberately no longer routes. The subject here is
  // payload-to-event mapping and native-id capture, neither of which is about
  // permissions; the idle nag is a Notification with no `can_use_tool`
  // equivalent, which is exactly what the hook channel is still for.
  //
  // The dropped case, and the fact that a drop still learns the native id, are
  // asserted in `permission-notification-guard.test.ts`.
  it('maps hook payloads to session events and captures the native id', async () => {
    const t = tokenFor('s1');
    const status = await post(
      JSON.stringify({
        hook_event_name: 'Notification',
        notification_type: 'idle',
        message: 'Claude is waiting for your input',
        session_id: 'native-abc',
      }),
      { 'x-switchboard-token': t }
    );
    expect(status).toBe(200);
    // ingest happens post-ack, so the 200 is not proof it ran — wait for it
    await until('the Notification to reach the manager', () => applied.length === 1);
    expect(nativeIds).toEqual([{ sessionId: 's1', nativeId: 'native-abc' }]);
    expect(applied).toHaveLength(1);
    expect(applied[0].ev).toMatchObject({
      kind: 'hook',
      event: 'Notification',
      notificationType: 'idle',
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
    await until('both SessionStarts to reach the manager', () => nativeIds.length === 2);
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
    // "nothing arrived" needs a positive anchor, or it passes vacuously by
    // asserting too early: ingest writes this warning at exactly the point a
    // parseable body would have reached the manager.
    await until('the unparseable-body warning', () => logText().includes('hook event unparseable'));
    expect(applied).toHaveLength(0);
  });
});

// ── SEVEN SUITES WENT WITH THE HOLD PATH (#952) ─────────────────────────────
//
// Roughly 900 lines covering the `PreToolUse` hold: the decision round-trip
// (P2-E10-03, §5.16), window liveness (P2-E15-09, AR-P1-7), the answer-surface
// probe (#699), the `.claude/` carve-out (#127), `isInsideClaudeDir`,
// `shouldHoldPermission`'s policy table, and `isOutsideCwd`'s path handling.
//
// None of it was ported. Every one of those suites tested a decision this
// listener no longer makes — it does not classify tools, does not consult an
// autonomy, and does not park an HTTP response. `StreamPermissions` makes the
// decisions now and `stream-permissions.test.ts` is where their coverage lives;
// it was never a port target because that router was built with its own tests
// from P2-E18-07.
//
// WHAT WAS GENUINELY LOST, so it is not rediscovered as a surprise: the
// `.claude/` carve-out's unit coverage (#127). It declined edit-family writes
// into a project's own `.claude/` because the CLI applies a safety check ABOVE
// the permission layer that a hook verdict does not satisfy. That case is not
// unhandled — the control channel reports it properly, as
// `decision_reason_type: 'safetyCheck'` with a suggested remedy, and it is the
// finding that forced the whole transport migration (DESIGN §6, 2026-08-01) —
// but the app no longer has to detect it, so there is no predicate left to test.
// The three exported helpers it needed (`isInsideClaudeDir`, `isOutsideCwd`,
// `shouldHoldPermission`) went with it.

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
    expect(fs.existsSync(path.join(dir, 'hook-forwarder.cjs'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 's9', 'hook-token'))).toBe(true);
  });

  // THE DELETION'S OBSERVABLE CONTRACT (#952), and the reason it is an assertion
  // rather than a comment: this is the line that stops the CLI calling us before
  // every tool run, and re-adding the entry is exactly how the hold path would
  // come back to life by accident.
  //
  // It used to be a whole paragraph of this file's largest test: PreToolUse got
  // its own entry with a long-wait forwarder (a fourth argv telling it to WAIT
  // for a decision), a CLI-side timeout a beat above ours so OUR fail-open `{}`
  // won the race, and a MATCHER — whose absence had silently disabled approvals
  // in production once (Dan, 2026-07-21), which is why the matcher was asserted
  // tool by tool.
  it('registers NO PreToolUse entry — permissions ride can_use_tool (#952)', () => {
    const settings = listener.buildHookSettings('s10') as { hooks: Record<string, unknown> };
    expect(settings.hooks['PreToolUse']).toBeUndefined();
    // The status set is untouched, which is the other half of the claim: this
    // listener is still the status channel, and `Stop` is still the done
    // authority (S-06).
    expect(Object.keys(settings.hooks).sort()).toEqual([
      'Notification',
      'PostToolUse',
      'SessionStart',
      'Stop',
      'SubagentStop',
      'UserPromptSubmit',
    ]);
  });

  // No `waitMs` fourth argument on any surviving entry: it existed ONLY so the
  // forwarder would block for a held decision, and a forwarder that still waited
  // would hold the CLI for nothing.
  it('no entry asks the forwarder to wait', () => {
    const settings = listener.buildHookSettings('s11') as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    for (const entries of Object.values(settings.hooks)) {
      expect(entries[0].hooks[0].command).not.toMatch(/hook-forwarder\.cjs.*\d{4,}$/);
    }
  });
});

describe('hook-token files follow their session (#282)', () => {
  // Session ids the sweep will look at: `randomUUID()`'s exact shape, which is
  // the only name it deletes under (#470). Fixed rather than generated so a
  // failure names the same directory every time.
  const OLD_1 = '11111111-2222-4333-8444-555555555555';
  const OLD_2 = '66666666-7777-4888-8999-aaaaaaaaaaaa';
  const LIVE = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';

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

  // `postTo` went with them (#952): it POSTed to a listener on its own port and
  // resolved with the RESPONSE BODY, which was only interesting when that body
  // was a held request's verdict. The suites in this block use `own.registerSession`
  // and the filesystem directly, which is what they were ever really about.

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

  // A THIRD TEST STOOD HERE AND WENT WITH THE HOLD PATH (#952).
  //
  // It pinned the step AFTER the token removal: `unregisterSession` ended by
  // releasing any parked hold, fail-open, so a throw from the token unlink could
  // not skip it and park the CLI for the full 300s with nobody left to answer.
  // Nothing parks now — `pending`, `release()` and the whole hold went with the
  // PTY transport — so the ordering it protected no longer exists.
  //
  // The two tests either side of it are the ones that still matter, and they are
  // unchanged: the unlink is best-effort and must not throw out of a teardown.

  it('start() sweeps the tokens a previous run left behind', async () => {
    const stateDir = tempDir('sb-token-');
    for (const id of [OLD_1, OLD_2]) {
      fs.mkdirSync(path.join(stateDir, id), { recursive: true });
      fs.writeFileSync(path.join(stateDir, id, 'hook-token'), 'deadbeefdeadbeef');
    }
    own = listenerOn(stateDir);
    await own.start();
    // Dead weight by definition: the token map is memory, so a file this
    // process did not write can never authenticate again.
    expect(fs.existsSync(path.join(stateDir, OLD_1, 'hook-token'))).toBe(false);
    expect(fs.existsSync(path.join(stateDir, OLD_2, 'hook-token'))).toBe(false);
    const swept = logged.find((l) => l.msg === 'swept orphaned hook tokens');
    expect(swept?.fields?.count).toBe(2);
  });

  it('the sweep takes hook-token files and NOTHING else', async () => {
    const stateDir = tempDir('sb-token-');
    fs.mkdirSync(path.join(stateDir, OLD_1), { recursive: true });
    fs.writeFileSync(path.join(stateDir, OLD_1, 'hook-token'), 'deadbeef');
    fs.writeFileSync(path.join(stateDir, OLD_1, 'settings.json'), '{}'); // providers/claude.ts
    fs.writeFileSync(path.join(stateDir, OLD_1, 'notes.txt'), 'x');
    fs.mkdirSync(path.join(stateDir, OLD_2));
    fs.writeFileSync(path.join(stateDir, 'loose-file'), 'x');
    own = listenerOn(stateDir);
    await own.start();
    expect(fs.existsSync(path.join(stateDir, OLD_1, 'hook-token'))).toBe(false);
    expect(fs.existsSync(path.join(stateDir, OLD_1, 'settings.json'))).toBe(true);
    expect(fs.existsSync(path.join(stateDir, OLD_1, 'notes.txt'))).toBe(true);
    expect(fs.existsSync(path.join(stateDir, OLD_1))).toBe(true); // dirs stay
    expect(fs.existsSync(path.join(stateDir, OLD_2))).toBe(true);
    expect(fs.existsSync(path.join(stateDir, 'loose-file'))).toBe(true);
    expect(fs.existsSync(path.join(stateDir, 'hook-forwarder.cjs'))).toBe(true);
  });

  // #470. The sweep used to delete `<anything>/hook-token` for every directory
  // in the root — no check that the name was one WE minted. Same lesson as
  // #354: a sweep with no shape filter is one mount-point surprise away from
  // deleting somebody else's file.
  describe('the sweep only touches names we minted (#470)', () => {
    it('leaves a hook-token under a directory that is not a session id', async () => {
      const stateDir = tempDir('sb-token-');
      // Three ways a non-session name lands in this root: a human, another
      // tool, and the near-misses a loose regex would accept.
      const strangers = [
        'notes',
        'Documents',
        `${OLD_1}-backup`,
        // randomUUID is lower-case, so upper case is somebody else's. Its OWN
        // uuid, not OLD_1's: Windows would treat the two as one directory and
        // the fixture would be testing itself.
        'CCCCCCCC-DDDD-4EEE-8FFF-999999999999',
        OLD_1.replaceAll('-', ''), // right characters, no dashes
      ];
      for (const name of strangers) {
        fs.mkdirSync(path.join(stateDir, name), { recursive: true });
        fs.writeFileSync(path.join(stateDir, name, 'hook-token'), 'not-ours');
      }
      fs.mkdirSync(path.join(stateDir, OLD_1), { recursive: true });
      fs.writeFileSync(path.join(stateDir, OLD_1, 'hook-token'), 'ours');
      own = listenerOn(stateDir);
      await own.start();
      for (const name of strangers) {
        expect(fs.existsSync(path.join(stateDir, name, 'hook-token'))).toBe(true);
      }
      expect(fs.existsSync(path.join(stateDir, OLD_1, 'hook-token'))).toBe(false);
      expect(logged.find((l) => l.msg === 'swept orphaned hook tokens')?.fields?.count).toBe(1);
    });

    it('never takes a token this process is holding', async () => {
      // Empty at the real call site — `start()` sweeps before anything can
      // register — but the guard travels with the sweep so that stays true for
      // a caller that ever sweeps at some other moment (#290's argument).
      const stateDir = tempDir('sb-token-');
      own = listenerOn(stateDir);
      const { tokenPath } = own.registerSession(LIVE);
      fs.mkdirSync(path.join(stateDir, OLD_1), { recursive: true });
      fs.writeFileSync(path.join(stateDir, OLD_1, 'hook-token'), 'dead');
      await own.start();
      expect(fs.existsSync(tokenPath)).toBe(true);
      expect(fs.existsSync(path.join(stateDir, OLD_1, 'hook-token'))).toBe(false);
    });

    it('stops at its budget and says so, leaving the rest for the next start', async () => {
      const stateDir = tempDir('sb-token-');
      for (const id of [OLD_1, OLD_2]) {
        fs.mkdirSync(path.join(stateDir, id), { recursive: true });
        fs.writeFileSync(path.join(stateDir, id, 'hook-token'), 'dead');
      }
      own = new HookListener({
        stateDir,
        log: capturingLog(),
        manager: { apply: () => {}, setNativeSessionId: () => {} },
        sweepBudgetMs: 0, // spent before the first candidate
      });
      await own.start();
      expect(fs.existsSync(path.join(stateDir, OLD_1, 'hook-token'))).toBe(true);
      expect(fs.existsSync(path.join(stateDir, OLD_2, 'hook-token'))).toBe(true);
      const hit = logged.filter((l) => /sweep hit its budget/.test(l.msg));
      // One line for the whole sweep. `break` makes a second impossible today,
      // so this guards the refactor that turns it into a `continue` (which is
      // what the directory sweep does, and why that one needs a latch).
      expect(hit).toHaveLength(1);
      expect(hit[0].fields?.budgetMs).toBe(0);
      // ...and a token left behind is dead weight, never a live credential:
      // nothing in memory can authenticate it.
      expect(logged.some((l) => l.msg === 'swept orphaned hook tokens')).toBe(false);
    });

    it('a budget spent PART WAY takes what it reached and stops there', async () => {
      // The case a zero budget cannot reach: the sweep does real work, then
      // stops. The clock is injected because a real one cannot be made to run
      // out between two `unlink`s on demand.
      const stateDir = tempDir('sb-token-');
      const ids = [OLD_1, OLD_2, LIVE]; // LIVE is registered with nobody here
      for (const id of ids) {
        fs.mkdirSync(path.join(stateDir, id), { recursive: true });
        fs.writeFileSync(path.join(stateDir, id, 'hook-token'), 'dead');
      }
      // startedAt, then one reading per candidate: the first is inside the
      // budget, the second is not.
      const readings = [0, 10, 500, 500];
      own = new HookListener({
        stateDir,
        log: capturingLog(),
        manager: { apply: () => {}, setNativeSessionId: () => {} },
        sweepBudgetMs: 100,
        sweepNow: () => readings.shift() ?? 500,
      });
      await own.start();

      const left = ids.filter((id) => fs.existsSync(path.join(stateDir, id, 'hook-token')));
      expect(left).toHaveLength(2); // one taken, the rest waiting
      expect(logged.find((l) => l.msg === 'swept orphaned hook tokens')?.fields?.count).toBe(1);
      expect(logged.filter((l) => /sweep hit its budget/.test(l.msg))).toHaveLength(1);
    });
  });

  it('a first run has nothing to sweep and says nothing about it', async () => {
    own = listenerOn(tempDir('sb-token-'));
    expect(await own.start()).toBeGreaterThan(0);
    expect(tokenWarnings()).toEqual([]);
    expect(logged.some((l) => l.msg === 'swept orphaned hook tokens')).toBe(false);
  });
});
