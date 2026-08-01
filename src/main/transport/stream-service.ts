// StreamService (P2-E18-03): the stream-json transport — `child_process.spawn`
// over pipes, NDJSON both ways, sibling to PtyService.
//
// Deliberately electron-free and logger-free, exactly like PtyService: loadable
// under any Node-ABI-compatible runtime so `lifecycle-check` can drive it.
// Diagnostics leave through an optional callback rather than an imported
// Logger, so the wiring decides where they go.
//
// Not wired into the app by this item. It is driven by unit tests and the
// lifecycle check; P2-E18-05 gives it a session.
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { buildEnv } from './env';
import { MessageRing } from './message-ring';
import { NdjsonDecoder, encodeFrame } from './ndjson';
import { SessionTransport, TransportSpawnOptions } from './transport';

/** Anything the CLI writes on stdout. Typed properly in P2-E18-05. */
export type StreamMessage = Record<string, unknown>;

export interface StreamSpawnOptions extends TransportSpawnOptions {
  /** How many parsed messages to retain (default 2000). */
  ringCapacity?: number;
  /** Non-fatal problems: parse failures, overlong lines, stderr output. */
  onDiagnostic?: (d: StreamDiagnostic) => void;
}

export interface StreamDiagnostic {
  sessionId: string;
  kind: 'parse-failure' | 'overlong-line' | 'stderr' | 'stdin-write-failed';
  detail: string;
}

/**
 * On Windows the provider adapter hands us `claude.cmd`, which node-pty runs
 * directly and `child_process.spawn` does not: a `.cmd` is a shell script, not
 * an executable image.
 *
 * We wrap it in `cmd.exe /c` explicitly — the same thing the S-10 probes did,
 * and the reason S-11 measured THREE processes per session (cmd.exe →
 * claude.cmd → node). We do NOT pass `shell: true`, which would achieve the
 * same launch while handing command-injection a foothold: `cwd`, `args` and the
 * resolved CLI path are all influenced by user configuration, and `shell: true`
 * re-parses them through a command interpreter. This is a transport concern,
 * not an adapter one — adapters name the program, transports know how to launch
 * it, and leaking cmd.exe into every adapter is how that stops being true.
 */
export function launchSpec(
  command: string,
  args: string[],
  // Explicit rather than read from `process.platform` inside, so BOTH branches
  // are exercised on every CI leg. Read from the ambient platform and the
  // Windows case would pass vacuously on the ubuntu and macOS runners — the
  // #127 failure exactly: a green half-suite proving nothing on the two
  // platforms that cannot reach the branch.
  platform: NodeJS.Platform = process.platform
): { file: string; argv: string[] } {
  const isWindowsShellScript = platform === 'win32' && /\.(cmd|bat)$/i.test(command);
  return isWindowsShellScript
    ? { file: 'cmd.exe', argv: ['/c', command, ...args] }
    : { file: command, argv: args };
}

export class StreamSession {
  readonly id: string;
  readonly messages: MessageRing<StreamMessage>;
  private readonly proc: ChildProcessWithoutNullStreams;
  private readonly decoder = new NdjsonDecoder<StreamMessage>();
  private readonly onDiagnostic?: (d: StreamDiagnostic) => void;
  private messageListeners = new Set<(m: StreamMessage) => void>();
  private exitListeners = new Set<(code: number) => void>();
  exitCode: number | null = null;
  /** Last few KB of stderr, for a crash report nobody can otherwise explain. */
  private stderrTail = '';

  constructor(opts: StreamSpawnOptions) {
    this.id = opts.id;
    this.messages = new MessageRing<StreamMessage>(opts.ringCapacity ?? 2000);
    this.onDiagnostic = opts.onDiagnostic;

    const { file, argv } = launchSpec(opts.command, opts.args);
    this.proc = spawn(file, argv, {
      cwd: opts.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: buildEnv(process.env, opts.env) as NodeJS.ProcessEnv,
      // NEVER omit. S-11's first run set this on one spawn and missed it on
      // another, and flashed a console window on the user's desktop 96 times
      // over eight hours. Every spawn on Windows needs it.
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams;

    // setEncoding, NOT `chunk.toString('utf8')` per chunk. The S-10 probes do
    // the latter and it is subtly wrong: a multi-byte character straddling a
    // chunk boundary decodes to two replacement characters, corrupting the JSON
    // line and costing a whole message. setEncoding puts a StringDecoder on the
    // stream, which holds the partial sequence — the same job the NDJSON
    // decoder does one level up, for the same reason. Any non-ASCII output (a
    // path, an emoji, a diff of a UTF-8 file) can hit this.
    this.proc.stdout.setEncoding('utf8');
    // NOTE: there is no pause() anywhere in this class, and that is deliberate.
    // S-11 stopped draining for 150 s and watched 359 KB pile up behind us and
    // arrive intact — the CLI blocks on a full pipe and recovers, it does not
    // wedge or corrupt framing. So falling behind is survivable, but choosing
    // to stop reading applies real backpressure to the CLI mid-turn. We consume
    // unconditionally and let the ring do the bounding.
    this.proc.stdout.on('data', (chunk: string) => this.ingest(chunk));

    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-8192);
      this.onDiagnostic?.({ sessionId: this.id, kind: 'stderr', detail: chunk.trim().slice(0, 500) });
    });

