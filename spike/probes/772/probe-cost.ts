// #772 probe: what does a bus read actually COST the host, and what does a
// burst of them do to Electron main's event loop?
//
// #764 set two deadlines (host 12 s, child slow-tool 15 s) against ONE number —
// `git diff` on this repo, ~97 KB, warm, ~370 ms — and never measured the
// transcript path at all. This measures both, through the REAL modules (it is
// bundled from `src/`, not reimplemented), in three parts:
//
//   A. `readTranscriptTail` and `SessionQueries.sessionOutput` against this
//      machine's own transcripts, largest first. This path is SYNCHRONOUS, so
//      its wall time IS main-thread stall time.
//   B. `GitService.diff` against synthetic repos at three scales and four dirty
//      states, with the event loop's worst delay recorded while it runs. Async,
//      so the question there is wall time against the deadlines, not stall.
//   C. A real `BusHost` over a real `SessionQueries`, hit with bursts of N
//      concurrent connections from a SEPARATE process (`fire.mjs`), recording
//      the longest gap a 1 ms heartbeat in the host saw. That is the number the
//      P6 inversion is about: how long the user's UI would freeze.
//
// Run from the repo root (see README.md). Writes a JSON artifact beside itself.
import { execFile, execFileSync, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { monitorEventLoopDelay, performance } from 'perf_hooks';
import { HISTORY_TAIL_BYTES, readTranscriptTail } from '../../../src/main/feed/history';
import { SessionQueries, type SessionSummary } from '../../../src/main/sessions/queries';
import { GitService } from '../../../src/main/git/git-service';
import { BusHost } from '../../../src/main/bus/host-channel';
import type { BusDelivery } from '../../../src/main/sessions/delivery';
import type { Logger } from '../../../src/main/log/logger';

const PROBE_DIR = path.resolve('spike/probes/772');
const SCALES = (process.env.PROBE_SCALES ?? '2000,20000,100000').split(',').map(Number);
const PARTS = new Set((process.env.PROBE_PARTS ?? 'A,B,C').split(','));
const KEEP = process.env.PROBE_KEEP === '1';
const RUNS = 5;

const round = (n: number): number => Math.round(n * 10) / 10;
const mb = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(2)} MB`;
const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
function timeSync<T>(fn: () => T): [number, T] {
  const t0 = performance.now();
  const v = fn();
  return [performance.now() - t0, v];
}
async function timeAsync<T>(fn: () => Promise<T>): Promise<[number, T]> {
  const t0 = performance.now();
  const v = await fn();
  return [performance.now() - t0, v];
}
const say = (s: string): void => console.log(`[772] ${s}`);

const quietLog = {
  debug: () => {},
  info: () => {},
  warn: (m: string, f?: unknown) => say(`host warn: ${m} ${JSON.stringify(f ?? '')}`),
  error: (m: string, f?: unknown) => say(`host ERR: ${m} ${JSON.stringify(f ?? '')}`),
  child: () => quietLog,
} as unknown as Logger;

const results: Record<string, unknown> = {
  when: new Date().toISOString(),
  node: process.versions.node,
  electron: process.versions.electron ?? null,
  v8: process.versions.v8,
  platform: `${process.platform} ${os.release()}`,
  cpu: os.cpus()[0]?.model,
  ncpu: os.cpus().length,
};

// ── A. THE TRANSCRIPT PATH ──────────────────────────────────────────────────

interface Transcript {
  file: string;
  size: number;
}

function realTranscripts(): Transcript[] {
  const root = path.join(os.homedir(), '.claude', 'projects');
  const out: Transcript[] = [];
  for (const rel of fs.readdirSync(root, { recursive: true }) as string[]) {
    if (!rel.endsWith('.jsonl')) continue;
    const file = path.join(root, rel);
    try {
      out.push({ file, size: fs.statSync(file).size });
    } catch {
      /* rotated away mid-walk */
    }
  }
  return out.sort((a, b) => b.size - a.size);
}

/** Largest six, plus the nearest to each smaller size a normal session has. */
function pickTranscripts(all: Transcript[]): Transcript[] {
  const picked = all.slice(0, 6);
  for (const target of [2 * 1024 * 1024, 1024 * 1024, 256 * 1024, 64 * 1024]) {
    const near = all.reduce((best, t) =>
      Math.abs(t.size - target) < Math.abs(best.size - target) ? t : best
    );
    if (!picked.includes(near)) picked.push(near);
  }
  return picked;
}

function rawTailRead(file: string, size: number): number {
  const len = Math.min(size, HISTORY_TAIL_BYTES);
  const buf = Buffer.allocUnsafe(len);
  const fd = fs.openSync(file, 'r');
  try {
    let got = 0;
    while (got < len) {
      const n = fs.readSync(fd, buf, got, len - got, size - len + got);
      if (n <= 0) break;
      got += n;
    }
    return got;
  } finally {
    fs.closeSync(fd);
  }
}

function queriesOver(file: string | null, folder = ''): SessionQueries {
  const sessions: SessionSummary[] = [
    { id: 'sb-sib', name: 'Sibling', folder, providerId: 'claude-code', status: 'idle', exited: false },
  ];
  return new SessionQueries({
    list: () => sessions,
    transcriptFor: () => file,
    git: new GitService(),
  });
}

function partA(): Transcript[] {
  const all = realTranscripts();
  say(`A: ${all.length} transcripts on this machine; ${all.filter((t) => t.size > HISTORY_TAIL_BYTES).length} exceed the 4 MB tail window`);
  const rows: Record<string, unknown>[] = [];
  for (const [i, t] of pickTranscripts(all).entries()) {
    const q = queriesOver(t.file);
    // FIRST CALL FIRST, before anything else has touched the file — the
    // closest this can get to a cold read without admin rights to flush the
    // OS cache. Whatever it is, it is what the first sibling to ask would pay.
    const [firstOutput] = timeSync(() => q.sessionOutput('sb-sib', 20));
    const io: number[] = [];
    const tail: number[] = [];
    const out20: number[] = [];
    const out200: number[] = [];
    let entries = 0;
    for (let r = 0; r < RUNS; r++) {
      io.push(timeSync(() => rawTailRead(t.file, t.size))[0]);
      const [ms, e] = timeSync(() => readTranscriptTail(t.file));
      tail.push(ms);
      entries = e.length;
      out20.push(timeSync(() => q.sessionOutput('sb-sib', 20))[0]);
      out200.push(timeSync(() => q.sessionOutput('sb-sib', 200))[0]);
    }
    const row = {
      label: `real #${i + 1}`,
      size: t.size,
      window: Math.min(t.size, HISTORY_TAIL_BYTES),
      entries,
      firstOutputMs: round(firstOutput),
      ioMs: round(median(io)),
      tailMs: round(median(tail)),
      output20Ms: round(median(out20)),
      output20MaxMs: round(Math.max(...out20)),
      output200Ms: round(median(out200)),
    };
    rows.push(row);
    say(
      `A: ${row.label.padEnd(9)} ${mb(t.size).padStart(9)}  entries ${String(entries).padStart(5)}  ` +
        `first ${row.firstOutputMs}ms  io ${row.ioMs}  tail ${row.tailMs}  out20 ${row.output20Ms} (max ${row.output20MaxMs})  out200 ${row.output200Ms}`
    );
  }
  results.transcripts = rows;
  return all;
}

