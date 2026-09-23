import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PERF_INTERACTIONS, emptyBatch, stringLeaves, type PerfBatch } from '../../shared/perf';
import {
  CAPTURE_FILE,
  MAX_CAPTURE_BYTES,
  PerfCapture,
  sanitizeBatch,
  type CaptureMachine,
} from './perf-capture';
import type { Logger } from '../log/logger';

let dir: string;
let warnings: { msg: string; fields?: Record<string, unknown> }[];

const log = (): Logger => {
  const l = {
    debug: () => undefined,
    info: () => undefined,
    warn: (msg: string, fields?: Record<string, unknown>) => warnings.push({ msg, fields }),
    error: () => undefined,
    child: () => l,
  };
  return l;
};

const MACHINE: CaptureMachine = {
  version: '0.8.98',
  platform: 'win32',
  arch: 'x64',
  cpuModel: '11th Gen Intel(R) Core(TM) i7-1185G7 @ 3.00GHz',
  cpuCount: 8,
  memGb: 16,
};

function make(over: Partial<ConstructorParameters<typeof PerfCapture>[0]> = {}): PerfCapture {
  return new PerfCapture({
    dir,
    version: '0.8.98',
    log: log(),
    now: () => Date.parse('2026-09-23T14:32:00.000Z'),
    machine: () => MACHINE,
    ...over,
  });
}

const lines = (): Record<string, unknown>[] =>
  fs
    .readFileSync(path.join(dir, CAPTURE_FILE), 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);

function busyBatch(): PerfBatch {
  const b = emptyBatch(12_000);
  b.interactions.push({ name: 'keystroke', ms: 41, at: 11_900 });
  b.longTasks.push({ at: 11_910, ms: 88 });
  b.keystrokes.push({
    at: 11_900,
    ms: 41,
    blockedMs: 88,
    layoutReads: 2,
    blocks: 412,
    rendered: 120,
    draftLength: 2048,
  });
  return b;
}

