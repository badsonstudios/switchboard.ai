// P2-E18-07 — can_use_tool -> the approval bar.
//
// The `.claude/` write that prompts the owner TWICE today is the acceptance
// case, and it appears here twice over: once as the routing test, and once end
// to end through the #134 fake, where the FILE actually gets written.
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { StreamPermissions } from './stream-permissions';
import { PermissionRequest } from '../hooks/hook-listener';
import { FakeStreamProtocol } from '../providers/fake-stream-protocol';
import { LogSink, createLogger } from '../log/logger';

let dir: string;
let sent: Array<{ sessionId: string; msg: Record<string, unknown> }>;
let requests: PermissionRequest[];
let resolved: string[];
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-perm-'));
  sent = [];
  requests = [];
  resolved = [];
  perms = new StreamPermissions(
    (sessionId, msg) => {
      sent.push({ sessionId, msg: msg as Record<string, unknown> });
      return true;
    },
    createLogger(new LogSink({ dir }), 'perm')
  );
  perms.onPermissionRequest((r) => requests.push(r));
  perms.onPermissionResolved((id) => resolved.push(id));
});

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
