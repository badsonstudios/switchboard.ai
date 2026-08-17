// P2-E18-07 — can_use_tool -> the approval bar.
//
// The `.claude/` write that prompts the owner TWICE today is the acceptance
// case, and it appears here twice over: once as the routing test, and once end
// to end through the #134 fake, where the FILE actually gets written.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { cleanupTempDirs, tempDir } from '../../test-temp-dirs';
import { StreamPermissions } from './stream-permissions';
import { SessionEvent, transition } from './state-machine';
import { streamStatusEvent } from './stream-status';
import { PermissionRequest } from '../hooks/hook-listener';
import { FakeStreamProtocol } from '../providers/fake-stream-protocol';
import { LogSink, createLogger, LogFields, Logger } from '../log/logger';

let dir: string;
let sent: Array<{ sessionId: string; msg: Record<string, unknown> }>;
let requests: PermissionRequest[];
let resolved: string[];
/** every `SessionManager.apply` the router made — #310's whole subject */
let applied: Array<{ sessionId: string; ev: SessionEvent }>;
let perms: StreamPermissions;

/** The exact payload S-10 probe B captured off the real CLI. */
function canUseTool(requestId = 'req-1', filePath = 'C:/p/.claude/scripts/coverage.sh') {
  return {
    type: 'control_request',
    request_id: requestId,
    request: {
      subtype: 'can_use_tool',
      tool_name: 'Write',
      display_name: 'Write',
      input: { file_path: filePath, content: 'echo hi\n' },
      description: filePath,
      decision_reason: `Claude requested permissions to edit ${filePath}, which is a sensitive file.`,
      decision_reason_type: 'safetyCheck',
      permission_suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
      classifier_approvable: true,
      tool_use_id: 'toolu_01XF73D7YpDPjwQLPtHdQwDT',
    },
  };
}

beforeEach(() => {
  dir = tempDir('sb-perm-');
  sent = [];
  requests = [];
  resolved = [];
  applied = [];
  perms = new StreamPermissions(
    (sessionId, msg) => {
      sent.push({ sessionId, msg: msg as Record<string, unknown> });
      return true;
    },
    (sessionId, ev) => applied.push({ sessionId, ev }),
    createLogger(new LogSink({ dir }), 'perm')
  );
  perms.onPermissionRequest((r) => requests.push(r));
  perms.onPermissionResolved((id) => resolved.push(id));
});
afterEach(() => cleanupTempDirs()); // one per test, gone at the end of it (#213)

describe('offering a request (P2-E18-07)', () => {
  it('turns can_use_tool into the SAME PermissionRequest the hook path emits', () => {
    perms.offer('s1', canUseTool());

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      sessionId: 's1',
      tool: 'Write',
      source: 'stream',
      input: { file_path: 'C:/p/.claude/scripts/coverage.sh' },
    });
  });

  // The asymmetry that IS the argument for the migration: the CLI tells this
  // channel why it is asking and what would satisfy it, and tells a hook
  // nothing.
  it('carries the reason, the reason TYPE, and the suggestions', () => {
    perms.offer('s1', canUseTool());
    const r = requests[0];

    expect(r.reason).toContain('sensitive file');
    expect(r.reasonType).toBe('safetyCheck');
    expect(r.suggestions).toEqual([
      { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
    ]);
    expect(r.displayName).toBe('Write');
  });

  // hook_callback and mcp_message ride the same channel. Treating every control
  // request as a question would park a working session on needs-permission with
  // nothing to answer.
  it('ignores control requests that are not can_use_tool', () => {
    perms.offer('s1', { type: 'control_request', request_id: 'x', request: { subtype: 'hook_callback' } });
    perms.offer('s1', { type: 'control_request', request_id: 'y', request: { subtype: 'mcp_message' } });
    expect(requests).toEqual([]);
  });

  it('ignores messages that are not control requests at all', () => {
    perms.offer('s1', { type: 'assistant' });
    perms.offer('s1', { type: 'result', subtype: 'success' });
    expect(requests).toEqual([]);
  });

  // With no id there is nothing to echo back, so offering it would park the
  // card on a question whose answer goes nowhere.
  it('drops an unanswerable request rather than asking an unanswerable question', () => {
    perms.offer('s1', { type: 'control_request', request: { subtype: 'can_use_tool' } });
    expect(requests).toEqual([]);
    expect(perms.pendingRequests()).toEqual([]);
  });

  it('a duplicate delivery does not double-ask', () => {
    perms.offer('s1', canUseTool('req-1'));
    perms.offer('s1', canUseTool('req-1'));
    expect(requests).toHaveLength(1);
  });

  // One `decidePermission` channel serves both routers, so a stream id must
  // never look like a hook id.
  it('namespaces the request id by session', () => {
    perms.offer('s1', canUseTool('req-1'));
    perms.offer('s2', canUseTool('req-1')); // same NATIVE id, different session
    expect(requests.map((r) => r.requestId)).toEqual([
      'stream:s1:req-1',
      'stream:s2:req-1',
    ]);
  });
});

