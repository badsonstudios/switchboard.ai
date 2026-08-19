// StreamService (P2-E18-03): the stream-json transport — `child_process.spawn`
// over pipes, NDJSON both ways, sibling to PtyService.
//
// Deliberately electron-free and logger-free, exactly like PtyService: loadable
// under any Node-ABI-compatible runtime so `lifecycle-check` can drive it.
// Diagnostics leave through an optional callback rather than an imported
// Logger, so the wiring decides where they go. Where they go is
// `transport/diagnostics.ts` (the main log) - see that file for the #449
// ruling and why it is not the Events panel.
//
// Wired into the app since P2-E18-08a (`main/index.ts` constructs it beside
// PtyService); it is also driven directly by unit tests and `fake-stream-check`.
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
  /**
   * Non-fatal problems: parse failures, overlong lines, stderr output.
   *
   * Rarely set per spawn in the app: `SessionManager` reaches this class
   * through `SessionTransport.spawn`, whose options are the transport-agnostic
   * `TransportSpawnOptions` and cannot carry a stream-only field. The app wires
   * `StreamServiceOptions.onDiagnostic` on the SERVICE instead, and this is the
   * per-session override the tests and `fake-stream-check` use.
   */
  onDiagnostic?: (d: StreamDiagnostic) => void;
}

