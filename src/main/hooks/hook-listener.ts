// HookListener (P1-E2-05, §5.29 floor): loopback-only HTTP server receiving
// Claude Code hook events and feeding the SessionManager state machine.
// Spike verdicts implemented:
//   §5.29: loopback bind + Host allowlist + per-session token, both always.
//   S-03:  token NOT on argv — it lives in an ACL'd file referenced by path;
//          fail-open forwarder (dead listener costs nothing).
//   S-06:  status hooks ack instantly and carry "timeout": 10 so a wedged
//          listener costs at most 10s once; Stop is the done authority.
import http from 'http';
import { randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';

function findNodeOnPath(): string | null {
  const names = process.platform === 'win32' ? ['node.exe'] : ['node'];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    for (const name of names) {
      const full = path.join(dir, name);
      try {
        if (fs.statSync(full).isFile()) return full;
      } catch {
        /* keep scanning */
      }
    }
  }
  return null;
}
import { Logger } from '../log/logger';
import { SessionManager } from '../sessions/session-manager';

/** Hook events the listener subscribes to for status (S-06 set + PostToolUse). */
const STATUS_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PostToolUse',
  'Notification',
  'SubagentStop',
  'Stop',
] as const;

export interface HookListenerOptions {
  stateDir: string;
  manager: Pick<SessionManager, 'apply' | 'setNativeSessionId'>;
  log: Logger;
}

export class HookListener {
  private server: http.Server | null = null;
  private port = 0;
  private readonly tokens = new Map<string, string>(); // token -> sessionId
  private forwarderPath: string | null = null;

  constructor(private readonly opts: HookListenerOptions) {}

  private nodeCommand: string | null = null;

  async start(): Promise<number> {
    this.forwarderPath = writeForwarder(this.opts.stateDir);
    // The forwarder needs a Node runtime. `node` on PATH is NOT guaranteed
    // (claude.exe native installs bundle their own); fall back to our own
    // Electron binary in run-as-node mode. Hooks run under a POSIX shell on
    // Windows (S-02 finding), so an env-prefix works.
    const nodeOnPath = findNodeOnPath();
    this.nodeCommand = nodeOnPath
      ? `"${nodeOnPath}"`
      : `ELECTRON_RUN_AS_NODE=1 "${process.execPath}"`;
    if (!nodeOnPath) {
      this.opts.log.warn('node not on PATH — hook forwarder will use the app binary in run-as-node mode');
    }
    this.server = http.createServer((req, res) => this.handle(req, res));
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = this.server.address();
    this.port = typeof addr === 'object' && addr ? addr.port : 0;
    this.opts.log.info('hook listener up', { port: this.port });
    return this.port;
  }

  stop(): void {
    this.server?.close();
    this.server?.closeAllConnections?.();
    this.server = null;
    this.tokens.clear();
  }

  /**
   * Issue a per-session token, stored in a file referenced by path — never on
   * argv (S-03). mode 0600 is a no-op on Windows; the real protection there
   * is stateDir living under the user profile (same-user ACL).
   */
  registerSession(sessionId: string): { tokenPath: string } {
    const token = randomBytes(16).toString('hex');
    this.tokens.set(token, sessionId);
    const dir = path.join(this.opts.stateDir, sessionId);
    fs.mkdirSync(dir, { recursive: true });
    const tokenPath = path.join(dir, 'hook-token');
    fs.writeFileSync(tokenPath, token, { mode: 0o600 });
    return { tokenPath };
  }

  unregisterSession(sessionId: string): void {
    for (const [tok, sid] of this.tokens) {
      if (sid === sessionId) this.tokens.delete(tok);
    }
  }

  /**
   * Hook config to inject via --settings for one session (S-02 mechanism).
   * POSIX-sh-free: command is `node <forwarder> <port> <tokenPath>` — node is
   * guaranteed present (the CLI itself runs on it), paths are absolute.
   */
  buildHookSettings(sessionId: string): Record<string, unknown> {
    if (!this.forwarderPath || this.port === 0 || !this.nodeCommand) {
      throw new Error('hook listener not started');
    }
    const { tokenPath } = this.registerSession(sessionId);
    const command = `${this.nodeCommand} "${this.forwarderPath}" ${this.port} "${tokenPath}"`;
    const entry = { hooks: [{ type: 'command', timeout: 10, command }] };
    const hooks: Record<string, unknown> = {};
    for (const ev of STATUS_EVENTS) hooks[ev] = [entry];
    return { hooks };
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.method !== 'POST') {
      res.writeHead(405);
      return void res.end();
    }
    const host = (req.headers.host ?? '').split(':')[0];
    if (host !== '127.0.0.1' && host !== 'localhost') {
      this.opts.log.warn('hook request rejected: bad host', { host: req.headers.host });
      res.writeHead(403);
      return void res.end();
    }
    const token = req.headers['x-switchboard-token'];
    const sessionId = typeof token === 'string' ? this.tokens.get(token) : undefined;
    if (!sessionId) {
      this.opts.log.warn('hook request rejected: invalid token');
      res.writeHead(401);
      return void res.end();
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}'); // ack first — status hooks must never hold the CLI (S-06)
      this.ingest(sessionId, body);
    });
  }

  private ingest(sessionId: string, body: string): void {
    let e: Record<string, unknown> = {};
    try {
      e = JSON.parse(body) as Record<string, unknown>;
    } catch {
      this.opts.log.warn('hook event unparseable', { sessionId });
      return;
    }
    const event = typeof e.hook_event_name === 'string' ? e.hook_event_name : 'unknown';
    const nativeId = typeof e.session_id === 'string' ? e.session_id : undefined;
    if (nativeId) this.opts.manager.setNativeSessionId(sessionId, nativeId);
    this.opts.log.debug('hook event', { sessionId, event });
    this.opts.manager.apply(sessionId, {
      kind: 'hook',
      event,
      notificationType: typeof e.notification_type === 'string' ? e.notification_type : undefined,
      message: typeof e.message === 'string' ? e.message : undefined,
      tool: typeof e.tool_name === 'string' ? e.tool_name : undefined,
    });
  }
}

/**
 * The forwarder the hook command runs: read stdin, POST to the listener with
 * the token read from tokenPath, exit 0 no matter what (fail-open — our
 * breakage never blocks a session). Generated into stateDir so the path is
 * real at runtime regardless of packaging (asar).
 */
function writeForwarder(stateDir: string): string {
  const file = path.join(stateDir, 'hook-forwarder.cjs');
  const src = `// generated by switchboard (P1-E2-05) — do not edit
const fs = require('fs');
const http = require('http');
const [, , port, tokenPath] = process.argv;
let stdin = '';
try { stdin = fs.readFileSync(0, 'utf8'); } catch {}
let token = '';
try { token = fs.readFileSync(tokenPath, 'utf8').trim(); } catch {}
const req = http.request(
  { host: '127.0.0.1', port: Number(port), path: '/hook', method: 'POST',
    headers: { 'content-type': 'application/json', 'x-switchboard-token': token },
    timeout: 3000 },
  (res) => { res.resume(); res.on('end', () => process.exit(0)); }
);
req.on('timeout', () => { req.destroy(); process.exit(0); });
req.on('error', () => process.exit(0));
req.end(stdin);
`;
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(file, src);
  return file;
}