// ── B. THE GIT PATH ─────────────────────────────────────────────────────────

// HERMETIC FOR CREATION ONLY — the bus-check recipe, so the user's hooks and
// signing never run against a throwaway repo. The MEASUREMENT uses the real
// environment, because production's `GitService` does: this machine's git
// config (fscache, autocrlf, …) is part of what a real diff costs.
const hermetic = { ...process.env, GIT_CONFIG_GLOBAL: '', GIT_CONFIG_SYSTEM: '', GIT_CONFIG_NOSYSTEM: '1' };
const gitMk = (cwd: string, ...args: string[]): void => {
  execFileSync('git', args, { cwd, stdio: 'pipe', env: hermetic, maxBuffer: 64 * 1024 * 1024 });
};

const LINES_PER_FILE = 40;
const fileBody = (i: number, bump: number): string =>
  Array.from({ length: LINES_PER_FILE }, (_, l) => `export const v${i}_${l} = ${l + bump};`).join('\n') + '\n';
const fileAt = (repo: string, i: number): string => path.join(repo, `d${Math.floor(i / 500)}`, `f${i}.ts`);

function makeRepo(files: number): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), `sb-772-${files}-`));
  const t0 = performance.now();
  for (let i = 0; i < files; i++) {
    const f = fileAt(repo, i);
    if (i % 500 === 0) fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, fileBody(i, 0));
  }
  gitMk(repo, 'init', '-q');
  gitMk(repo, 'config', 'user.email', 'probe@example.invalid');
  gitMk(repo, 'config', 'user.name', 'probe 772');
  gitMk(repo, 'config', 'commit.gpgsign', 'false');
  gitMk(repo, 'add', '-A');
  gitMk(repo, 'commit', '-qm', 'initial');
  say(`B: built a ${files}-file repo in ${Math.round((performance.now() - t0) / 1000)}s`);
  return repo;
}