describe('deciding (P2-E18-07)', () => {
  it('allow answers the CLI with behavior:allow and echoes the input back', () => {
    perms.offer('s1', canUseTool());
    expect(perms.decide('stream:s1:req-1', 'allow')).toBe(true);

    expect(sent).toHaveLength(1);
    expect(sent[0].sessionId).toBe('s1');
    expect(sent[0].msg).toEqual({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: 'req-1', // the CLI's own id, not our namespaced one
        response: {
          behavior: 'allow',
          updatedInput: { file_path: 'C:/p/.claude/scripts/coverage.sh', content: 'echo hi\n' },
        },
      },
    });
  });

  it('deny answers deny and carries the reason', () => {
    perms.offer('s1', canUseTool());
    perms.decide('stream:s1:req-1', 'deny', 'not this time');

    const r = (sent[0].msg.response as { response: Record<string, unknown> }).response;
    expect(r).toEqual({ behavior: 'deny', message: 'not this time' });
  });

  it('resolving notifies, so the bar clears', () => {
    perms.offer('s1', canUseTool());
    perms.decide('stream:s1:req-1', 'allow');
    expect(resolved).toEqual(['stream:s1:req-1']);
    expect(perms.pendingRequests()).toEqual([]);
  });

  it('deciding twice answers the CLI once', () => {
    perms.offer('s1', canUseTool());
    expect(perms.decide('stream:s1:req-1', 'allow')).toBe(true);
    expect(perms.decide('stream:s1:req-1', 'allow')).toBe(false);
    expect(sent).toHaveLength(1);
  });

  // ipc.ts falls through hooks -> stream on one channel; an unknown id must
  // report "not mine" rather than throwing or claiming it.
  it('returns false for an id it does not own', () => {
    expect(perms.decide('hook-request-42', 'allow')).toBe(false);
    expect(sent).toEqual([]);
  });
});

describe('a closed card (P2-E18-07)', () => {
  // DENY rather than drop: an unanswered control request leaves the CLI waiting
  // for ever, and a wedged session is worse than a refused tool call — the user
  // can always ask again.
  it('auto-denies anything outstanding rather than stranding the CLI', () => {
    perms.offer('s1', canUseTool('a'));
    perms.offer('s1', canUseTool('b', 'C:/p/other.txt'));
    perms.offer('s2', canUseTool('c'));

    perms.forgetSession('s1', 'session closed');

    expect(sent.map((s) => s.sessionId)).toEqual(['s1', 's1']);
    for (const s of sent) {
      const r = (s.msg.response as { response: Record<string, unknown> }).response;
      expect(r.behavior).toBe('deny');
    }
    // the other session is untouched
    expect(perms.pendingRequests().map((r) => r.sessionId)).toEqual(['s2']);
  });

  it('resolves them too, so no bar is left behind', () => {
    perms.offer('s1', canUseTool('a'));
    perms.forgetSession('s1', 'session closed');
    expect(resolved).toEqual(['stream:s1:a']);
  });
});

describe('a broken subscriber never strands the CLI (P2-E18-07)', () => {
  it('a listener that throws does not stop the request being pending', () => {
    perms.onPermissionRequest(() => {
      throw new Error('boom');
    });
    perms.offer('s1', canUseTool());

    expect(perms.pendingRequests()).toHaveLength(1);
    expect(perms.decide('stream:s1:req-1', 'allow')).toBe(true);
  });
});

// The whole epic, end to end, in process: the fake raises the request, we
// answer allow, and the FILE gets written — the thing S-10 probe B proved by
// hand and that the hook path cannot do at all.
describe('the .claude/ case, end to end against the fake (P2-E18-07)', () => {
  it('answering allow actually writes the file', () => {
    const writes: Array<{ path: string; content: string }> = [];
    const out: Record<string, unknown>[] = [];
    const proto = new FakeStreamProtocol(
      {
        cwd: () => 'C:/p',
        writeFile: (p, content) => writes.push({ path: p, content }),
        stderr: () => {},
        exit: () => {},
        resolve: (c, t) => `${c}/${t}`,
      },
      (m) => out.push(m)
    );
    // route the fake's control requests into the router, and our answers back
    const router = new StreamPermissions(
      (_id, msg) => {
        proto.handle(msg as Record<string, unknown>);
        return true;
      },
      () => {},
      createLogger(new LogSink({ dir }), 'perm')
    );
    let asked: PermissionRequest | undefined;
    router.onPermissionRequest((r) => (asked = r));

    proto.handle({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: '!perm .claude/scripts/coverage.sh' }] },
    });
    for (const m of out) router.offer('s1', m);

    // the user is asked, with the CLI's own prose
    expect(asked).toBeTruthy();
    expect(asked!.reasonType).toBe('safetyCheck');
    expect(writes).toEqual([]); // nothing written yet

    router.decide(asked!.requestId, 'allow');

    expect(writes).toEqual([
      { path: 'C:/p/.claude/scripts/coverage.sh', content: 'echo hi\n' },
    ]);
  });

  it('answering deny writes nothing', () => {
    const writes: unknown[] = [];
    const out: Record<string, unknown>[] = [];
    const proto = new FakeStreamProtocol(
      {
        cwd: () => 'C:/p',
        writeFile: (p, c) => writes.push({ p, c }),
        stderr: () => {},
        exit: () => {},
        resolve: (c, t) => `${c}/${t}`,
      },
      (m) => out.push(m)
    );
    const router = new StreamPermissions(
      (_id, msg) => {
        proto.handle(msg as Record<string, unknown>);
        return true;
      },
      () => {},
      createLogger(new LogSink({ dir }), 'perm')
    );
    let asked: PermissionRequest | undefined;
    router.onPermissionRequest((r) => (asked = r));

    proto.handle({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: '!perm .claude/x.sh' }] },
    });
    for (const m of out) router.offer('s1', m);
    router.decide(asked!.requestId, 'deny', 'no');

    expect(writes).toEqual([]);
  });
});

