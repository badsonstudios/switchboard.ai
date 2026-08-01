// P2-E18-07 — a STREAM session's PreToolUse is never held.
//
// Hooks are independent of the transport, so a stream session can still fire
// PreToolUse. If we held it, the user would be asked the same question TWICE —
// once from the hook, once from `can_use_tool` — which is a worse version of
// the very double-prompt this epic exists to fix. The control-channel request
// is the one that carries the reason and that the `.claude/` guard actually
// honours, so it wins and the hook passes.
//
// UNMEASURED, stated plainly: nobody has confirmed whether the real CLI fires
// PreToolUse at all under `--permission-prompt-tool stdio` — S-10 never ran
// hooks and stream together. This guard is correct either way (if hooks are
// silent it costs nothing), but it is a GUARD, not a finding.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { HookListener, PermissionRequest } from './hook-listener';
import { LogSink, createLogger } from '../log/logger';

let dir: string;
let listener: HookListener;
let port: number;
let held: PermissionRequest[];
let transport: 'pty' | 'stream';

const CWD = process.platform === 'win32' ? 'C:/proj' : '/proj';
const TARGET = process.platform === 'win32' ? 'C:/proj/src/x.ts' : '/proj/src/x.ts';

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-shg-'));
  held = [];
  transport = 'pty';
  listener = new HookListener({
    stateDir: dir,
    log: createLogger(new LogSink({ dir }), 'hooks'),
    manager: { apply: () => {}, setNativeSessionId: () => {} },
    autonomyFor: () => 'ask',
    cwdFor: () => CWD,
    transportFor: () => transport,
    holdTimeoutMs: 400,
  });
  listener.onPermissionRequest((r) => held.push(r));
  port = await listener.start();
});

afterEach(() => listener.stop());

/** Register a session and POST it a PreToolUse for a normally-gated write. */
async function preToolUse(sessionId: string): Promise<string> {
  const cfg = listener.buildHookSettings(sessionId);
  const tokenFile = findTokenFile(cfg);
  const token = fs.readFileSync(tokenFile, 'utf8').trim();
  const body = JSON.stringify({
    hook_event_name: 'PreToolUse',
    session_id: 'native-1',
    tool_name: 'Write',
    tool_input: { file_path: TARGET, content: 'x' },
  });
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/hook',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          'x-switchboard-session': sessionId,
          'x-switchboard-token': token,
          host: `127.0.0.1:${port}`,
        },
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

/** The per-session token file the hook capability writes. */
function findTokenFile(cfg: Record<string, unknown>): string {
  const found = JSON.stringify(cfg).match(/[A-Za-z]:[\\/][^"]*hook-token[^"]*|\/[^"]*hook-token[^"]*/);
  if (found) return found[0].replace(/\\\\/g, '\\');
  // fall back to scanning the state dir
  const hit = fs
    .readdirSync(dir, { recursive: true } as { recursive: true })
    .map(String)
    .find((f) => f.includes('hook-token'));
  if (!hit) throw new Error('no token file written');
  return path.join(dir, hit);
}

describe('a stream session is never held on a hook (P2-E18-07)', () => {
  it('a PTY session with the same call IS held — the control case', async () => {
    transport = 'pty';
    const body = await preToolUse('s-pty');

    expect(held).toHaveLength(1);
    expect(held[0].tool).toBe('Write');
    // and the response carried a decision, so the CLI waited on us
    expect(body.length).toBeGreaterThan(0);
  });

  it('the identical call on a STREAM session passes straight through', async () => {
    transport = 'stream';
    await preToolUse('s-stream');

    expect(held).toEqual([]);
    expect(listener.pendingRequests()).toEqual([]);
  });

  // Absent = PTY, so every pre-E18 caller (hook-check, the existing tests, the
  // app before this epic) behaves exactly as before.
  it('an absent transportFor behaves as PTY', async () => {
    const other = new HookListener({
      stateDir: dir,
      log: createLogger(new LogSink({ dir }), 'hooks'),
      manager: { apply: () => {}, setNativeSessionId: () => {} },
      autonomyFor: () => 'ask',
      cwdFor: () => CWD,
      holdTimeoutMs: 400,
    });
    const seen: PermissionRequest[] = [];
    other.onPermissionRequest((r) => seen.push(r));
    const p = await other.start();
    try {
      const cfg = other.buildHookSettings('s-legacy');
      const tokenFile = findTokenFile(cfg);
      const token = fs.readFileSync(tokenFile, 'utf8').trim();
      const body = JSON.stringify({
        hook_event_name: 'PreToolUse',
        session_id: 'native-1',
        tool_name: 'Write',
        tool_input: { file_path: TARGET, content: 'x' },
      });
      await new Promise<void>((resolve, reject) => {
        const req = http.request(
          {
            host: '127.0.0.1',
            port: p,
            path: '/hook',
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'content-length': Buffer.byteLength(body),
              'x-switchboard-session': 's-legacy',
              'x-switchboard-token': token,
              host: `127.0.0.1:${p}`,
            },
          },
          (res) => {
            res.resume();
            res.on('end', () => resolve());
          }
        );
        req.on('error', reject);
        req.end(body);
      });
      expect(seen).toHaveLength(1);
    } finally {
      other.stop();
    }
  }, 15_000);
});