/** Rewrite files [from, to) so every line changes — ~2.5 KB of diff apiece. */
function dirty(repo: string, from: number, to: number): void {
  for (let i = from; i < to; i++) fs.writeFileSync(fileAt(repo, i), fileBody(i, 1));
}

function gitTimed(folder: string, args: string[]): Promise<number> {
  const t0 = performance.now();
  return new Promise((resolve) => {
    execFile('git', args, { cwd: folder, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true }, () =>
      resolve(performance.now() - t0)
    );
  });
}

/** What `GitService.diff` runs since #772, minus the base it picks. */
const PLUMBING = ['diff-index', '-p', '-M', '--no-color', '--no-textconv', '--no-ext-diff', 'HEAD'];

/**
 * The one state where plumbing should cost MORE than porcelain: every file
 * rewritten with identical bytes (new mtime, same content — a formatter run, a
 * branch round trip). Porcelain refreshes the index once and is fast after;
 * plumbing never writes the index, so it re-reads every such file on every
 * call. Plumbing is timed FIRST, because porcelain's refresh would hide it.
 * The tree is put back to clean (by porcelain's own refresh) afterwards, so
 * the dirty states that follow measure what they did before.
 */
async function touchedState(repo: string, files: number): Promise<Record<string, unknown>> {
  await sleep(1500); // past the racy-git window, so the index's own mtime is not the cause
  for (let i = 0; i < files; i++) fs.writeFileSync(fileAt(repo, i), fileBody(i, 0));
  const plumbing = [];
  for (let r = 0; r < 3; r++) plumbing.push(round(await gitTimed(repo, PLUMBING)));
  const porcelain = [];
  for (let r = 0; r < 3; r++) porcelain.push(round(await gitTimed(repo, ['diff', '--no-textconv', '--no-ext-diff', 'HEAD'])));
  const plumbingAfterRefresh = round(await gitTimed(repo, PLUMBING));
  say(
    `B: ${String(files).padStart(6)} files, ALL touched, none changed → plumbing ${plumbing.join(' / ')}ms; ` +
      `porcelain ${porcelain.join(' / ')}ms (the first one refreshes the index); plumbing after that ${plumbingAfterRefresh}ms`
  );
  return { files, touchedAll: true, plumbingMs: plumbing, porcelainMs: porcelain, plumbingAfterRefreshMs: plumbingAfterRefresh };
}

// Dirty states, as a count of rewritten files. ~2.5 KB each: 40 ≈ 100 KB,
// 800 ≈ 2 MB, 4,000 ≈ 10 MB, 14,500 ≈ 36 MB (past `maxBuffer`'s 32 MB).
const STATES = [0, 40, 800, 4000, 14500];