// P2-E18-07 — the #127 stopgap, and why it must not fire in stream mode.
//
// #127 made `shouldHoldPermission` DECLINE edit-family writes into
// `<cwd>/.claude/`, because a hook's allow is discarded there and asking the
// user a question whose answer the CLI throws away is worse than not asking.
// Over `can_use_tool` the answer is NOT discarded (S-10 probe B), so the
// carve-out must not apply — that reversal is the whole point of the epic.
describe('the two channels do not both ask (P2-E18-07)', () => {
  it('shouldHoldPermission still declines a .claude write — the PTY rule is unchanged', async () => {
    const { shouldHoldPermission } = await import('../hooks/hook-listener');
    const cwd = process.platform === 'win32' ? 'C:/proj' : '/proj';
    const target = process.platform === 'win32' ? 'C:/proj/.claude/x.json' : '/proj/.claude/x.json';

    expect(shouldHoldPermission('ask', 'Write', { file_path: target }, cwd)).toBe(false);
  });

  it('a normal write in the same session is still held', async () => {
    const { shouldHoldPermission } = await import('../hooks/hook-listener');
    const cwd = process.platform === 'win32' ? 'C:/proj' : '/proj';
    const target = process.platform === 'win32' ? 'C:/proj/src/x.ts' : '/proj/src/x.ts';

    expect(shouldHoldPermission('ask', 'Write', { file_path: target }, cwd)).toBe(true);
  });

  // The stream router has no such carve-out and must not grow one: it offers
  // whatever the CLI delegates, and the CLI only delegates what it wants
  // answered.
  it('the stream router offers a .claude write like any other', () => {
    perms.offer('s1', canUseTool('r', 'C:/proj/.claude/settings.json'));
    expect(requests).toHaveLength(1);
    expect(requests[0].reasonType).toBe('safetyCheck');
  });
});

// #310 — the answer ends `needs-permission`. Nothing else does, in time.
//
// The hook path has applied `permission-resolved` on every decision since
// E2-05. The stream path never did, and the gap is not academic: the ONLY other
// thing that leaves `needs-permission` in stream mode is the next
// `assistant`/`stream_event` off the CLI, and the CLI does not speak again until
// the tool it just asked about has RUN. Dan measured the consequence live —
// ~5s of "Claude is asking permission in the terminal" per gated call, in a
// transport with no terminal.
//
// These run the state machine for real rather than asserting on the recorded
// `apply` call alone, because "the router called apply" is not the claim; "the
// card stops saying needs-permission" is.
describe('a decision resolves the status, without waiting for the CLI (#310)', () => {
  it('applies permission-resolved to the deciding session', () => {
    perms.offer('s1', canUseTool());
    perms.decide('stream:s1:req-1', 'allow');

    expect(applied).toEqual([{ sessionId: 's1', ev: { kind: 'permission-resolved' } }]);
  });

  it('walks needs-permission back to working with NO further stream message', () => {
    // 1. the CLI asks: this is what put the card in needs-permission — the
    //    same message, through the same mapper `SessionManager` uses
    const asking = canUseTool();
    expect(transition('working', streamStatusEvent(asking)!).status).toBe('needs-permission');
    perms.offer('s1', asking);

    // 2. the user answers. Nothing else arrives — no assistant, no
    //    stream_event, no result. The stream is silent, as it is in reality
    //    until the tool has run.
    perms.decide('stream:s1:req-1', 'allow');

    // 3. and the card is already out of needs-permission
    expect(applied).toHaveLength(1);
    expect(transition('needs-permission', applied[0].ev).status).toBe('working');
  });

  it('a denial resolves the status too — a refused tool is not a pending question', () => {
    perms.offer('s1', canUseTool());
    perms.decide('stream:s1:req-1', 'deny', 'no');

    expect(applied).toEqual([{ sessionId: 's1', ev: { kind: 'permission-resolved' } }]);
  });

  it('an id it does not own moves nobody', () => {
    expect(perms.decide('hook-request-42', 'allow')).toBe(false);
    expect(applied).toEqual([]);
  });

  it('deciding twice applies once', () => {
    perms.offer('s1', canUseTool());
    perms.decide('stream:s1:req-1', 'allow');
    perms.decide('stream:s1:req-1', 'allow');
    expect(applied).toHaveLength(1);
  });

  // The deliberate NON-mirror, and it mirrors the hook path exactly:
  // `HookListener.release` does not apply either. Both callers of
  // `forgetSession` are teardowns (`ipc.ts` -> `releaseHeldPermissions`), and a
  // transition there would walk a dying session to `working` a beat before its
  // exit lands — see that function's own comment. The CLI still gets its
  // answer; only the badge stays put.
  it('a teardown answers the CLI but does NOT walk a dying session to working', () => {
    perms.offer('s1', canUseTool());
    perms.forgetSession('s1', 'session closed');

    expect(sent).toHaveLength(1); // the CLI is released
    expect(resolved).toEqual(['stream:s1:req-1']); // the bar comes down
    expect(applied).toEqual([]); // and the status is left alone
  });
});

