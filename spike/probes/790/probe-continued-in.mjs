#!/usr/bin/env node
/**
 * Probe #790 — does the CLI actually write a `continued-in` line, and where
 * does the conversation go?
 *
 * The whole reason this probe exists: `continued-in` has **zero** occurrences
 * across this machine's ~3,300 transcripts, so its shape is known only from the
 * PATH binary's own factory:
 *
 *   function BXn(e,t){return{type:"continued-in",
 *     timestamp:new Date().toISOString(), sessionId:e, continuedInSessionId:t}}
 *
 * The binary names the trigger `repl_background_fork` — backgrounding the
 * conversation you are in. `--bg` with `--resume` is the same family and is the
 * only variant reachable without driving a TUI keypress, so that is what runs
 * here; the `left_arrow` REPL path stays UNMEASURED and the findings note says
 * so rather than claiming the two are equivalent.
 *
 * Questions, in order:
 *   Q1 does `claude --resume <id> --bg` write a `continued-in` line into the
 *      PARENT transcript, and is the on-disk shape the factory's four fields?
 *   Q2 is the successor transcript in the SAME project dir, named by the
 *      successor id?
 *   Q3 does the parent file keep growing AFTER the record? (a record mid-file
 *      with live appends after it would make a rebind destructive)
 *   Q4 does the parent's `continued-in` point at a file that actually exists?
 *
 * CONTAINMENT (#760 §8: a cwd is not a sandbox). Both turns run with the
 * default permission mode and a prompt that needs no tools, because the real
 * containment is not giving the turn a reason to act — not the directory it
 * runs in. The probe spawns background sessions and STOPS + REMOVES every one
 * it created, including on failure.
 *
 * Costs two trivial turns.
 *
 *   node spike/probes/790/probe-continued-in.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, readdirSync, statSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

// Node 22 cannot `spawn` a `.cmd` (EINVAL, the CVE-2024-27980 fix) and PATH
// here holds only `claude.cmd`, so resolve past the shim — #760 §7 paid for
// this one already.
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

/** `~/.claude/projects/<mangled-cwd>` — the CLI's per-project transcript dir. */
function projectDir(cwd) {
  const root = join(homedir(), '.claude', 'projects');
  if (!existsSync(root)) return null;
  // The CLI mangles the cwd into the directory name; rather than re-deriving
  // that rule (which is exactly the kind of guess this repo keeps paying for),
  // find the dir that CONTAINS our known session id.
  return root;
}

function findTranscript(sessionId) {
  const root = projectDir();
  if (!root) return null;
  for (const d of readdirSync(root)) {
    const f = join(root, d, `${sessionId}.jsonl`);
    if (existsSync(f)) return f;
  }
  return null;
}

