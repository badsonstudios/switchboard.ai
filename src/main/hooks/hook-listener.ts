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
  /** session autonomy lookup for the hold policy (E10-03); absent = no holds */
  autonomyFor?: (sessionId: string) => string | undefined;
  /** session folder lookup — out-of-cwd reads are gated (E10 fix) */
  cwdFor?: (sessionId: string) => string | undefined;
  /** how long a held PreToolUse waits for a UI decision before failing OPEN
   *  to the CLI's own TUI prompt. Default 300s — human-scale (Dan hit the
   *  old 60s mid-testing); the CLI's own hook budget is ~600s (S-03). */
  holdTimeoutMs?: number;
}

/** An in-flight permission request parked on a held PreToolUse (E10-03). */
export interface PermissionRequest {
  requestId: string;
  sessionId: string;
  tool: string;
  input: Record<string, unknown>;
}

/**
 * Hold policy (P2-E10-03, §5.16): hold ONLY calls the CLI itself would prompt
 * for at this autonomy — otherwise we'd nag full-auto sessions the CLI would
 * have let through. Unknown autonomy fails open (no hold).
 */
// Shell tools are platform-dependent: the CLI uses a PowerShell tool on
// Windows (probe 2026-07-22 — "list my Downloads" ran tool_name:"PowerShell",
// which our Bash-only gate missed and the TUI prompted instead).
const SHELLISH = ['Bash', 'PowerShell'];
const MUTATING = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'WebFetch'];
const READ_TOOLS = ['Read', 'Glob', 'Grep', 'LS'];

const GATED: Record<string, string[]> = {
  ask: [...SHELLISH, ...MUTATING],
  plan: [...SHELLISH, ...MUTATING],
  'auto-edit': [...SHELLISH, 'WebFetch'],
  'full-auto': [],
};

/** PreToolUse matcher — REQUIRED for tool hooks (S-03's proven shape used
 *  one; without it the entry never fires and the CLI's own TUI prompt runs
 *  instead — Dan's 2026-07-21 find). Union of everything the policy might
 *  hold; the hold policy narrows per-session server-side. */
const PRETOOL_MATCHER = [...SHELLISH, ...MUTATING, ...READ_TOOLS].join('|');

/** The primary filesystem target of a read-tool call, if any. */
function readToolPath(input: Record<string, unknown> | undefined): string | undefined {
  const p = input?.file_path ?? input?.path ?? input?.notebook_path;
  return typeof p === 'string' ? p : undefined;
}

/** Is `p` outside the session's folder? (The CLI prompts for outside reads.) */
export function isOutsideCwd(p: string, cwd: string): boolean {
  const norm = (x: string) => {
    const r = path.resolve(x);
    return process.platform === 'win32' ? r.toLowerCase() : r;
  };
  const target = norm(p);
  const base = norm(cwd);
  return target !== base && !target.startsWith(base + path.sep);
}

export function shouldHoldPermission(
  autonomy: string | undefined,
  tool: string | undefined,
  input?: Record<string, unknown>,
  cwd?: string
): boolean {
  if (!autonomy || !tool) return false;
  if ((GATED[autonomy] ?? []).includes(tool)) return true;
  // read tools only prompt when they leave the workspace — mirror that:
  // hold an out-of-cwd read (full-auto never holds anything)
  if (autonomy !== 'full-auto' && READ_TOOLS.includes(tool) && cwd) {
    const target = readToolPath(input);
    if (target && isOutsideCwd(target, cwd)) return true;
  }
  return false;
}