// #319 — a stream hold has to fail open, and it never did.
//
// The hook path has had three defences since P2-E15-09: a 300s deadline, a
// `hasLiveWindow` gate before parking, and a `releaseHeld` wired to the window
// closing and to the renderer dying. This router had NONE of them. Its only
// exit was `forgetSession`, reached solely from a closed card or a session's own
// exit — so a `can_use_tool` offered to a window that was then closed sat there
// FOR EVER. Not 300 seconds. For ever: the CLI is blocked on our answer and on
// nothing else, and a stream `control_request` has no TUI prompt waiting behind
// it the way a held `PreToolUse` does.
//
// Which is also why every one of these resolves to DENY rather than to silence.
// The hook path's fail-open is "say nothing, the CLI's own prompt takes over";
// there is no such fallback here, so "no opinion" is not one of the things this
// channel can say. A refused tool call is recoverable — ask again — and a wedged
// session is not.
describe('failing open when nobody can answer (#319)', () => {
  /** the router under test, built with the two knobs the app now wires */
  function router(opts: {
    hasLiveWindow?: () => boolean;
    holdTimeoutMs?: number;
  }): StreamPermissions {
    const p = new StreamPermissions(
      (sessionId, msg) => {
        sent.push({ sessionId, msg: msg as Record<string, unknown> });
        return true;
      },
      (sessionId, ev) => applied.push({ sessionId, ev }),
      createLogger(new LogSink({ dir }), 'perm'),
      opts
    );
    p.onPermissionRequest((r) => requests.push(r));
    p.onPermissionResolved((id) => resolved.push(id));
    return p;
  }

  /** what the CLI was told, unwrapped from the control_response envelope */
  function behaviourOf(i = 0): Record<string, unknown> {
    const msg = sent[i].msg as { response?: { response?: Record<string, unknown> } };
    return msg.response?.response ?? {};
  }

  describe('the window is gone', () => {
    it('denies at once rather than offering a question nobody can see', () => {
      const p = router({ hasLiveWindow: () => false });

      p.offer('s1', canUseTool());

      expect(requests).toEqual([]); // nothing was pushed at a dead renderer
      expect(p.pendingRequests()).toEqual([]); // and nothing is parked
      expect(sent).toHaveLength(1);
      expect(behaviourOf().behavior).toBe('deny');
      // and the message reaches the MODEL, not a log — see `unavailable`. It
      // has to rule out "a sandbox is blocking me", which is what makes an agent
      // route around a denial with a second tool instead of accepting it.
      expect(String(behaviourOf().message)).toMatch(/not a sandbox restriction/i);
      expect(String(behaviourOf().message)).toMatch(/nobody available to review/i);
    });

    // The card the user comes back to must not claim to be holding a question
    // that was answered while they were away. This is the half `forgetSession`
    // deliberately skips, and the difference is that this session is ALIVE.
    it('ends needs-permission, because the session carries on without us', () => {
      const p = router({ hasLiveWindow: () => false });

      p.offer('s1', canUseTool());

      expect(applied).toEqual([{ sessionId: 's1', ev: { kind: 'permission-resolved' } }]);
      expect(transition('needs-permission', applied[0].ev).status).toBe('working');
    });

    // "I can't tell" must never resolve to "park the CLI" — the hook path's
    // rule, and the same reason: the cost of being wrong is asymmetric.
    it('a liveness check that THROWS counts as no window', () => {
      const p = router({
        hasLiveWindow: () => {
          throw new Error('window handle exploded');
        },
      });

      expect(() => p.offer('s1', canUseTool())).not.toThrow();
      expect(behaviourOf().behavior).toBe('deny');
      expect(requests).toEqual([]);
    });

    it('a live window still gets asked, exactly as before', () => {
      const p = router({ hasLiveWindow: () => true });

      p.offer('s1', canUseTool());

      expect(requests).toHaveLength(1);
      expect(p.pendingRequests()).toHaveLength(1);
      expect(sent).toEqual([]); // nothing answered on the user's behalf
    });

    // every call site that predates #319, and every unit test in this file
    it('no provider at all means assume yes', () => {
      const p = router({});
      p.offer('s1', canUseTool());
      expect(requests).toHaveLength(1);
    });
  });

  describe('the deadline', () => {
    it('answers a question the user never got to, and says so', async () => {
      const p = router({ holdTimeoutMs: 20 });
      p.offer('s1', canUseTool());
      expect(p.pendingRequests()).toHaveLength(1);

      await new Promise((r) => setTimeout(r, 60));

      expect(p.pendingRequests()).toEqual([]);
      expect(behaviourOf().behavior).toBe('deny');
      // The message reaches the MODEL, not a log — the lesson `HookListener`'s
      // `verdict` records. It has to rule out "a sandbox is blocking me", which
      // is what makes an agent route around a denial instead of accepting it.
      expect(String(behaviourOf().message)).toMatch(/not a sandbox restriction/i);
      expect(resolved).toEqual(['stream:s1:req-1']); // the bar comes down too
      expect(applied).toEqual([{ sessionId: 's1', ev: { kind: 'permission-resolved' } }]);
    });

    it('a decision cancels it — no second answer arrives later', async () => {
      const p = router({ holdTimeoutMs: 20 });
      p.offer('s1', canUseTool());
      p.decide('stream:s1:req-1', 'allow');

      await new Promise((r) => setTimeout(r, 60));

      expect(sent).toHaveLength(1); // the user's allow, and only that
      expect(behaviourOf().behavior).toBe('allow');
      expect(resolved).toEqual(['stream:s1:req-1']);
    });

    it('a teardown cancels it too', async () => {
      const p = router({ holdTimeoutMs: 20 });
      p.offer('s1', canUseTool());
      p.forgetSession('s1', 'session closed');

      await new Promise((r) => setTimeout(r, 60));

      expect(sent).toHaveLength(1);
      expect(applied).toEqual([]); // still a teardown: the badge is left alone
    });
  });

  describe('the renderer went away with questions already parked', () => {
    // The `hasLiveWindow` gate only helps calls that arrive AFTER the window
    // dies. This is the other half, and without it the deadline is the only
    // thing left between the user and a five-minute wedge.
    it('releaseHeld denies everything outstanding, across every session', () => {
      const p = router({});
      p.offer('s1', canUseTool('a'));
      p.offer('s2', canUseTool('b'));

      p.releaseHeld('main window closed');

      expect(p.pendingRequests()).toEqual([]);
      expect(sent.map((s) => s.sessionId)).toEqual(['s1', 's2']);
      expect(behaviourOf(0).behavior).toBe('deny');
      expect(behaviourOf(1).behavior).toBe('deny');
      expect(resolved).toEqual(['stream:s1:a', 'stream:s2:b']);
    });

    // Both sessions are still RUNNING — only the window went. Leaving them on
    // needs-permission means the user reopens to two cards claiming to hold
    // questions that were answered without them.
    it('and resolves both statuses, unlike a teardown', () => {
      const p = router({});
      p.offer('s1', canUseTool('a'));
      p.offer('s2', canUseTool('b'));

      p.releaseHeld('renderer gone: crashed');

      expect(applied).toEqual([
        { sessionId: 's1', ev: { kind: 'permission-resolved' } },
        { sessionId: 's2', ev: { kind: 'permission-resolved' } },
      ]);
    });

    it('with nothing parked it is a silent no-op', () => {
      const p = router({});
      expect(() => p.releaseHeld('main window closed')).not.toThrow();
      expect(sent).toEqual([]);
      expect(applied).toEqual([]);
    });
  });
});