function readLines(file) {
  if (!existsSync(file)) return [];
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

const created = [];

async function cleanup() {
  for (const id of created) {
    await run(['stop', id], { timeoutMs: 30_000 });
    await run(['rm', id], { timeoutMs: 30_000 });
  }
}

async function main() {
  const scratch = mkdtempSync(join(tmpdir(), 'sb790-'));
  const parentId = randomUUID();
  const findings = {};

  console.log(`cli      ${CLI}`);
  console.log(`scratch  ${scratch}`);
  console.log(`parentId ${parentId}`);

  // ── seed a real parent conversation ───────────────────────────────────────
  const seed = await run(
    ['-p', 'Reply with the single word: seeded.', '--session-id', parentId],
    { cwd: scratch }
  );
  console.log(`\n[seed] exit=${seed.code} out=${JSON.stringify(seed.out.trim().slice(0, 120))}`);
  if (seed.err.trim()) console.log(`[seed] err=${seed.err.trim().slice(0, 300)}`);

  const parentFile = findTranscript(parentId);
  findings.parentFile = parentFile;
  if (!parentFile) {
    console.log('\n❌ ABORT: no transcript written for the seeded session — nothing to measure.');
    console.log('   Q1-Q4 render NO VERDICT rather than a false negative (#760 §2).');
    return findings;
  }
  console.log(`[seed] transcript ${parentFile}`);

  const before = readLines(parentFile);
  const beforeSize = statSync(parentFile).size;
  console.log(`[seed] ${before.length} lines, ${beforeSize} bytes`);

  // ── background-continue it ────────────────────────────────────────────────
  const bg = await run(['--resume', parentId, '--bg'], { cwd: scratch, timeoutMs: 120_000 });
  console.log(`\n[bg] exit=${bg.code}`);
  console.log(`[bg] out=${JSON.stringify(bg.out.trim().slice(0, 400))}`);
  if (bg.err.trim()) console.log(`[bg] err=${JSON.stringify(bg.err.trim().slice(0, 400))}`);

  // `--bg` prints the SHORT id that `attach`/`stop`/`rm` take.
  const shortId = (bg.out.match(/\b([0-9a-f]{6,12})\b/) ?? [])[1];
  if (shortId) created.push(shortId);
  findings.shortIdPrinted = shortId ?? null;

  // Give the write a moment — the record is written with `onlyIfExists` on a
  // path the CLI may not reach synchronously.
  await new Promise((r) => setTimeout(r, 4000));

  // ── Q1 ────────────────────────────────────────────────────────────────────
  const after = readLines(parentFile);
  const recs = after.filter((l) => l.type === 'continued-in');
  findings.q1_written = recs.length > 0;
  findings.q1_records = recs;
  console.log(`\nQ1 continued-in lines in the parent: ${recs.length}`);
  for (const r of recs) console.log(`   ${JSON.stringify(r)}`);
  if (recs.length) {
    const keys = Object.keys(recs[0]).sort();
    findings.q1_keys = keys;
    // The factory's four, verified as a SET rather than by substring — #760 §7:
    // a verdict computed by substring can pass on the wrong evidence.
    const expected = ['continuedInSessionId', 'sessionId', 'timestamp', 'type'];
    findings.q1_shapeMatchesFactory = expected.every((k) => keys.includes(k));
    console.log(`   keys: ${keys.join(', ')}`);
    console.log(`   factory shape present: ${findings.q1_shapeMatchesFactory}`);
  }

  // ── Q3: did the parent keep growing after the record? ─────────────────────
  const idx = after.findIndex((l) => l.type === 'continued-in');
  findings.q3_linesAfterRecord = idx === -1 ? null : after.length - idx - 1;
  findings.q3_recordIsLastLine = idx !== -1 && idx === after.length - 1;
  console.log(
    `\nQ3 lines after the record: ${findings.q3_linesAfterRecord} (last line: ${findings.q3_recordIsLastLine})`
  );
  await new Promise((r) => setTimeout(r, 6000));
  const later = readLines(parentFile);
  findings.q3_grewAfterwards = later.length > after.length;
  console.log(`   parent grew during a further 6s: ${findings.q3_grewAfterwards} (${after.length} → ${later.length})`);

  // ── Q2 + Q4: the successor ────────────────────────────────────────────────
  const successor = recs.length ? recs[recs.length - 1].continuedInSessionId : null;
  findings.q2_successorId = successor;
  if (successor) {
    const sFile = findTranscript(successor);
    findings.q4_successorFile = sFile;
    findings.q4_successorExists = Boolean(sFile);
    findings.q2_sameDir =
      sFile && parentFile ? resolve(sFile, '..') === resolve(parentFile, '..') : null;
    console.log(`\nQ2/Q4 successor ${successor}`);
    console.log(`   file:      ${sFile ?? '(not found)'}`);
    console.log(`   same dir:  ${findings.q2_sameDir}`);
    findings.q2_successorIsParentId = successor === parentId;
    console.log(`   equals the parent id: ${findings.q2_successorIsParentId}`);
  } else {
    console.log('\nQ2/Q4 NO VERDICT — no record to follow.');
  }

  rmSync(scratch, { recursive: true, force: true });
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