async function partB(): Promise<Map<number, string>> {
  const repos = new Map<number, string>();
  const git = new GitService();
  const rows: Record<string, unknown>[] = [];
  for (const files of SCALES) {
    const repo = makeRepo(files);
    repos.set(files, repo);
    let done = 0;
    for (const want of STATES) {
      if (want > files) break;
      dirty(repo, done, want);
      done = want;
      if (want === 0) rows.push(await touchedState(repo, files));
      const totals: number[] = [];
      const stalls: number[] = [];
      let size = 0;
      let error: string | null = null;
      for (let r = 0; r < 3; r++) {
        const h = monitorEventLoopDelay({ resolution: 1 });
        h.enable();
        const [ms, got] = await timeAsync(() =>
          git.diff(repo).then(
            (v) => ({ ok: true as const, v }),
            (e: unknown) => ({ ok: false as const, e })
          )
        );
        h.disable();
        totals.push(ms);
        stalls.push(h.max / 1e6);
        if (got.ok) size = got.v.text.length;
        else error = String(got.e);
      }
      // The invocations separately, once, to see whether process spawn or the
      // diff itself is where the time goes — and porcelain `diff` beside
      // plumbing `diff-index`, the swap #772 made, on the same tree.
      const parts = [
        round(await gitTimed(repo, ['rev-parse', '--is-inside-work-tree'])),
        round(await gitTimed(repo, ['rev-parse', '--verify', '-q', 'HEAD'])),
        round(await gitTimed(repo, ['diff', '--no-textconv', '--no-ext-diff', 'HEAD'])),
        round(await gitTimed(repo, PLUMBING)),
      ];
      const row = {
        files,
        dirtyFiles: want,
        diffChars: size,
        error,
        firstMs: round(totals[0]),
        medianMs: round(median(totals)),
        maxMs: round(Math.max(...totals)),
        worstLoopStallMs: round(Math.max(...stalls)),
        partsMs: parts,
      };
      rows.push(row);
      say(
        `B: ${String(files).padStart(6)} files, ${String(want).padStart(5)} dirty → ${error ? 'THREW' : mb(size).padStart(9)}  ` +
          `first ${row.firstMs}ms  median ${row.medianMs}  max ${row.maxMs}  loop stall ${row.worstLoopStallMs}  parts ${parts.join(' / ')}`
      );
    }
  }
  results.git = rows;
  return repos;
}

// ── C. THE HOST UNDER A BURST ───────────────────────────────────────────────

/** A 1 ms heartbeat. Its longest gap is how long the loop could not run it. */
function heartbeat(): () => { maxGapMs: number; gapsOver50: number; stalledMs: number } {
  const gaps: number[] = [];
  let last = performance.now();
  const t = setInterval(() => {
    const now = performance.now();
    gaps.push(now - last);
    last = now;
  }, 1);
  return () => {
    clearInterval(t);
    const now = performance.now();
    gaps.push(now - last);
    const over = gaps.filter((g) => g > 50);
    return {
      maxGapMs: round(Math.max(...gaps)),
      gapsOver50: over.length,
      stalledMs: round(over.reduce((a, g) => a + g, 0)),
    };
  };
}

