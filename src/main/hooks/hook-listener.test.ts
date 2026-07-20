import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { HookListener } from './hook-listener';
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
});