export class HookListener {
  private server: http.Server | null = null;
  private port = 0;
  private readonly tokens = new Map<string, string>(); // token -> sessionId
  private forwarderPath: string | null = null;
  // held PreToolUse responses awaiting a UI decision (E10-03)
  private readonly pending = new Map<
    string,
    { res: http.ServerResponse; timer: NodeJS.Timeout; sessionId: string }
  >();
  private readonly permListeners = new Set<(r: PermissionRequest) => void>();
  private readonly resolvedListeners = new Set<(requestId: string) => void>();
  private reqCounter = 0;

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
    for (const id of [...this.pending.keys()]) this.release(id); // fail open
    this.server?.close();
    this.server?.closeAllConnections?.();
    this.server = null;
    this.tokens.clear();
  }

  /** Live permission requests (held PreToolUse calls) — E10-03/E10-04. */
  onPermissionRequest(cb: (r: PermissionRequest) => void): () => void {
    this.permListeners.add(cb);
    return () => this.permListeners.delete(cb);
  }

  /** A held request ended (decision OR timeout/teardown) — dismiss UI. */
  onPermissionResolved(cb: (requestId: string) => void): () => void {
    this.resolvedListeners.add(cb);
    return () => this.resolvedListeners.delete(cb);
  }

  private notifyResolved(requestId: string): void {
    for (const l of this.resolvedListeners) {
      try {
        l(requestId);
      } catch {
        /* listener's problem */
      }
    }
  }

  /** Answer a held request. Returns false if it already resolved/timed out. */
  decide(requestId: string, decision: 'allow' | 'deny', reason?: string): boolean {
    const p = this.pending.get(requestId);
    if (!p) return false;
    clearTimeout(p.timer);
    this.pending.delete(requestId);
    const out = {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: decision,
        permissionDecisionReason:
          reason ?? (decision === 'deny' ? 'Denied from switchboard' : 'Approved from switchboard'),
      },
    };
    try {
      p.res.end(JSON.stringify(out));
    } catch {
      /* connection gone — the CLI's own prompt takes over (fail-open) */
    }
    this.opts.manager.apply(p.sessionId, { kind: 'permission-resolved' });
    this.opts.log.info('permission decided', { requestId, decision, sessionId: p.sessionId });
    this.notifyResolved(requestId);
    return true;
  }

  /** Release a held request with no opinion — the CLI's own TUI prompt runs. */
  private release(requestId: string): void {
    const p = this.pending.get(requestId);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(requestId);
    try {
      p.res.end('{}');
    } catch {
      /* already gone */
    }
    this.notifyResolved(requestId);
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
    // a session closed mid-hold must not leave the CLI hanging (fail-open)
    for (const [id, p] of this.pending) if (p.sessionId === sessionId) this.release(id);
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
    // PreToolUse gets its own entry: the forwarder waits (4th arg) for a held
    // decision and prints the hook JSON verdict to stdout; the CLI-side
    // timeout is a beat above ours so OUR timeout (fail-open '{}') wins.
    const holdMs = this.opts.holdTimeoutMs ?? 300_000;
    hooks['PreToolUse'] = [
      {
        matcher: PRETOOL_MATCHER,
        hooks: [
          {
            type: 'command',
            timeout: Math.ceil(holdMs / 1000) + 10,
            command: `${command} ${holdMs + 5_000}`,
          },
        ],
      },
    ];
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
      // PreToolUse for a gated tool HOLDS (E10-03): the response is parked
      // until the UI decides; everything else acks instantly (S-06).
      const held = this.maybeHold(sessionId, body, res);
      if (!held) res.end('{}');
      this.ingest(sessionId, body);
      if (held) this.opts.manager.apply(sessionId, { kind: 'permission-held' });
    });
  }

  /** Park a gated PreToolUse response; returns true when held. */
  private maybeHold(sessionId: string, body: string, res: http.ServerResponse): boolean {
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(body) as Record<string, unknown>;
    } catch {
      return false;
    }
    if (e.hook_event_name !== 'PreToolUse') return false;
    if (this.permListeners.size === 0) return false; // nobody to ask — fail open
    const tool = typeof e.tool_name === 'string' ? e.tool_name : undefined;
    const input =
      e.tool_input && typeof e.tool_input === 'object'
        ? (e.tool_input as Record<string, unknown>)
        : undefined;
    if (
      !shouldHoldPermission(
        this.opts.autonomyFor?.(sessionId),
        tool,
        input,
        this.opts.cwdFor?.(sessionId)
      )
    )
      return false;

    const requestId = `perm-${++this.reqCounter}`;
    const timer = setTimeout(() => {
      // no decision in time: no opinion — the CLI's own TUI prompt takes over
      this.opts.log.warn('permission hold timed out — failing open to the TUI', {
        requestId,
        sessionId,
      });
      this.release(requestId);
    }, this.opts.holdTimeoutMs ?? 300_000);
    timer.unref?.();
    this.pending.set(requestId, { res, timer, sessionId });
    const request: PermissionRequest = {
      requestId,
      sessionId,
      tool: tool ?? '',
      input:
        e.tool_input && typeof e.tool_input === 'object'
          ? (e.tool_input as Record<string, unknown>)
          : {},
    };
    this.opts.log.info('permission held', { requestId, sessionId, tool });
    for (const l of this.permListeners) {
      try {
        l(request);
      } catch (err) {
        this.opts.log.error('permission listener threw', { error: String(err) });
      }
    }
    return true;
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
const waitMs = Number(process.argv[4]) || 3000; // held PreToolUse waits longer
const req = http.request(
  { host: '127.0.0.1', port: Number(port), path: '/hook', method: 'POST',
    headers: { 'content-type': 'application/json', 'x-switchboard-token': token },
    timeout: waitMs },
  (res) => {
    // the response body IS the hook verdict (held PreToolUse) — relay it to
    // stdout so the CLI applies the permissionDecision; '{}' is a no-op
    let out = '';
    res.on('data', (d) => (out += d));
    res.on('end', () => { if (out) process.stdout.write(out); process.exit(0); });
  }
);
req.on('timeout', () => { req.destroy(); process.exit(0); });
req.on('error', () => process.exit(0));
req.end(stdin);
`;
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(file, src);
  return file;
}