    // stdin errors arrive asynchronously once the child is gone (the S-01
    // lesson PtyService records for PTY writes). An unhandled 'error' on a
    // stream is a process-level crash, so it is absorbed here.
    this.proc.stdin.on('error', (err) => {
      this.onDiagnostic?.({ sessionId: this.id, kind: 'stdin-write-failed', detail: String(err) });
    });

    const settle = (code: number): void => {
      // 'error' can arrive INSTEAD of 'exit' (spawn failed, ENOENT) or AFTER it;
      // whichever lands first wins and the other is ignored.
      if (this.exitCode !== null) return;
      this.exitCode = code;
      for (const l of this.exitListeners) {
        try {
          l(code);
        } catch {
          /* subscriber's problem, not the pump's */
        }
      }
    };
    this.proc.on('exit', (code, signal) => settle(code ?? (signal ? 1 : 0)));
    this.proc.on('error', () => settle(1)); // spawn failed (ENOENT etc.)
  }

  private ingest(chunk: string): void {
    for (const r of this.decoder.push(chunk)) {
      if (!r.ok) {
        const kind = r.raw === '' ? 'overlong-line' : 'parse-failure';
        this.onDiagnostic?.({ sessionId: this.id, kind, detail: r.error });
        continue; // one bad message costs one message
      }
      this.messages.push(r.value);
      for (const l of this.messageListeners) {
        try {
          l(r.value);
        } catch {
          /* a broken subscriber must never take the pump down (P6) */
        }
      }
    }
  }

  get pid(): number {
    return this.proc.pid ?? -1;
  }

  /** Framing-integrity counters — the thing to look at when output goes weird. */
  get health(): { parseFailures: number; overlongLines: number; pendingBytes: number } {
    return {
      parseFailures: this.decoder.parseFailures,
      overlongLines: this.decoder.overlongLines,
      pendingBytes: this.decoder.pendingBytes,
    };
  }

  get stderrSnapshot(): string {
    return this.stderrTail;
  }

  onMessage(l: (m: StreamMessage) => void): () => void {
    this.messageListeners.add(l);
    return () => this.messageListeners.delete(l);
  }

  onExit(l: (code: number) => void): () => void {
    this.exitListeners.add(l);
    return () => this.exitListeners.delete(l);
  }

  /** Send one message. No-op on a dead child rather than a throw. */
  send(msg: unknown): void {
    if (this.exitCode !== null) return;
    try {
      this.proc.stdin.write(encodeFrame(msg));
    } catch (err) {
      this.onDiagnostic?.({ sessionId: this.id, kind: 'stdin-write-failed', detail: String(err) });
    }
  }

  kill(): void {
    try {
      this.proc.kill();
    } catch {
      /* already dead */
    }
  }
}

export class StreamService implements SessionTransport {
  private readonly sessions = new Map<string, StreamSession>();

  spawn(opts: StreamSpawnOptions): StreamSession {
    if (this.sessions.has(opts.id)) {
      throw new Error(`stream session "${opts.id}" already exists`);
    }
    const s = new StreamSession(opts);
    this.sessions.set(opts.id, s);
    return s;
  }

  get(id: string): StreamSession | undefined {
    return this.sessions.get(id);
  }

  remove(id: string): void {
    const s = this.sessions.get(id);
    if (s && s.exitCode === null) s.kill();
    this.sessions.delete(id);
  }

  list(): Array<{ id: string; pid: number; exitCode: number | null }> {
    return [...this.sessions.values()].map((s) => ({
      id: s.id,
      pid: s.pid,
      exitCode: s.exitCode,
    }));
  }

  killAll(): void {
    for (const s of this.sessions.values()) s.kill();
  }
}