export interface StreamDiagnostic {
  sessionId: string;
  /**
   * `exit` is the end-of-life summary (#593) and is emitted at most once per
   * session, only when there was something to summarise — see
   * `StreamSession.summarize`.
   */
  kind: 'parse-failure' | 'overlong-line' | 'stderr' | 'stdin-write-failed' | 'exit';
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
      this.diag('stderr', chunk.trim().slice(0, 500));
    });

    // stdin errors arrive asynchronously once the child is gone (the S-01
    // lesson PtyService records for PTY writes). An unhandled 'error' on a
    // stream is a process-level crash, so it is absorbed here.
    this.proc.stdin.on('error', (err) => {
      this.diag('stdin-write-failed', String(err));
    });

    const settle = (code: number): void => {
      // 'error' can arrive INSTEAD of 'exit' (spawn failed, ENOENT) or AFTER it;
      // whichever lands first wins and the other is ignored.
      if (this.exitCode !== null) return;
      this.exitCode = code;
      // Before the fan-out: a listener is free to tear the session down, and
      // the last thing this session ever noticed should not depend on what a
      // subscriber does with the news.
      this.summarize(code);
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

  /**
   * Emit one diagnostic, absorbing anything the subscriber throws.
   *
   * The same P6 guarantee the message and exit fan-outs already give, and it
   * stopped being theoretical the day #449 gave this callback a real consumer:
   * three of the four emit sites are inside `stream.on('data'|'error')`
   * handlers, where an escaping exception is not a lost diagnostic but an
   * uncaught exception on the main process. Our breakage must never be why a
   * session dies.
   */
  private diag(kind: StreamDiagnostic['kind'], detail: string): void {
    try {
      this.onDiagnostic?.({ sessionId: this.id, kind, detail });
    } catch {
      /* a broken diagnostic sink must never take the pump down (P6) */
    }
  }

  /**
   * The end-of-life summary — and the consumer `stderrSnapshot` and `health`
   * never had (#593).
   *
   * Both were produced and dropped, the same shape #449 fixed for the
   * diagnostic channel itself: the tail was maintained on every stderr chunk
   * and the counters on every line, and nothing in the app ever read either.
   * They are WIRED rather than deleted because each carries exactly one thing
   * no other vantage point in the app can see:
   *
   *  - **The stderr tail.** Live stderr diagnostics are throttled on a
   *    power-of-two schedule, so a CLI that floods stderr gets occurrences
   *    1, 2, 4, ... logged — the FIRST chunks. The message that explains a
   *    death is the LAST one, which is precisely what the throttle drops and
   *    precisely what the tail holds. Each live line is also clipped to 500
   *    characters; the tail is not.
   *  - **`pendingBytes` at exit.** A nonzero value means the child died
   *    part-way through writing a line: a message we will never see, that
   *    raised no parse failure (it was never a complete line) and produced no
   *    `result`. Nothing else in the app records that it happened.
   *
   * The exit CODE is not the news here — `SessionManager.onExit` already logs
   * and classifies that — so it rides along as context only.
   *
   * **Silence when there is nothing to say.** No stderr, clean framing, no
   * partial line ⇒ no line at all. Without that gate every ordinary session
   * close would log a warning: `kill()` settles as code 1 (no exit code from a
   * signalled child), so "nonzero exit" is the normal way a user-closed
   * session ends and would be a warning on every card the user shuts.
   *
   * **Snapshot, not a guarantee of completeness.** stdio `data` can arrive
   * after `exit`, so a byte written in the child's last breath may miss this
   * line — it still reaches the live `stderr` diagnostic, so nothing is lost.
   * Waiting for `close` instead would be worse: on Windows the cmd.exe →
   * claude.cmd → node chain lets a grandchild hold the pipes open, so `close`
   * can be arbitrarily late or never, and a spawn that fails outright emits
   * `error` with no `exit` at all. `settle` fires exactly once in every one of
   * those cases, which is the property this needs.
   */
  private summarize(code: number): void {
    const h = this.health;
    const tail = this.stderrSnapshot.trim();
    if (!tail && h.parseFailures === 0 && h.overlongLines === 0 && h.pendingBytes === 0) return;
    const parts = [
      `exit ${code}`,
      `parseFailures=${h.parseFailures} overlongLines=${h.overlongLines} ` +
        `pendingBytes=${h.pendingBytes}`,
    ];
    // Last 2 KB of the 8 KB tail: the end is the informative end, and the
    // whole tail in one log field would push the rest of the log out of a
    // rotation. Untrusted child output, so it travels as `detail` — a log
    // FIELD, which `LogSink` redacts — never interpolated into the message.
    if (tail) parts.push(`stderr tail: ${tail.slice(-2048)}`);
    this.diag('exit', parts.join('; '));
  }

  private ingest(chunk: string): void {
    for (const r of this.decoder.push(chunk)) {
      if (!r.ok) {
        this.diag(r.raw === '' ? 'overlong-line' : 'parse-failure', r.error);
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

  /**
   * Framing-integrity counters — the thing to look at when output goes weird.
   * Read by `summarize()` at exit (#593), by `fake-stream-check`, and by tests.
   */
  get health(): { parseFailures: number; overlongLines: number; pendingBytes: number } {
    return {
      parseFailures: this.decoder.parseFailures,
      overlongLines: this.decoder.overlongLines,
      pendingBytes: this.decoder.pendingBytes,
    };
  }

  /**
   * The last few KB of stderr. Read by `summarize()` at exit (#593) — the
   * crash report it was always for — and by tests.
   */
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
      this.diag('stdin-write-failed', String(err));
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

export interface StreamServiceOptions {
  /**
   * Where diagnostics from EVERY session this service spawns go (#449).
   *
   * It lives on the service, not the spawn, because the only caller that
   * matters - `SessionManager` - spawns through `SessionTransport.spawn` and
   * can only pass `TransportSpawnOptions`. Widening that seam with a
   * stream-only field would make the PTY implement something meaningless, so
   * the wiring is attached once, where the concrete service is constructed
   * (`main/index.ts`). A per-spawn `onDiagnostic` still wins, so a test or
   * `fake-stream-check` can watch one session without a logger.
   */
  onDiagnostic?: (d: StreamDiagnostic) => void;
}

export class StreamService implements SessionTransport {
  private readonly sessions = new Map<string, StreamSession>();
  private readonly onDiagnostic?: (d: StreamDiagnostic) => void;

  constructor(opts: StreamServiceOptions = {}) {
    this.onDiagnostic = opts.onDiagnostic;
  }

  spawn(opts: StreamSpawnOptions): StreamSession {
    if (this.sessions.has(opts.id)) {
      throw new Error(`stream session "${opts.id}" already exists`);
    }
    // `??`, so an explicit `onDiagnostic: undefined` reads as "didn't say" and
    // still reaches the service's sink. Silence is the bug #449 fixed; a caller
    // that genuinely wants none can pass `() => {}` and say so.
    const s = new StreamSession({ ...opts, onDiagnostic: opts.onDiagnostic ?? this.onDiagnostic });
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