beforeEach(() => {
  warnings = [];
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-perf-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('PerfCapture — the switch (#923)', () => {
  it('writes nothing at all while the switch is off', () => {
    // Not "writes an empty file". OFF means absent, and a zero-byte file beside
    // workspace.json invites the question of why it is there.
    const c = make();
    c.record(busyBatch());
    c.recordLoop({ p50: 1, p99: 40, maxMs: 300 });
    expect(fs.existsSync(path.join(dir, CAPTURE_FILE))).toBe(false);
    expect(c.enabled()).toBe(false);
  });

  it('writes the run header the moment it is switched on', () => {
    // An empty folder after clicking the switch reads as "it did not work",
    // and the owner would be right to think so.
    const c = make();
    c.setEnabled(true);
    const [first] = lines();
    expect(first).toMatchObject({ kind: 'run', version: '0.8.98', platform: 'win32' });
  });

  it('carries the machine, because laptop-vs-desktop IS the question', () => {
    const c = make();
    c.setEnabled(true);
    expect(lines()[0]).toMatchObject({
      cpuModel: MACHINE.cpuModel,
      cpuCount: 8,
      memGb: 16,
      arch: 'x64',
    });
  });

  it('switching on twice does not write a second header', () => {
    const c = make();
    c.setEnabled(true);
    c.setEnabled(true);
    expect(lines()).toHaveLength(1);
  });

  it('stops writing when switched off, and keeps what it already wrote', () => {
    const c = make();
    c.setEnabled(true);
    c.record(busyBatch());
    const before = lines().length;
    c.setEnabled(false);
    c.record(busyBatch());
    expect(lines()).toHaveLength(before);
  });

  it('appends across runs rather than starting a file per launch', () => {
    // "Attach the file" has to stay one instruction. A working day includes
    // restarts, and six files named by timestamp is not one instruction.
    make().setEnabled(true);
    const second = make();
    second.setEnabled(true);
    second.record(busyBatch());

    const all = lines();
    expect(all.filter((l) => l.kind === 'run')).toHaveLength(2);
    expect(all.filter((l) => l.kind === 'batch')).toHaveLength(1);
  });
});

describe('PerfCapture — what lands in the file (#923)', () => {
  it('writes one line per batch, with the samples intact', () => {
    const c = make();
    c.setEnabled(true);
    c.record(busyBatch());
    const batch = lines().find((l) => l.kind === 'batch')!;
    expect(batch).toMatchObject({ at: 12_000 });
    expect((batch.keystrokes as unknown[])[0]).toMatchObject({ layoutReads: 2, blocks: 412 });
  });

  it('skips an empty batch — a quiet minute is not worth a line', () => {
    const c = make();
    c.setEnabled(true);
    c.record(emptyBatch(500));
    expect(lines().filter((l) => l.kind === 'batch')).toHaveLength(0);
  });

  it('records main’s event-loop delay beside the renderer’s samples', () => {
    const c = make();
    c.setEnabled(true);
    c.recordLoop({ p50: 1.2, p99: 48, maxMs: 310 });
    expect(lines().find((l) => l.kind === 'loop')).toMatchObject({ p50: 1.2, p99: 48, maxMs: 310 });
  });

  it('stamps every line with a wall clock, so a spike can be matched to a memory', () => {
    const c = make();
    c.setEnabled(true);
    c.record(busyBatch());
    for (const l of lines()) expect(l.t).toBe('2026-09-23T14:32:00.000Z');
  });

  it('is JSON Lines — a torn final line costs the last flush, not the day', () => {
    // The case worth capturing is a wedged app, which is exactly the case where
    // a clean shutdown never happens. A single JSON array would be unparseable
    // end to end; this degrades to "drop the last line".
    const c = make();
    c.setEnabled(true);
    c.record(busyBatch());
    c.record(busyBatch());
    const raw = fs.readFileSync(path.join(dir, CAPTURE_FILE), 'utf8');
    fs.writeFileSync(path.join(dir, CAPTURE_FILE), `${raw}{"kind":"batch","at":`);

    const parsed = fs
      .readFileSync(path.join(dir, CAPTURE_FILE), 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => {
        try {
          return JSON.parse(l) as unknown;
        } catch {
          return null;
        }
      });
    expect(parsed.filter((p) => p !== null)).toHaveLength(3);
    expect(parsed.filter((p) => p === null)).toHaveLength(1);
  });
});

describe('PerfCapture — local-only, asserted rather than promised (#923)', () => {
  it('every string in the whole file is one we authored or a machine fact', () => {
    // THE constraint, and the reason it is a walk rather than a field check:
    // the dangerous field is not the one someone added carelessly today, it is
    // the one someone adds in six months. A walk over every string catches
    // that one too, and this test goes red when it appears.
    const c = make();
    c.setEnabled(true);
    c.record(busyBatch());
    c.recordLoop({ p50: 1, p99: 40, maxMs: 300 });

    const allowed = new Set<string>([
      ...PERF_INTERACTIONS,
      // our own structural keys
      't',
      'kind',
      'run',
      'batch',
      'loop',
      'at',
      'ms',
      'name',
      'interactions',
      'longTasks',
      'keystrokes',
      'blockedMs',
      'layoutReads',
      'blocks',
      'rendered',
      'draftLength',
      'p50',
      'p99',
      'maxMs',
      // the machine, declared field by field on purpose
      'version',
      'platform',
      'arch',
      'cpuModel',
      'cpuCount',
      'memGb',
      MACHINE.version,
      MACHINE.platform,
      MACHINE.arch,
      MACHINE.cpuModel,
      '2026-09-23T14:32:00.000Z',
    ]);

    for (const l of lines())
      for (const s of stringLeaves(l))
        expect(allowed.has(s), `unexpected string in the capture file: ${JSON.stringify(s)}`).toBe(
          true
        );
  });

  it('the draft is a LENGTH — there is no field a character of it could reach', () => {
    const c = make();
    c.setEnabled(true);
    const b = emptyBatch(1);
    b.keystrokes.push({
      at: 1,
      ms: 1,
      blockedMs: 0,
      layoutReads: 0,
      blocks: 1,
      rendered: 1,
      draftLength: 'rm -rf the secret project'.length,
    });
    c.record(b);
    expect(fs.readFileSync(path.join(dir, CAPTURE_FILE), 'utf8')).not.toContain('secret');
  });
});

describe('sanitizeBatch — the local-only guarantee, enforced not trusted (#923 review)', () => {
  // The broker launders the `any` off the wire and explicitly does NOT validate
  // the payload — that is documented as the call site's job. This IS that job,
  // and it is the one place in the feature where "no prompt text, no file names,
  // no session content" would otherwise rest on the renderer behaving, for a
  // file the report bundle attaches to a GitHub issue.

  it('refuses anything that is not a batch', () => {
    for (const junk of [null, undefined, 'a string', 42, [], {}, { at: 'soon' }])
      expect(sanitizeBatch(junk), JSON.stringify(junk)).toBeNull();
  });

  it('drops a sample whose interaction name we never declared', () => {
    const out = sanitizeBatch({
      at: 1,
      interactions: [
        { name: 'keystroke', ms: 1, at: 1 },
        { name: 'rm -rf /home/dan/secret', ms: 1, at: 1 },
      ],
    });
    expect(out?.interactions).toHaveLength(1);
    expect(out?.interactions[0]?.name).toBe('keystroke');
  });

  it('REBUILDS rather than passes through — an extra property cannot ride along', () => {
    // The shape a leak actually takes. A validator that checked the known
    // fields and then handed the original object on would write this straight
    // into the file.
    const out = sanitizeBatch({
      at: 1,
      prompt: 'delete the production database',
      keystrokes: [
        {
          at: 1,
          ms: 1,
          blockedMs: 0,
          layoutReads: 0,
          blocks: 1,
          rendered: 1,
          draftLength: 5,
          draftText: 'hello',
          file: '/home/dan/secret.ts',
        },
      ],
    });
    expect(JSON.stringify(out)).not.toContain('production');
    expect(JSON.stringify(out)).not.toContain('hello');
    expect(JSON.stringify(out)).not.toContain('secret');
    expect(out?.keystrokes).toHaveLength(1);
    expect(Object.keys(out!.keystrokes[0]).sort()).toEqual([
      'at',
      'blockedMs',
      'blocks',
      'draftLength',
      'layoutReads',
      'ms',
      'rendered',
    ]);
  });

  it('rejects NaN and Infinity, which JSON writes as null', () => {
    const out = sanitizeBatch({
      at: 1,
      longTasks: [
        { at: 1, ms: Number.NaN },
        { at: 1, ms: Number.POSITIVE_INFINITY },
        { at: 2, ms: 60 },
      ],
    });
    expect(out?.longTasks).toEqual([{ at: 2, ms: 60 }]);
  });

  it('a hostile payload reaches the FILE as nothing', () => {
    const c = make();
    c.setEnabled(true);
    const before = lines().length;
    c.record({ at: 1, interactions: [{ name: 'my prompt text', ms: 1, at: 1 }] });
    expect(lines()).toHaveLength(before); // an all-junk batch is an empty batch
  });

  it('a malformed message does not throw out of the ipcMain listener', () => {
    // `broker.on` is fire-and-forget, so a throw here is an uncaught exception
    // in MAIN rather than a rejected promise.
    const c = make();
    c.setEnabled(true);
    for (const junk of [undefined, null, 'nope', 7, []])
      expect(() => c.record(junk)).not.toThrow();
  });
});

describe('PerfCapture — it must not become the problem (#923)', () => {
  it('rotates at the cap, keeping exactly one previous file', () => {
    const c = make();
    c.setEnabled(true);
    // Pretend the day has already filled it, rather than writing 8 MB here.
    fs.writeFileSync(path.join(dir, CAPTURE_FILE), 'x'.repeat(MAX_CAPTURE_BYTES));
    const fresh = make();
    fresh.setEnabled(true); // re-reads the on-disk size
    fresh.record(busyBatch());

    expect(fs.existsSync(`${path.join(dir, CAPTURE_FILE)}.1`)).toBe(true);
    expect(fs.statSync(path.join(dir, CAPTURE_FILE)).size).toBeLessThan(MAX_CAPTURE_BYTES);
  });

  it('a second rotation replaces the old sibling rather than growing a family', () => {
    const file = path.join(dir, CAPTURE_FILE);
    fs.writeFileSync(`${file}.1`, 'older still');
    fs.writeFileSync(file, 'x'.repeat(MAX_CAPTURE_BYTES));
    const c = make();
    c.setEnabled(true);
    c.record(busyBatch());
    expect(fs.existsSync(`${file}.2`)).toBe(false);
    expect(fs.readFileSync(`${file}.1`, 'utf8')).not.toBe('older still');
  });

  it('a failed rotation keeps the day it was about to throw away', () => {
    // The `rm` then `rename` pair destroyed the previous capture FIRST and, if
    // the rename then threw, had lost a day's evidence and gained nothing. One
    // atomic rename either works or leaves both files where they were.
    const file = path.join(dir, CAPTURE_FILE);
    fs.writeFileSync(`${file}.1`, 'yesterday, which is the day being reported on');
    fs.writeFileSync(file, 'x'.repeat(MAX_CAPTURE_BYTES));
    const c = make();
    // Installed BEFORE the switch: `setEnabled` writes the run header, and with
    // the file already at the cap that write is itself the one that rotates.
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw new Error('EBUSY');
    });
    try {
      c.setEnabled(true);
      c.record(busyBatch());
    } finally {
      spy.mockRestore();
    }
    expect(fs.readFileSync(`${file}.1`, 'utf8')).toBe(
      'yesterday, which is the day being reported on'
    );
    // …and it still captured, because refusing to write costs the working day.
    expect(fs.readFileSync(file, 'utf8')).toContain('"kind":"batch"');
  });

  it('stops retrying once rotation has failed', () => {
    // Otherwise the byte count stays above the cap forever and every later
    // flush retries a rename that is not going to start working — a syscall per
    // flush, for the rest of the run, in the component whose whole thesis is
    // that it costs nothing.
    fs.writeFileSync(path.join(dir, CAPTURE_FILE), 'x'.repeat(MAX_CAPTURE_BYTES));
    const c = make();
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw new Error('EBUSY');
    });
    let attempts = 0;
    try {
      c.setEnabled(true); // the header write is the first rotation attempt
      for (let i = 0; i < 5; i += 1) c.record(busyBatch());
      // Read BEFORE restoring: `mockRestore` clears the call history, which is
      // the assertion.
      attempts = spy.mock.calls.length;
    } finally {
      spy.mockRestore();
    }
    expect(attempts).toBe(1);
    // …and it said so once, rather than silently growing.
    expect(warnings.filter((w) => /could not rotate/.test(w.msg))).toHaveLength(1);
  });

  it('an unwritable directory costs a capture, never a session (fail-open)', () => {
    const c = make({ dir: path.join(dir, 'nope') });
    const spy = vi.spyOn(fs, 'appendFileSync').mockImplementation(() => {
      throw new Error('EACCES');
    });
    try {
      expect(() => {
        c.setEnabled(true);
        c.record(busyBatch());
      }).not.toThrow();
    } finally {
      spy.mockRestore();
    }
    // …and it SAYS so. A capture that silently wrote nothing all day is the one
    // outcome that would waste the owner's whole working day of measuring.
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0].msg).toMatch(/could not write the performance capture/);
  });
});
