/**
 * The tier-2 capture file — E21's deliverable (#923).
 *
 * P2-E21-02 is the owner flipping the switch, working a normal day on the work
 * laptop, and attaching what came out. So the output of this file is not a log
 * we grep later: it is **one file he can drag onto a GitHub issue**, and every
 * decision below follows from that.
 *
 * ## One file, appended across runs
 *
 * Not one per launch. A working day includes restarts, and "attach the file"
 * has to stay one instruction rather than "find the six from today and attach
 * whichever ones look busy". Each run writes a `run` header line first, so the
 * boundaries are still legible inside it.
 *
 * ## JSON Lines, and why a partial last line is fine
 *
 * The case worth capturing is the one where the app is wedged, and that is
 * exactly the case where a clean shutdown never happens. NDJSON degrades well:
 * a reader drops the torn final line and keeps the whole day before it. A
 * single JSON array would be unparseable end to end.
 *
 * ## Synchronous appends, deliberately
 *
 * A write stream would buffer, and buffered is precisely what we do not want
 * when the interesting event is a freeze. Batches arrive every few seconds and
 * are a few KB, so an `appendFileSync` costs on the order of a tenth of a
 * millisecond per flush on the main process — far below the event-loop
 * resolution we sample at, and paid only while the switch is ON.
 *
 * ## Local-only
 *
 * Every line is numbers, our own enum names, and the machine's own identity
 * (version, platform, CPU model) — that last group is the point of the whole
 * epic, since the question is why the laptop differs from the desktop. There is
 * no prompt text, no file name and no session content, and `perf-capture.test`
 * asserts it by walking every string in a real line rather than by trusting
 * this paragraph.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  batchIsEmpty,
  isPerfInteraction,
  type PerfBatch,
  type PerfKeystroke,
  type PerfLoopDelay,
} from '../../shared/perf';
import type { Logger } from '../log/logger';

/** The name the owner is told to look for. Stable — it is in the manual. */
export const CAPTURE_FILE = 'performance-capture.jsonl';

/**
 * Rotate at 8 MB, keeping one previous file.
 *
 * A day of typing at tier 2 is roughly a few MB, so 8 holds a full working day
 * with room to spare; the `.1` sibling means a second day does not silently
 * erase the first. Capped at all because an instrument left switched on for a
 * month must not be the thing that fills the disk.
 */
export const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;

/** The machine facts that make a capture comparable between two computers. */
export interface CaptureMachine {
  version: string;
  platform: string;
  arch: string;
  cpuModel: string;
  cpuCount: number;
  memGb: number;
}

export interface PerfCaptureDeps {
  /** where the file lives — userData, beside `workspace.json` */
  dir: string;
  version: string;
  log: Logger;
  now?: () => number;
  /** injectable so a test is not at the mercy of the machine running it */
  machine?: () => CaptureMachine;
}

function describeMachine(version: string): CaptureMachine {
  const cpus = os.cpus();
  return {
    version,
    platform: process.platform,
    arch: process.arch,
    // `os.cpus()` can answer an empty array in containers. An empty string is
    // honest; a fabricated model name would be worse than no model name.
    cpuModel: cpus[0]?.model?.trim() ?? '',
    cpuCount: cpus.length,
    memGb: Math.round(os.totalmem() / 1024 ** 3),
  };
}

/** A finite number, or `null`. Rejects NaN, Infinity, strings and objects. */
function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * Rebuild a batch field by field, dropping anything that is not a number we
 * asked for or a name we declared.
 *
 * REBUILT, not checked in place. A validator that inspects the known fields and
 * then passes the original object through would let an extra property ride
 * along into the file — and an extra property is exactly the shape a leak takes.
 * Every value written below is either a `number` or a member of
 * `PERF_INTERACTIONS`, which is what the local-only claim reduces to.
 */
export function sanitizeBatch(raw: unknown): PerfBatch | null {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const at = num(r.at);
  if (at === null) return null;

  const batch: PerfBatch = { at, interactions: [], longTasks: [], keystrokes: [] };

  for (const item of asArray(r.interactions)) {
    if (item === null || typeof item !== 'object') continue;
    const s = item as Record<string, unknown>;
    const ms = num(s.ms);
    const sampleAt = num(s.at);
    if (ms === null || sampleAt === null || !isPerfInteraction(s.name)) continue;
    batch.interactions.push({ name: s.name, ms, at: sampleAt });
  }

  for (const item of asArray(r.longTasks)) {
    if (item === null || typeof item !== 'object') continue;
    const t = item as Record<string, unknown>;
    const ms = num(t.ms);
    const taskAt = num(t.at);
    if (ms === null || taskAt === null) continue;
    batch.longTasks.push({ at: taskAt, ms });
  }

  for (const item of asArray(r.keystrokes)) {
    if (item === null || typeof item !== 'object') continue;
    const k = item as Record<string, unknown>;
    const fields = {
      at: num(k.at),
      ms: num(k.ms),
      blockedMs: num(k.blockedMs),
      layoutReads: num(k.layoutReads),
      blocks: num(k.blocks),
      rendered: num(k.rendered),
      draftLength: num(k.draftLength),
    };
    if (Object.values(fields).some((v) => v === null)) continue;
    batch.keystrokes.push(fields as PerfKeystroke);
  }

  return batch;
}