// #334 — the same defect the hook path had, fixed in the same place for the
// same reason: `noWindowWarned` means "already warned about the outage we are
// IN". It was only cleared in `forgetSession`, so within one session the
// warning fired once and every later outage went out at `debug`. These two
// blocks are the same question asked by the two channels and must not drift.
describe('the no-window warning re-arms once a window comes back (#334)', () => {
  it('warns per OUTAGE, not once per session', () => {
    let windowLive = false;
    const lines = { warn: 0, debug: 0 };
    const realLog = createLogger(new LogSink({ dir }), 'perm');
    const count =
      (level: 'warn' | 'debug') =>
      (msg: string, fields?: LogFields): void => {
        if (msg.startsWith('no live window to ask')) lines[level]++;
        realLog[level](msg, fields);
      };
    const log = { ...realLog, warn: count('warn'), debug: count('debug') } satisfies Logger;
    const p = new StreamPermissions(
      () => true,
      () => {},
      log,
      { hasLiveWindow: () => windowLive }
    );

    // Outage 1 — loud.
    p.offer('s1', canUseTool('req-1'));
    expect(lines).toEqual({ warn: 1, debug: 0 });

    // Still down — quiet. The flag's real job; must not regress.
    p.offer('s1', canUseTool('req-2'));
    expect(lines).toEqual({ warn: 1, debug: 1 });

    // Window back: this one holds, and re-arms on its way past the gate.
    windowLive = true;
    p.offer('s1', canUseTool('req-3'));
    expect(p.pendingRequests()).toHaveLength(1);
    expect(lines).toEqual({ warn: 1, debug: 1 });

    // Outage 2 — loud AGAIN. Revert the `delete` in `offer` and this goes red.
    windowLive = false;
    p.offer('s1', canUseTool('req-4'));
    expect(lines).toEqual({ warn: 2, debug: 1 });

    p.forgetSession('s1', 'test over'); // clears the held req-3 timer
  });
});

