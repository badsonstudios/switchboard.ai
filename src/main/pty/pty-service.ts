// PtyService (P1-E2-01): generic PTY lifecycle — spawn/resize/write/kill —
// with per-session scrollback ring buffers. Provider-specific spawn recipes
// come from adapters via the contribution registry; this service is dumb
// about what it hosts.
//
// Deliberately electron-free: loadable under any Node-ABI-compatible runtime
// (the lifecycle check runs it under `electron --run-as-node`).
import * as pty from 'node-pty';
import { RingBuffer } from './ring-buffer';

export interface PtySpawnOptions {
  id: string;
  command: string;
  args: string[];
  cwd: string;
  /** env DELTAS over the (scrubbed) base env; undefined value = delete key */
  env?: Record<string, string | undefined>;
  cols?: number;
  rows?: number;
  scrollbackBytes?: number;
}

export interface PtySessionInfo {
  id: string;
  pid: number;
  exitCode: number | null;
}

// S-01 landmines: these must never leak from our process into a hosted CLI.
const SCRUB_ALWAYS = ['ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ATTACH_CONSOLE'];

export function buildEnv(
  base: NodeJS.ProcessEnv,
  deltas?: Record<string, string | undefined>
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const k of SCRUB_ALWAYS) delete env[k];
  for (const [k, v] of Object.entries(deltas ?? {})) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env;
}

export class PtySession {
  readonly id: string;
  readonly scrollback: RingBuffer;
  private readonly proc: pty.IPty;
  private dataListeners = new Set<(d: string) => void>();
  private exitListeners = new Set<(code: number) => void>();
  exitCode: number | null = null;

  constructor(opts: PtySpawnOptions) {
    this.id = opts.id;
    this.scrollback = new RingBuffer(opts.scrollbackBytes ?? 2 * 1024 * 1024);
    this.proc = pty.spawn(opts.command, opts.args, {
      name: 'xterm-256color',
      cols: opts.cols ?? 120,
      rows: opts.rows ?? 30,
      cwd: opts.cwd,
      env: buildEnv(process.env, opts.env) as { [k: string]: string },
      useConpty: process.platform === 'win32',
    });
    this.proc.onData((d) => {
      this.scrollback.push(Buffer.from(d, 'utf8'));
      for (const l of this.dataListeners) l(d);
    });
    this.proc.onExit(({ exitCode }) => {
      this.exitCode = exitCode;
      for (const l of this.exitListeners) l(exitCode);
    });
  }

  get pid(): number {
    return this.proc.pid;
  }

  onData(listener: (d: string) => void): () => void {
    this.dataListeners.add(listener);
    return () => this.dataListeners.delete(listener);
  }

  onExit(listener: (code: number) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  write(data: string): void {
    if (this.exitCode !== null) return; // dead PTY: writes raise async socket errors (S-01)
    this.proc.write(data);
  }

  resize(cols: number, rows: number): void {
    if (this.exitCode !== null) return;
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols <= 0 || rows <= 0) return;
    this.proc.resize(cols, rows);
  }

  kill(): void {
    try {
      this.proc.kill();
    } catch {
      /* already dead */
    }
  }
}

export class PtyService {
  private readonly sessions = new Map<string, PtySession>();

  spawn(opts: PtySpawnOptions): PtySession {
    if (this.sessions.has(opts.id)) {
      throw new Error(`pty session "${opts.id}" already exists`);
    }
    const s = new PtySession(opts);
    this.sessions.set(opts.id, s);
    s.onExit(() => {
      /* keep the entry: exitCode is part of session state; SessionManager
         decides when to drop it */
    });
    return s;
  }

  get(id: string): PtySession | undefined {
    return this.sessions.get(id);
  }

  remove(id: string): void {
    const s = this.sessions.get(id);
    if (s && s.exitCode === null) s.kill();
    this.sessions.delete(id);
  }

  list(): PtySessionInfo[] {
    return [...this.sessions.values()].map((s) => ({ id: s.id, pid: s.pid, exitCode: s.exitCode }));
  }

  killAll(): void {
    for (const s of this.sessions.values()) s.kill();
  }
}