function fire(pipePath: string, tokenPath: string, op: string, ref: string, n: number): Promise<{ ms: number; ok: boolean; reason?: string }[]> {
  return new Promise((resolve, reject) => {
    // Plain `node`, not this process's execPath: under Electron-as-node the
    // child would need the env var too, and the client is not what is measured.
    const child = spawn('node', [path.join(PROBE_DIR, 'fire.mjs'), pipePath, tokenPath, op, ref, String(n)], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d: string) => (out += d));
    child.on('exit', () => {
      try {
        resolve(JSON.parse(out.trim()));
      } catch (err) {
        reject(new Error(`fire.mjs printed nothing readable: ${out} ${String(err)}`));
      }
    });
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function partC(transcript: Transcript, diffRepo: string | null): Promise<void> {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-772-host-'));
  const sessions: SessionSummary[] = [
    { id: 'sb-caller', name: 'Caller', folder: '', providerId: 'claude-code', status: 'working', exited: false },
    { id: 'sb-out', name: 'Talker', folder: '', providerId: 'claude-code', status: 'idle', exited: false },
    { id: 'sb-diff', name: 'Editor', folder: diffRepo ?? '', providerId: 'claude-code', status: 'idle', exited: false },
  ];
  const queries = new SessionQueries({
    list: () => sessions,
    transcriptFor: (id) => (id === 'sb-out' ? transcript.file : null),
    git: new GitService(),
  });
  const delivery: BusDelivery = { send: async () => ({ ok: false, reason: 'not part of this probe' }) };
  const host = new BusHost({ stateDir, queries, delivery, log: quietLog });
  const ep = await host.registerSession('sb-caller');

  // Calibrate: what does the heartbeat see with NOTHING happening? On Windows
  // a 1 ms interval does not fire every millisecond, and without this number
  // the gaps below have no floor to be read against.
  const idle = heartbeat();
  await sleep(1000);
  const baseline = idle();
  say(`C: idle heartbeat — max gap ${baseline.maxGapMs}ms, ${baseline.gapsOver50} gaps over 50ms`);

  const rows: Record<string, unknown>[] = [];
  const cases: [string, string][] = [['get_session_output', 'sb-out']];
  if (diffRepo) cases.push(['get_session_diff', 'sb-diff']);
  for (const [op, ref] of cases) {
    for (const n of [1, 4, 16]) {
      const beat = heartbeat();
      const t0 = performance.now();
      const replies = await fire(ep.pipePath, ep.tokenPath, op, ref, n);
      const wall = performance.now() - t0;
      await sleep(50);
      const loop = beat();
      const lat = replies.map((r) => r.ms);
      const row = {
        op,
        n,
        ok: replies.filter((r) => r.ok).length,
        refused: replies.filter((r) => !r.ok).map((r) => r.reason),
        latencyMinMs: Math.min(...lat),
        latencyMedianMs: median(lat),
        latencyMaxMs: Math.max(...lat),
        burstWallMs: round(wall),
        hostMaxGapMs: loop.maxGapMs,
        hostGapsOver50: loop.gapsOver50,
        hostStalledMs: loop.stalledMs,
      };
      rows.push(row);
      say(
        `C: ${op.padEnd(19)} n=${String(n).padStart(2)}  ok ${row.ok}/${n}  latency ${row.latencyMinMs}/${row.latencyMedianMs}/${row.latencyMaxMs}ms (min/med/max)  ` +
          `host max gap ${row.hostMaxGapMs}ms, ${row.hostGapsOver50} gaps >50ms totalling ${row.hostStalledMs}ms`
      );
      if (row.refused.length) say(`C:   refusals: ${[...new Set(row.refused)].join(' | ')}`);
      await sleep(300);
    }
  }
  results.host = { transcriptSize: transcript.size, diffRepo: diffRepo ? path.basename(diffRepo) : null, baseline, rows };
  host.stop();
  fs.rmSync(stateDir, { recursive: true, force: true });
}

// ── MAIN ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  say(`runtime: node ${process.versions.node}${process.versions.electron ? `, electron ${process.versions.electron}` : ''} on ${results.platform}, ${results.ncpu}× ${results.cpu}`);
  const all = PARTS.has('A') || PARTS.has('C') ? (PARTS.has('A') ? partA() : realTranscripts()) : [];
  const repos = PARTS.has('B') || PARTS.has('C') ? await partB() : new Map<number, string>();
  if (PARTS.has('C')) {
    // The mid scale at its largest SUCCESSFUL state — a heavy diff that still
    // answers, which is what a burst of real answers costs.
    const mid = SCALES.length > 1 ? SCALES[1] : SCALES[0];
    const repo = repos.get(mid) ?? null;
    if (repo) {
      // Back off to the 10 MB state if the last one pushed past maxBuffer.
      const last = STATES.filter((s) => s <= mid).pop() ?? 0;
      if (last > 4000) {
        execFileSync('git', ['checkout', '--', '.'], { cwd: repo, env: hermetic });
        dirty(repo, 0, 4000);
      }
    }
    await partC(all[0], repo);
  }
  const tag = process.versions.electron ? `electron-${process.versions.electron}` : `node-${process.versions.node}`;
  // `PROBE_TAG` names the run — `before` / `after` the #772 change, so the
  // second does not overwrite the first.
  const out = path.join(PROBE_DIR, 'artifacts', `${process.env.PROBE_TAG ?? 'run'}-${tag}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(results, null, 2) + '\n');
  say(`wrote ${path.relative(process.cwd(), out)}`);
  if (!KEEP) for (const repo of repos.values()) fs.rmSync(repo, { recursive: true, force: true, maxRetries: 3 });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