// #319 — "Allow all (this session)" answered at the SERVER, for Direct too.
//
// It was renderer-only: `sessions:allowAllSession` told `HookListener` alone,
// and `HookListener.maybeHold` returns 'pass' for a stream session BEFORE it
// ever consults its allow-all set. So main knew nothing, every gated call still
// had to reach a live window, and a Direct session with no window could not run
// a gated tool at all — it parked (see the fail-open tests above).
//
// The renderer's auto-allow branch still exists and still works; it is now the
// backstop for requests already in flight when the user clicked, not the
// mechanism.
describe('allow-all is answered at the server (#319)', () => {
  it('answers allow with the CLI own input, and asks nobody', () => {
    perms.setAllowAll('s1');
    perms.offer('s1', canUseTool());

    expect(requests).toEqual([]); // no push, so no bar and no beep
    expect(perms.pendingRequests()).toEqual([]); // and nothing held
    expect(sent).toHaveLength(1);
    const msg = sent[0].msg as { response?: { response?: Record<string, unknown> } };
    expect(msg.response?.response).toMatchObject({
      behavior: 'allow',
      // echoed back untouched: it is the CLI's own input and editing it would
      // be reimplementing a decision (P7)
      updatedInput: { file_path: 'C:/p/.claude/scripts/coverage.sh', content: 'echo hi\n' },
    });
  });

  // The exact mirror of the hook path, and the reason the suppressor in
  // `SessionManager` is load-bearing rather than a belt to this brace: an
  // allow-all call touches the status machine NOT AT ALL. `maybeHold` returns
  // 'answered' and its caller applies nothing, because a question that was
  // never asked has no answer to record.
  //
  // Resolving here instead would look like free insurance and is not: this
  // session can be in `needs-permission` for a reason unrelated to this call —
  // a request offered before the grant and still queued in the card, or a
  // `Notification` hook on a mixed session — and walking it to `working` is
  // #310 pointed the other way.
  it('touches the status machine not at all', () => {
    perms.setAllowAll('s1');
    perms.offer('s1', canUseTool());

    expect(applied).toEqual([]);
  });

  it('is per session — the card next to it still asks', () => {
    perms.setAllowAll('s1');

    perms.offer('s1', canUseTool('a'));
    perms.offer('s2', canUseTool('b'));

    expect(requests.map((r) => r.sessionId)).toEqual(['s2']);
  });

  // A grant belongs to the LIVE session it was given to. `HookListener`'s
  // semantics, and the renderer's (`sessionStore.allowAllByLive`): a respawn
  // gets a new id and asks again, which is what stops #224's leak.
  it('a teardown ends the grant — the next session asks again', () => {
    perms.setAllowAll('s1');
    perms.forgetSession('s1', 'session closed');
    expect(perms.isAllowAll('s1')).toBe(false);

    perms.offer('s1', canUseTool());

    expect(requests).toHaveLength(1);
  });

  // A session with no window CAN now run a gated tool — the headline of (b),
  // and the interaction between the two halves of this issue. Checked in this
  // order because the reverse (liveness first) would turn every allow-all
  // verdict into a denial the moment the user closed the window.
  it('needs no renderer at all: allow-all beats the liveness gate', () => {
    const p = new StreamPermissions(
      (sessionId, msg) => {
        sent.push({ sessionId, msg: msg as Record<string, unknown> });
        return true;
      },
      (sessionId, ev) => applied.push({ sessionId, ev }),
      createLogger(new LogSink({ dir }), 'perm'),
      { hasLiveWindow: () => false }
    );
    p.setAllowAll('s1');

    p.offer('s1', canUseTool());

    const msg = sent[0].msg as { response?: { response?: Record<string, unknown> } };
    expect(msg.response?.response).toMatchObject({ behavior: 'allow' });
  });
});

// ── #563 — the CLI's own chooser rides this channel too ──────────────────────
//
// Measured, not assumed: `spike/s11/probe-2-ask-user-question.cjs` against the
// CLI on PATH (2.1.233). `AskUserQuestion` arrives as an ordinary
// `can_use_tool`, and the answer goes back as `answers` written onto
// `updatedInput`. Everything below pins the two places that makes this router
// behave differently from an ordinary permission.

