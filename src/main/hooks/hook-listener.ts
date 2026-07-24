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
import { SHELLISH, MUTATING, READ_TOOLS } from '../../shared/tool-taxonomy';

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
// Tool-name taxonomy (SHELLISH/MUTATING/READ_TOOLS) is imported from
// src/shared/tool-taxonomy.ts — shared with the renderer's block presentation
// so shell/edit classification can't drift between the hold policy and the
// Feed (review P1 #9).

const GATED: Record<string, string[]> = {
  ask: [...SHELLISH, ...MUTATING],
  // plan NEVER holds (owner decision 2026-07-23, review P0#1): an in-app
  // "Allow" returns permissionDecision:'allow', which BYPASSES the CLI's
  // permission system — including plan mode's write-block. Plan sessions
  // let the CLI's own plan enforcement run untouched.
  plan: [],
  'auto-edit': [...SHELLISH, 'WebFetch'],
  'full-auto': [],
};

/** Autonomies whose out-of-cwd reads we hold (plan/full-auto excluded — see GATED). */
const READ_GATED_AUTONOMIES = ['ask', 'auto-edit'];

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

/** Is `p` outside the session's folder? (The CLI prompts for outside reads.)
 *  Relative tool paths resolve against the SESSION folder (not the app's own
 *  cwd), and containment is judged via path.relative — string-prefixing broke
 *  on drive-root folders, where resolve() keeps the trailing separator and
 *  `base + sep` matches nothing (review P1 #10, reproduced). */
export function isOutsideCwd(p: string, cwd: string): boolean {
  const fold = (x: string) => (process.platform === 'win32' ? x.toLowerCase() : x);
  const base = fold(path.resolve(cwd));
  const target = fold(path.resolve(cwd, p));
  const rel = path.relative(base, target);
  return rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
}

export function shouldHoldPermission(
  autonomy: string | undefined,
  tool: string | undefined,
  input?: Record<string, unknown>,
  cwd?: string
): boolean {
  if (!autonomy || !tool) return false;
  if ((GATED[autonomy] ?? []).includes(tool)) return true;
  // read tools only prompt when they leave the workspace — mirror that
  if (READ_GATED_AUTONOMIES.includes(autonomy) && READ_TOOLS.includes(tool) && cwd) {
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
  // held PreToolUse responses awaiting a UI decision (E10-03). The request
  // rides along so a reloading/racing renderer can REPLAY what's pending
  // (review P0#3 — a missed push must not park the CLI for the full hold).
  private readonly pending = new Map<
    string,
    { res: http.ServerResponse; timer: NodeJS.Timeout; sessionId: string; request: PermissionRequest }
  >();
  private readonly permListeners = new Set<(r: PermissionRequest) => void>();
  private readonly resolvedListeners = new Set<(requestId: string) => void>();
  // LIVE sessions where the user chose "Allow all (this session)". Checked
  // BEFORE parking (review P2 #19 / Dan round 4): an allow-all session must
  // not hold, beep, or round-trip the renderer for every gated call — the
  // verdict is answered right here. Keyed by live id so a respawn prompts
  // again (P0 #2 semantics); cleared on unregister.
  private readonly allowAllSessions = new Set<string>();
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

  /** Everything currently held — for renderer (re)subscribe replay (P0#3). */
  pendingRequests(): PermissionRequest[] {
    return [...this.pending.values()].map((p) => ({ ...p.request }));
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

  /** Mark a LIVE session as allow-all: gated calls answer 'allow' at the
   *  server, with no hold, no needs-permission event, and no beep. */
  setAllowAll(sessionId: string): void {
    this.allowAllSessions.add(sessionId);
    this.opts.log.info('allow-all enabled for session', { sessionId });
  }

  private verdict(decision: 'allow' | 'deny', reason?: string): string {
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: decision,
        permissionDecisionReason:
          reason ?? (decision === 'deny' ? 'Denied from switchboard' : 'Approved from switchboard'),
      },
    });
  }

  /** Answer a held request. Returns false if it already resolved/timed out. */
  decide(requestId: string, decision: 'allow' | 'deny', reason?: string): boolean {
    const p = this.pending.get(requestId);
    if (!p) return false;
    clearTimeout(p.timer);
    this.pending.delete(requestId);
    try {
      p.res.end(this.verdict(decision, reason));
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
    this.allowAllSessions.delete(sessionId); // "this session" ends here
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
      // until the UI decides; allow-all sessions are ANSWERED at the server
      // (no hold, no event, no beep — P2 #19); everything else acks
      // instantly (S-06).
      const r = this.maybeHold(sessionId, body, res);
      if (r === 'pass') res.end('{}');
      this.ingest(sessionId, body);
      if (r === 'held') this.opts.manager.apply(sessionId, { kind: 'permission-held' });
    });
  }

  /** Park a gated PreToolUse response ('held'), answer it server-side for an
   *  allow-all session ('answered'), or leave it alone ('pass'). */
  private maybeHold(
    sessionId: string,
    body: string,
    res: http.ServerResponse
  ): 'held' | 'answered' | 'pass' {
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(body) as Record<string, unknown>;
    } catch {
      return 'pass';
    }
    if (e.hook_event_name !== 'PreToolUse') return 'pass';
    if (this.permListeners.size === 0) return 'pass'; // nobody to ask — fail open
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
      return 'pass';
    if (this.allowAllSessions.has(sessionId)) {
      try {
        res.end(this.verdict('allow', 'Allow-all (this session) from switchboard'));
      } catch {
        /* connection gone — CLI falls back to its own prompt */
      }
      this.opts.log.debug('gated call auto-allowed (allow-all session)', { sessionId, tool });
      return 'answered';
    }

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
    const request: PermissionRequest = {
      requestId,
      sessionId,
      tool: tool ?? '',
      input:
        e.tool_input && typeof e.tool_input === 'object'
          ? (e.tool_input as Record<string, unknown>)
          : {},
    };
    this.pending.set(requestId, { res, timer, sessionId, request });
    this.opts.log.info('permission held', { requestId, sessionId, tool });
    for (const l of this.permListeners) {
      try {
        l(request);
      } catch (err) {
        this.opts.log.error('permission listener threw', { error: String(err) });
      }
    }
    return 'held';
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
      // SessionStart carries source ('compact' fires mid-turn, review P1 #11)
      source: typeof e.source === 'string' ? e.source : undefined,
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
