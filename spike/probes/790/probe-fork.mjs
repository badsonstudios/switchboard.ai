#!/usr/bin/env node
/**
 * Probe #790, round 2 — round 1 asked the wrong question, and its answer says so.
 *
 * Round 1 ran `claude --resume <id> --bg` against an IDLE session and got zero
 * `continued-in` lines. That is not "the CLI does not write them": the CLI's own
 * output explains it —
 *
 *     backgrounded · 7b6d4e3c (idle — send a prompt to start)
 *
 * — the SAME short id the parent had. `--help` says so outright: with `--resume`,
 * `--bg` "continues that session in the background **under the same ID**, or
 * starts a copy and says so when the session is already running". No new id means
 * no successor to name, so there is nothing for a `continued-in` record to say.
 *
 * The binary writes the record from the branch that mints a NEW id
 * (`Fur({forkSessionId})`, and the `repl_background_fork` telemetry beside it),
 * so this round drives the CLI down that branch three ways:
 *
 *   A  --resume <id> --bg --fork-session     explicit new id
 *   B  --resume <id> --bg  while the session is ALREADY RUNNING in the
 *      background   → the documented "starts a copy" case
 *   C  --resume <id> --fork-session -p …     a foreground fork, as the control
 *      that says whether the record belongs to backgrounding or to forking
 *
 * C is what keeps this honest. Without it, a hit on A would not distinguish
 * "the CLI writes this when the conversation moves" from "the CLI writes this
 * when it forks", and those imply different watcher behaviour (#790's rebind is
 * only correct for the first).
 *
 * The `left_arrow` REPL path stays UNMEASURED — it needs a TUI keypress — and
 * the findings note says so rather than calling these equivalent.
 *
 * COST: one seeding turn, plus one turn for variant C. Backgrounding an idle
 * session spends nothing (round 1 measured that: "idle — send a prompt to
 * start"). CONTAINMENT per #760 §8: default permission mode, prompts that need
 * no tools, and every background session this creates is stopped and removed.
 *
 *   node spike/probes/790/probe-fork.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

function resolveCli() {
  const home = homedir();
  const candidates =
    process.platform === 'win32'
      ? [join(home, 'AppData/Roaming/npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe')]
      : [join(home, '.local/bin/claude'), '/usr/local/bin/claude'];
  for (const c of candidates) if (existsSync(c)) return c;
  return 'claude';
}
const CLI = resolveCli();

function run(args, opts = {}) {
  return new Promise((res) => {
    const p = spawn(CLI, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    const t = setTimeout(() => p.kill(), opts.timeoutMs ?? 180_000);
    p.on('close', (code) => {
      clearTimeout(t);
      res({ code, out, err });
    });
    p.on('error', (e) => {
      clearTimeout(t);
      res({ code: null, out, err: String(e) });
    });
  });
}

const PROJECTS = join(homedir(), '.claude', 'projects');

function findTranscript(sessionId) {
  if (!existsSync(PROJECTS)) return null;
  for (const d of readdirSync(PROJECTS)) {
    const f = join(PROJECTS, d, `${sessionId}.jsonl`);
    if (existsSync(f)) return f;
  }
  return null;
}

function readLines(file) {
  if (!file || !existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return { __malformed: true };
      }
    });
}

function records(file) {
  return readLines(file).filter((l) => l.type === 'continued-in');
}

const created = new Set();
function noteShortIds(out) {
  for (const m of out.matchAll(/\b([0-9a-f]{8})\b/g)) created.add(m[1]);
}

async function cleanup() {
  for (const id of created) {
    await run(['stop', id], { timeoutMs: 30_000 });
    await run(['rm', id], { timeoutMs: 30_000 });
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const findings = { cli: CLI, variants: {} };
  const scratch = mkdtempSync(join(tmpdir(), 'sb790b-'));
  const parentId = randomUUID();
  console.log(`cli      ${CLI}`);
  console.log(`scratch  ${scratch}`);
  console.log(`parentId ${parentId}\n`);

  const seed = await run(['-p', 'Reply with the single word: seeded.', '--session-id', parentId], {
    cwd: scratch,
  });
  console.log(`[seed] exit=${seed.code} out=${JSON.stringify(seed.out.trim().slice(0, 80))}`);
  const parentFile = findTranscript(parentId);
  findings.parentFile = parentFile;
  if (!parentFile) {
    console.log('❌ ABORT: no parent transcript — every variant renders NO VERDICT.');
    return findings;
  }
  const baseline = records(parentFile).length;
  findings.baselineRecords = baseline;
  console.log(`[seed] ${readLines(parentFile).length} lines, ${baseline} continued-in records\n`);

  async function variant(key, label, args, opts = {}) {
    console.log(`── ${key}: ${label}`);
    console.log(`   ${args.join(' ')}`);
    const r = await run(args, { cwd: scratch, timeoutMs: opts.timeoutMs ?? 180_000 });
    noteShortIds(r.out);
    console.log(`   exit=${r.code}`);
    console.log(`   out=${JSON.stringify(r.out.trim().slice(0, 300))}`);
    if (r.err.trim()) console.log(`   err=${JSON.stringify(r.err.trim().slice(0, 200))}`);
    await sleep(5000);
    const recs = records(parentFile);
    const gained = recs.length - baseline;
    console.log(`   continued-in records in the parent: ${recs.length} (baseline ${baseline})`);
    for (const rec of recs) console.log(`     ${JSON.stringify(rec)}`);
    findings.variants[key] = {
      label,
      args,
      exit: r.code,
      out: r.out.trim().slice(0, 400),
      recordsNow: recs.length,
      gained,
      records: recs,
    };
    console.log('');
    return recs;
  }

  // A — explicit new id
  await variant('A', 'background fork (explicit new id)', [
    '--resume',
    parentId,
    '--bg',
    '--fork-session',
  ]);

  // B — the documented "starts a copy" case: background it first (same id, no
  // record — round 1 measured that), THEN ask again while it is running.
  console.log('── B: prime — background under the same id first');
  const prime = await run(['--resume', parentId, '--bg'], { cwd: scratch, timeoutMs: 120_000 });
  noteShortIds(prime.out);
  console.log(`   out=${JSON.stringify(prime.out.trim().slice(0, 200))}\n`);
  await sleep(3000);
  await variant('B', 'resume --bg while already running (the documented copy)', [
    '--resume',
    parentId,
    '--bg',
  ]);

  // C — the CONTROL: a foreground fork. Distinguishes "written when the
  // conversation MOVES" from "written whenever it forks".
  const finalRecs = await variant(
    'C',
    'CONTROL — foreground fork, no backgrounding',
    ['--resume', parentId, '--fork-session', '-p', 'Reply with the single word: forked.'],
    { timeoutMs: 240_000 }
  );

  // Follow the successor, if any variant produced one.
  if (finalRecs.length) {
    const last = finalRecs[finalRecs.length - 1];
    const succ = last.continuedInSessionId;
    const sFile = findTranscript(succ);
    findings.successor = {
      id: succ,
      file: sFile,
      exists: Boolean(sFile),
      sameDir: sFile ? resolve(sFile, '..') === resolve(parentFile, '..') : null,
      equalsParent: succ === parentId,
      keys: Object.keys(last).sort(),
      shapeMatchesFactory: ['continuedInSessionId', 'sessionId', 'timestamp', 'type'].every((k) =>
        Object.keys(last).includes(k)
      ),
    };
    console.log(`── successor ${succ}`);
    console.log(`   file:     ${sFile ?? '(not found)'}`);
    console.log(`   same dir: ${findings.successor.sameDir}`);
    console.log(`   keys:     ${findings.successor.keys.join(', ')}`);
    console.log(`   factory shape present: ${findings.successor.shapeMatchesFactory}`);

    // Is the record the LAST line, or does the parent keep growing? #790's
    // rebind is destructive if the parent is still live after it.
    const all = readLines(parentFile);
    const idx = all.findIndex((l) => l.type === 'continued-in');
    findings.linesAfterRecord = all.length - idx - 1;
    findings.recordIsLastLine = idx === all.length - 1;
    console.log(`   lines after the record: ${findings.linesAfterRecord}`);
  } else {
    console.log('── no variant produced a record — NO VERDICT on the successor.');
  }

  // EBUSY here is expected on Windows while a background session holds the cwd
  // (round 1 threw on it and swallowed its own findings). Non-fatal by design.
  try {
    rmSync(scratch, { recursive: true, force: true });
  } catch (e) {
    console.log(`   (scratch not removed: ${e.code ?? e})`);
  }
  return findings;
}

main()
  .then(async (f) => {
    await cleanup();
    console.log(`\n${'='.repeat(60)}\nFINDINGS\n${JSON.stringify(f, null, 2)}`);
  })
  .catch(async (e) => {
    await cleanup();
    console.error('probe failed:', e);
    process.exitCode = 1;
  });