/** The captured `AskUserQuestion` request, trimmed to what the router reads. */
function askUserQuestion(requestId = 'req-q') {
  return {
    type: 'control_request',
    request_id: requestId,
    request: {
      subtype: 'can_use_tool',
      tool_name: 'AskUserQuestion',
      display_name: 'AskUserQuestion',
      input: {
        questions: [
          {
            question: 'Which colour do you prefer?',
            header: 'Colour',
            options: [{ label: 'Red' }, { label: 'Blue' }],
            multiSelect: false,
          },
        ],
      },
      tool_use_id: 'toolu_01question',
    },
  };
}

/** the inner `response` object of the Nth thing we sent */
function responseAt(n: number): Record<string, unknown> {
  const msg = sent[n].msg as { response?: { response?: Record<string, unknown> } };
  return msg.response?.response ?? {};
}

describe('answering a question (#563)', () => {
  it('sends the answers on updatedInput instead of echoing the input back', () => {
    perms.offer('s1', askUserQuestion());
    const id = requests[0].requestId;

    const answered = {
      ...(askUserQuestion().request.input as Record<string, unknown>),
      answers: { 'Which colour do you prefer?': 'Red' },
    };
    expect(perms.decide(id, 'allow', undefined, answered)).toBe(true);

    expect(responseAt(0)).toMatchObject({ behavior: 'allow', updatedInput: answered });
  });

  it('falls back to the CLI own input when no answer is supplied', () => {
    // Not a hypothetical: the OS toast and any future surface answer with three
    // arguments. The CLI reads this as "the user did not answer the questions"
    // (probe mode `empty`) — honest, and never a malformed response.
    perms.offer('s1', askUserQuestion());
    perms.decide(requests[0].requestId, 'allow');

    expect(responseAt(0)).toMatchObject({
      behavior: 'allow',
      updatedInput: askUserQuestion().request.input,
    });
    expect((responseAt(0).updatedInput as Record<string, unknown>).answers).toBeUndefined();
  });

  it('ignores an updatedInput aimed at a tool that does not answer questions', () => {
    // The trust direction is backwards for this one field — it travels renderer
    // -> CLI. A renderer rewriting a Write on the way to allow would make the
    // command the user READ and the command that RUNS two different strings.
    perms.offer('s1', canUseTool());
    perms.decide(requests[0].requestId, 'allow', undefined, {
      file_path: 'C:/p/evil.sh',
      content: 'rm -rf /',
    });

    expect(responseAt(0)).toMatchObject({
      updatedInput: { file_path: 'C:/p/.claude/scripts/coverage.sh', content: 'echo hi\n' },
    });
  });

  // Every rejection ends as a DENY rather than as a bare allow — see the
  // `#563 review` block below for the argument. What is pinned here is that the
  // rejections HAPPEN at all, one per check.
  it.each([
    ['an array', [1, 2, 3]],
    ['a string', 'answers'],
    ['null', null],
  ])('refuses an updatedInput that is %s', (_why, bad) => {
    perms.offer('s1', askUserQuestion());
    perms.decide(requests[0].requestId, 'allow', undefined, bad);

    expect(responseAt(0).behavior).toBe('deny');
  });

  it('refuses an updatedInput that will not serialise', () => {
    // A cycle must fail HERE, where the failure has an answer, and not inside
    // the writer's JSON.stringify, where it does not.
    const cyclic: Record<string, unknown> = { questions: [], answers: { q: 'a' } };
    cyclic.self = cyclic;
    perms.offer('s1', askUserQuestion());
    perms.decide(requests[0].requestId, 'allow', undefined, cyclic);

    expect(responseAt(0).behavior).toBe('deny');
  });

  it('refuses an updatedInput over the size cap', () => {
    perms.offer('s1', askUserQuestion());
    perms.decide(requests[0].requestId, 'allow', undefined, {
      answers: { q: 'x'.repeat(200_000) },
    });

    expect(responseAt(0).behavior).toBe('deny');
  });

  it('a denied question is a plain deny, and the CLI recovers from one', () => {
    // Probe mode `deny`: the tool_result comes back `is_error` and the model
    // asks the same thing in prose. Refusing is safe; not answering is not.
    perms.offer('s1', askUserQuestion());
    perms.decide(requests[0].requestId, 'deny', 'Not now');

    expect(responseAt(0)).toMatchObject({ behavior: 'deny', message: 'Not now' });
  });
});

