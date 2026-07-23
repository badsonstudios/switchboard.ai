import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { HookListener, PermissionRequest, isOutsideCwd, shouldHoldPermission } from './hook-listener';
import { LogSink, createLogger } from '../log/logger';
import { SessionEvent } from '../sessions/state-machine';

let dir: string;
let listener: HookListener;
let applied: Array<{ sessionId: string; ev: SessionEvent }>;
let nativeIds: Array<{ sessionId: string; nativeId: string }>;
let port: number;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-hooks-'));
  applied = [];
  nativeIds = [];
  listener = new HookListener({
    stateDir: dir,
    log: createLogger(new LogSink({ dir }), 'hooks'),
    manager: {
      apply: (sessionId, ev) => applied.push({ sessionId, ev }),
      setNativeSessionId: (sessionId, nativeId) => nativeIds.push({ sessionId, nativeId }),
    },
  });
  port = await listener.start();
});

afterEach(() => listener.stop());

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
      stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'sb-hold-')),
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
});

describe('shouldHoldPermission policy', () => {
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