export class PerfCapture {
  private readonly deps: PerfCaptureDeps;
  private readonly now: () => number;
  private on = false;
  /**
   * Bytes in the live file, tracked rather than `stat`ed per write. A `statSync`
   * on every flush would double the syscalls this thing costs for a number we
   * already know.
   */
  private bytes = 0;

  constructor(deps: PerfCaptureDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  /** Absolute path to the file, for "show it in the folder" and the zip. */
  path(): string {
    return path.join(this.deps.dir, CAPTURE_FILE);
  }

  enabled(): boolean {
    return this.on;
  }

  /**
   * Follow the switch. Turning ON writes the run header immediately, so a file
   * exists the moment the owner has flipped it — an empty folder after clicking
   * the switch reads as "it did not work", and he would be right to think so.
   */
  setEnabled(on: boolean): void {
    if (on === this.on) return;
    this.on = on;
    if (!on) return;
    try {
      this.bytes = fs.existsSync(this.path()) ? fs.statSync(this.path()).size : 0;
    } catch {
      this.bytes = 0;
    }
    const machine = (this.deps.machine ?? (() => describeMachine(this.deps.version)))();
    this.write({ kind: 'run', ...machine });
  }

  /**
   * A flush from the renderer. A no-op when the switch is off.
   *
   * Takes `unknown` and rebuilds, rather than trusting the type. The broker
   * launders the `any` off the wire but explicitly does not validate a payload —
   * that is documented as the call site's job — and this call site is the one
   * place in the feature where the local-only guarantee would otherwise rest on
   * trust: whatever lands here gets `JSON.stringify`d into a file that the
   * report bundle attaches to a GitHub issue. The closed vocabulary in
   * `shared/perf.ts` is a COMPILE-TIME property; `sanitizeBatch` is what makes
   * it true at runtime, and it is what makes the "no string we did not author"
   * test meaningful against a hostile payload rather than only a well-formed
   * one. It also means a malformed message cannot throw inside an `ipcMain.on`
   * listener, which would be an uncaught exception in main rather than a
   * rejected promise.
   */
  record(raw: unknown): void {
    if (!this.on) return;
    const batch = sanitizeBatch(raw);
    if (!batch || batchIsEmpty(batch)) return;
    this.write({
      kind: 'batch',
      at: batch.at,
      interactions: batch.interactions,
      longTasks: batch.longTasks,
      keystrokes: batch.keystrokes,
    });
  }

  /** Main's own event-loop delay, once a minute, from the CPU heartbeat. */
  recordLoop(loop: PerfLoopDelay): void {
    if (!this.on) return;
    this.write({ kind: 'loop', ...loop });
  }

  /**
   * One line, and never a thrown error.
   *
   * Fail-open is a hard constraint: a full disk or a locked file must cost the
   * owner a capture, never his session. The failure is logged once per
   * occurrence rather than swallowed silently — a capture that quietly wrote
   * nothing all day is the single worst outcome for P2-E21-02.
   */
  private write(record: Record<string, unknown>): void {
    const line = `${JSON.stringify({ t: new Date(this.now()).toISOString(), ...record })}\n`;
    const size = Buffer.byteLength(line);
    try {
      this.rotateIfFull(size);
      fs.mkdirSync(this.deps.dir, { recursive: true });
      fs.appendFileSync(this.path(), line);
      this.bytes += size;
    } catch (err) {
      this.deps.log.warn('could not write the performance capture', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Once rotation has failed, stop trying.
   *
   * Without this the byte count stays above the cap forever, so every later
   * flush retries a `rename` that is not going to start working — a syscall per
   * flush, for the rest of the run, in the one component whose entire thesis is
   * that it costs nothing.
   */
  private rotationBroken = false;

  private rotateIfFull(incoming: number): void {
    if (this.rotationBroken) return;
    if (this.bytes + incoming <= MAX_CAPTURE_BYTES) return;
    try {
      // `rename` REPLACES an existing target on both platforms we ship to, so
      // the older-still file goes and that is the right one to lose.
      //
      // Deliberately NOT `rm` then `rename`: that pair destroys the previous
      // capture first and then, if the rename throws, has thrown away a day's
      // evidence and gained nothing. One atomic call either works or leaves both
      // files where they were.
      fs.renameSync(this.path(), `${this.path()}.1`);
      this.bytes = 0;
    } catch (err) {
      // Failing to rotate is not a reason to stop capturing: the file growing
      // past the cap costs disk, while refusing to write costs the working day
      // this instrument exists to record.
      this.rotationBroken = true;
      this.deps.log.warn('could not rotate the performance capture — it will grow past its cap', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