describe('allow-all never answers a question (#563)', () => {
  // THE SHARPEST EDGE IN THE ITEM. A bare allow — which is all an allow-all
  // session could send — is read by the CLI as "The user did not answer the
  // questions." (probe mode `empty`). So auto-allowing here would not be a
  // generous default; it would silently discard every question the session ever
  // asked, from the one path that never pushes anything to a renderer.
  it('holds the question and asks the user, grant or no grant', () => {
    perms.setAllowAll('s1');

    perms.offer('s1', askUserQuestion());

    expect(requests).toHaveLength(1);
    expect(perms.pendingRequests()).toHaveLength(1);
    expect(sent).toEqual([]); // nothing answered at the server
  });

  it('still auto-allows the ordinary tools around it', () => {
    perms.setAllowAll('s1');

    perms.offer('s1', askUserQuestion('q1'));
    perms.offer('s1', canUseTool('w1'));

    expect(requests.map((r) => r.tool)).toEqual(['AskUserQuestion']);
    expect(sent).toHaveLength(1);
    expect(responseAt(0)).toMatchObject({ behavior: 'allow' });
  });
});

// ── review follow-ups (#563): the validator must not become the skip ─────────
describe('a rejected answer is denied, never silently allowed (#563 review)', () => {
  // THE HOLE THE VALIDATOR WOULD HAVE REOPENED. Falling back to the request's
  // own input is right for every other tool and is the measured "The user did
  // not answer the questions" for this one — so a user who clicked Send and
  // watched the panel close would be told nothing while the model was told they
  // declined to answer. Allow-all, the toast and the batch card were all closed
  // off for exactly this; failing open here would undo all three from inside.
  it.each([
    ['an array of answers', { questions: [], answers: { q: ['a', 'b'] } }],
    ['an empty answers map', { questions: [], answers: {} }],
    ['no answers key at all', { questions: [] }],
    ['a blank answer', { questions: [], answers: { q: '   ' } }],
    ['a non-object', 'answers'],
  ])('denies rather than allows when the answer is %s', (_why, bad) => {
    perms.offer('s1', askUserQuestion());
    perms.decide(requests[0].requestId, 'allow', undefined, bad);

    const r = responseAt(0);
    expect(r.behavior).toBe('deny');
    expect(String(r.message)).toContain('could not be delivered');
    // and never an allow that would read as "the user did not answer"
    expect(r.updatedInput).toBeUndefined();
  });

  // The distinction that makes the rule safe: NOT supplying an answer at all is
  // a different act from supplying one that could not be carried. The first is
  // the toast, or any surface that answers with three arguments; it keeps the
  // old behaviour.
  it('an allow with NO updatedInput at all is still a plain allow', () => {
    perms.offer('s1', askUserQuestion());
    perms.decide(requests[0].requestId, 'allow');

    expect(responseAt(0)).toMatchObject({ behavior: 'allow' });
  });

  it('an ordinary tool is unaffected — a bad updatedInput is just ignored', () => {
    perms.offer('s1', canUseTool());
    perms.decide(requests[0].requestId, 'allow', undefined, { file_path: 'C:/p/evil.sh' });

    expect(responseAt(0)).toMatchObject({
      behavior: 'allow',
      updatedInput: { file_path: 'C:/p/.claude/scripts/coverage.sh', content: 'echo hi\n' },
    });
  });

  it('accepts the measured shape', () => {
    perms.offer('s1', askUserQuestion());
    perms.decide(requests[0].requestId, 'allow', undefined, {
      questions: [],
      answers: { 'Which colour do you prefer?': 'Red, Blue' },
    });

    expect(responseAt(0)).toMatchObject({
      behavior: 'allow',
      updatedInput: { answers: { 'Which colour do you prefer?': 'Red, Blue' } },
    });
  });
});

describe('a question gets longer than five minutes to answer (#563 review)', () => {
  // The 300s deadline exists to stop a session wedging when nobody CAN answer,
  // and that case is handled by the liveness gate instead. What is left is a
  // person reading options and possibly typing a paragraph, and a deadline that
  // fires mid-sentence would delete the panel and tell the model nobody
  // answered in time.
  it('holds a question far longer than a permission', () => {
    vi.useFakeTimers();
    try {
      const p = new StreamPermissions(
        (sessionId, msg) => {
          sent.push({ sessionId, msg: msg as Record<string, unknown> });
          return true;
        },
        (sessionId, ev) => applied.push({ sessionId, ev }),
        createLogger(new LogSink({ dir }), 'perm')
      );
      p.offer('s1', canUseTool('w1'));
      p.offer('s1', askUserQuestion('q1'));

      vi.advanceTimersByTime(301_000);
      // the permission failed open; the question is still waiting for a person
      expect(p.pendingRequests().map((r) => r.tool)).toEqual(['AskUserQuestion']);

      vi.advanceTimersByTime(30 * 60_000);
      expect(p.pendingRequests()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('an explicit holdTimeoutMs still wins, so tests stay in control', () => {
    vi.useFakeTimers();
    try {
      const p = new StreamPermissions(
        () => true,
        () => {},
        createLogger(new LogSink({ dir }), 'perm'),
        { holdTimeoutMs: 1_000 }
      );
      p.offer('s1', askUserQuestion('q1'));

      vi.advanceTimersByTime(1_500);
      expect(p.pendingRequests()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
