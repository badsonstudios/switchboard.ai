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
  /** the one stream handler `detach` takes back off (#700) — stderr keeps its
   *  own, deliberately; see `detach` */
  private readonly onStdout: (chunk: string) => void;
  private detached = false;

  constructor(opts: StreamSpawnOptions) {
    this.id = opts.id;
    this.messages = new MessageRing<StreamMessage>(opts.ringCapacity ?? 2000);
    this.onDiagnostic = opts.onDiagnostic;

    const { file, argv } = launchSpec(opts.command, opts.args);
    this.proc = spawn(file, argv, {
      cwd: opts.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: buildEnv(process.env, opts.env),
      // NEVER omit. S-11's first run set this on one spawn and missed it on
      // another, and flashed a console window on the user's desktop 96 times
      // over eight hours. Every spawn on Windows needs it.
      windowsHide: true,
    });

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
    // Held as a named reference, not an inline arrow, for one reason: `detach`
    // has to be able to take it off again (#700).
    this.onStdout = (chunk: string) => this.ingest(chunk);
    this.proc.stdout.on('data', this.onStdout);

    // stderr stays an inline arrow because nothing ever removes it — a retired
    // session goes on collecting the tail that explains how it died (#700).
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

  /**
   * Subscribe to parsed messages. Refused after `detach` (#700): this session
   * has stopped reading, so accepting the listener and returning a working
   * unsubscriber would promise a stream that can never arrive. Saying no with a
   * no-op unsubscriber is the honest version, and it keeps the caller's teardown
   * code unchanged.
   */
  onMessage(l: (m: StreamMessage) => void): () => void {
    if (this.detached) return () => {};
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

  /**
   * Stop listening to a session that has been retired (#700).
   *
   * THE STRAGGLER, named. `StreamService.remove` deletes this session from its
   * map and kills the child, and until now that was all it did — the stdout
   * `data` handler and every `messageListeners` subscriber stayed attached. So
   * bytes already sitting in the CLI's stdout buffer when the user hit Restart
   * or closed the card went on being decoded, pushed into the ring and fanned
   * out, a tick later, against a session nothing in the app still knows about.
   * `StreamPermissions.offer` has a whole branch documenting one consequence:
   * a `can_use_tool` arriving from a session already torn down, answered into a
   * closed pipe. That branch stays — it is still reachable through other
   * arrivals, and a decline into a dead pipe is the right thing to do with one
   * — but the ordinary source of them is now closed at the tap instead of being
   * tidied up downstream.
   *
   * It was never the only victim, and the worse one leaves a mess rather than a
   * log line. `tearDownLive` calls `streamCommands.forgetSession` and
   * `streamFeed.forgetSession` BEFORE `manager.remove`, so a straggling
   * `system/init` landed after both — and `StreamCommandStore.offer` ends in a
   * bare `bySession.set(sessionId, parsed)` with no liveness check, which
   * re-created the entry that had just been dropped. One leaked command list per
   * restarted session, for the life of the process, with nothing left that could
   * reach it. Detaching at the tap fixes every consumer of the pump at once,
   * which is why this is the right layer for it.
   *
   * A MESSAGE DETACH, AND ONLY THAT. Two things are deliberately left attached,
   * and each of them is a way this function could do damage if it were not.
   *
   * 1. **The exit path.** `proc.on('exit')`, `proc.on('error')` and
   *    `exitListeners` are untouched. `SessionManager.remove` says it in as many
   *    words — "the exit LISTENERS fire either way — they live in the onExit
   *    closure and never consult the map" — and that closure is what deletes the
   *    session's state directory and reports the death. A `kill()` whose `exit`
   *    nobody hears is a leaked state dir and a corpse nothing announces.
   * 2. **stderr.** It was detached in this function's first version and that was
   *    wrong (#699 review). stderr is not a message: it never reaches
   *    `messageListeners` or the ring, it feeds the DIAGNOSTIC channel — the same
   *    one the exit summary above goes out on. Muting it would freeze
   *    `stderrTail` at the moment of detach, and the window between the signal
   *    and the child's actual death is precisely the window `summarize` exists
   *    to capture: "the message that explains a death is the LAST one". Killing a
   *    session must not be what deletes the explanation of how it died.
   *
   * `resume()` on stdout is DEFENCE, not a fix, and the difference is worth
   * stating because the first version of this comment claimed the opposite.
   * Removing a `data` listener does not pause a Node readable — only `readable`
   * is special-cased — so the stream is still flowing and this call is a no-op
   * today (measured, Node 22). It is kept so that a future pause somewhere else
   * cannot silently turn this detach into real backpressure on a child we have
   * only signalled. `destroy()` would be the wrong tool: it can EPIPE a child
   * that survives the signal, and draining to nowhere costs nothing.
   *
   * The decoder keeps whatever partial line it was holding; nothing will ask it
   * for one again. It, the ring and this object die together when the child is
   * reaped.
   *
   * Idempotent — `remove` can land on a session that already exited, and
   * `removeListener` on a handler that is gone is a no-op anyway; the flag is
   * there so the intent is legible rather than incidental.
   *
   * Safe to call RE-ENTRANTLY from inside `ingest`'s fan-out, which is a real
   * path: a message listener is free to tear its session down (listener →
   * `SessionManager.remove` → `StreamService.remove` → here), and that clears
   * the Set being iterated. Set iteration tolerates it — the loop simply ends —
   * and ending is the outcome we want anyway.
   */
  detach(): void {
    if (this.detached) return;
    this.detached = true;
    this.proc.stdout.removeListener('data', this.onStdout);
    this.proc.stdout.resume();
    this.messageListeners.clear();
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
    // AFTER the kill, and unconditionally. The live case is the one that
    // matters and the one the tests reproduce: a session killed mid-flight with
    // thousands of lines still behind us. The already-exited case is DEFENCE
    // rather than a path with a reproduction — Node delivers every stdout chunk
    // to our handler before it emits `exit`, so a corpse's backlog is measured
    // at zero (#699 review) — but it costs nothing and stops being a guess the
    // day that ordering changes. See `StreamSession.detach` for what this does
    // and does not take down (#700).
    //
    // So `remove` now means KILL AND MUTE, and two things follow. `SessionManager
    // .kill` routes here while KEEPING its record and handle, so it produces a
    // session that reads as alive and whose message pipe is deliberately dead —
    // true only for `hooks/hook-check.ts` today, which wants exactly that. And
    // `PtyService.remove` does not do this: `SessionTransport.remove` promises a
    // teardown, not a detach, and the PTY's pump has no equivalent fan-out to
    // mute. A future transport should not read this as a required step.
    s?.detach();
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
