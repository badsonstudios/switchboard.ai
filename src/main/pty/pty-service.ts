// PtyService (P1-E2-01): generic PTY lifecycle — spawn/resize/write/kill —
// with per-session scrollback ring buffers. Provider-specific spawn recipes
// come from adapters via the contribution registry; this service is dumb
// about what it hosts.
//
// Deliberately electron-free: loadable under any Node-ABI-compatible runtime
// (the lifecycle check runs it under `electron --run-as-node`).
import * as pty from 'node-pty';
import { RingBuffer } from './ring-buffer';
import { buildEnv } from '../transport/env';

// Re-exported, not redefined: the scrub moved to `transport/env.ts` in
// P2-E18-02 because every transport needs it, and this keeps the P1 import
// path working for callers (and tests) that predate the move.
export { buildEnv };

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

export class PtySession {
  readonly id: string;
  readonly scrollback: RingBuffer;
  private readonly proc: pty.IPty;
  /** the geometry we spawned at, as the fallback `cols`/`rows` below need */
  private readonly spawnCols: number;
  private readonly spawnRows: number;
  private dataListeners = new Set<(d: string) => void>();
  private exitListeners = new Set<(code: number) => void>();
  exitCode: number | null = null;

  constructor(opts: PtySpawnOptions) {
    this.id = opts.id;
    this.scrollback = new RingBuffer(opts.scrollbackBytes ?? 2 * 1024 * 1024);
    this.spawnCols = opts.cols ?? 120;
    this.spawnRows = opts.rows ?? 30;
    this.proc = pty.spawn(opts.command, opts.args, {
      name: 'xterm-256color',
      cols: this.spawnCols,
      rows: this.spawnRows,
      cwd: opts.cwd,
      env: buildEnv(process.env, opts.env) as { [k: string]: string },
      useConpty: process.platform === 'win32',
    });
    // listener exceptions are swallowed: a broken subscriber must never take
    // the PTY pump down (fail-open); callers own their error handling
    this.proc.onData((d) => {
      // INVARIANT (#205): every chunk pushed here is WHOLE characters. node-pty
      // decodes to a string for us (its `encoding` defaults to utf8), and we
      // re-encode that string, so no chunk begins or ends mid-character —
      // which is what lets RingBuffer drop whole chunks without splitting one,
      // and lets `pty:attach` decode the snapshot with a bare `toString`.
      // Feeding this raw socket bytes instead would reintroduce #205.
      this.scrollback.push(Buffer.from(d, 'utf8'));
      for (const l of this.dataListeners) {
        try {
          l(d);
        } catch {
          /* subscriber's problem, not the pump's */
        }
      }
    });
    this.proc.onExit(({ exitCode }) => {
      this.exitCode = exitCode;
      for (const l of this.exitListeners) {
        try {
          l(exitCode);
        } catch {
          /* subscriber's problem, not the pump's */
        }
      }
    });
  }

  get pid(): number {
    return this.proc.pid;
  }

  /**
   * The PTY's CURRENT geometry — what the CLI is writing for right now (#517).
   *
   * Read off node-pty rather than mirrored here, because node-pty is where the
   * value is settled. Checked against the shipped source rather than assumed
   * (`node_modules/node-pty/lib/{unix,windows}Terminal.js`, 2026-08-19):
   * both backends assign `_cols` in their constructor and reassign it only in
   * `resize`, AFTER the resize has been handed down — and on Windows that
   * assignment is deferred (`_deferNoArgs`), so `cols` can lag a resize by a
   * tick there. Never cleared on exit, so a dead PTY still reports the width it
   * died at, which is the width its scrollback was written for.
   *
   * The spawn-value fallback is therefore DEFENSIVE, not a case we have found:
   * nothing in either backend produces a non-positive `cols` after
   * construction. It costs a comparison and it means the only reader — a
   * scrollback replay — can never be handed `NaN`, where a stale-but-real width
   * costs wrapping and `NaN` costs the whole answer.
   */
  get cols(): number {
    const c = this.proc.cols;
    return Number.isInteger(c) && c > 0 ? c : this.spawnCols;
  }

  get rows(): number {
    const r = this.proc.rows;
    return Number.isInteger(r) && r > 0 ? r : this.spawnRows;
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
