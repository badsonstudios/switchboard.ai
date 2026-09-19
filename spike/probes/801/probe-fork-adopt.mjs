#!/usr/bin/env node
/**
 * Probe #801 — Level 3 fork adoption: what `--fork-session` actually does, and
 * whether the cross-folder case needs us to write a file into the CLI's own
 * directory at all.
 *
 * WHY THIS PROBE EXISTS. DESIGN §5.5 says the cross-folder variant should "copy
 * A's transcript into the target project's transcript dir, then fork-resume
 * there". Reading the PATH binary says that may be unnecessary: the CLI's main
 * resume branch has a FILE form —
 *
 *     if (pS() || (typeof v.resume === "string" && fse(v.resume))) { …
 *         if (fse(v.resume)) {                      // fse = ends with ".jsonl"
 *           let le = Hn(Ya(v.resume, ".jsonl"));    // expected id from FILENAME
 *           let Ue = await $tt(v.resume, ie);       // load transcript FROM FILE
 *           let Je = await jX(Ue, …, { forkSession, expectedSessionId: le });
 *
 * — with its own telemetry entrypoint (`entrypoint:"file"`, distinct from
 * `"cli_flag"`), its own error (`Unable to load transcript from file: …`) and
 * its own log line (`--resume file unreadable`). If that form works from argv,
 * switchboard never writes into `~/.claude/projects` and the riskiest line in
 * the ticket disappears.
 *
 * READING IS NOT MEASURING. #801's done-when says the file must be "verified to
 * be the file the CLI then reads, not assumed", so this drives the real CLI.
 *
 * THE QUESTIONS
 *   Q1  same-folder fork: does `--resume <id> --fork-session` carry A's history?
 *   Q2  is A's transcript BYTE-IDENTICAL afterwards? (the damaging failure is
 *       "fork" degrading to "resume in place", which appends to A)
 *   Q3  cross-folder BY PATH from folder B: does it carry A's history?
 *   Q4  where does the forked transcript LAND — B's project dir or A's?
 *   Q5  does `--session-id <uuid>` pin the forked id, so we know it in advance?
 *   Q6  CONTROL — cross-folder BY ID from folder B. If this works, the path form
 *       was never needed and Q3's success proves less than it appears to.
 *   Q7  failure modes: a missing file, and an id the CLI does not know. Readable
 *       refusal, non-zero exit, and NOTHING HANGS.
 *
 * Q6 is what keeps this honest — the same role variant C played in #790.
 *
 * HOW HISTORY IS PROVEN. The seed turn tells A a codeword unique to this run.
 * Every fork is then asked to repeat it back. A fork that answers the codeword
 * read A's conversation; nothing else in the world knows that string. This is
 * the s-09 rule applied twice over: assert your input ARRIVED (the seed's own
 * transcript is checked for the codeword) before reading any verdict out of it,
 * and bind every verdict to a per-run token rather than to a substring that
 * could match something else (#760).
 *
 * COST: one seeding turn plus one turn per fork variant that the CLI accepts —
 * four trivial one-word turns at most. The Q7 refusals cost nothing; they error
 * before a model call.
 *
 * CONTAINMENT (#760 §8 — "a cwd is not a sandbox"):
 *   - `--permission-mode default`, never bypassPermissions;
 *   - prompts that need no tools, so nothing has a reason to act;
 *   - FOREGROUND `-p` only, no `--bg`, so there are no background sessions to
 *     leak onto the owner's machine;
 *   - every transcript this probe causes is recorded and DELETED at the end —
 *     we only ever remove files whose ids this run minted.
 *
 *   node spike/probes/801/probe-fork-adopt.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

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
const PROJECTS = join(homedir(), '.claude', 'projects');

/** The app's own rule, re-derived here so the probe and the product agree. */
function slugForCwd(cwd) {
  return cwd.replace(/[\\/:. ]/g, '-');
}

function run(args, opts = {}) {
  return new Promise((res) => {
    const started = Date.now();
    const p = spawn(CLI, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    let timedOut = false;
    const t = setTimeout(() => {
      timedOut = true;
      p.kill();
    }, opts.timeoutMs ?? 180_000);
    p.on('close', (code) => {
      clearTimeout(t);
      res({ code, out, err, timedOut, ms: Date.now() - started });
    });
    p.on('error', (e) => {
      clearTimeout(t);
      res({ code: null, out, err: String(e), timedOut, ms: Date.now() - started });
    });
  });
}

function findTranscript(sessionId) {
  if (!existsSync(PROJECTS)) return null;
  for (const d of readdirSync(PROJECTS)) {
    const f = join(PROJECTS, d, `${sessionId}.jsonl`);
    if (existsSync(f)) return f;
  }
  return null;
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/** A file's full identity, so "unchanged" is a real claim and not just a size. */
function fingerprint(file) {
  if (!file || !existsSync(file)) return null;
  const st = statSync(file);
  return { sha256: sha256(file), size: st.size, mtimeMs: st.mtimeMs, lines: lines(file).length };
}

function lines(file) {
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

/** Which project directory a transcript sits in, as a slug we can compare. */
function dirOf(file) {
  return file ? resolve(dirname(file)) : null;
}

const minted = new Set();
function mint() {
  const id = randomUUID();
  minted.add(id);
  return id;
}

function cleanup(findings) {
  const removed = [];
  for (const id of minted) {
    const f = findTranscript(id);
    if (!f) continue;
    try {
      rmSync(f, { force: true });
      removed.push(f);
    } catch (e) {
      removed.push(`${f} (FAILED: ${e.code ?? e})`);
    }
  }
  findings.cleanup = { minted: [...minted], removed };
  console.log(`\n── cleanup: removed ${removed.length} transcript(s) this run created`);
  for (const r of removed) console.log(`   ${r}`);
}

async function main() {
  const RUN = randomUUID().slice(0, 8).toUpperCase();
  const CODEWORD = `SBFORK-${RUN}`;
  const ASK = `What codeword were you told earlier? Reply with only the codeword and nothing else.`;

  const findings = { cli: CLI, run: RUN, codeword: CODEWORD, variants: {} };

  const folderA = mkdtempSync(join(tmpdir(), 'sb801-A-'));
  const folderB = mkdtempSync(join(tmpdir(), 'sb801-B-'));
  const idA = mint();

  console.log(`cli      ${CLI}`);
  console.log(`folderA  ${folderA}`);
  console.log(`folderB  ${folderB}`);
  console.log(`idA      ${idA}`);
  console.log(`codeword ${CODEWORD}\n`);

  // ── SEED ────────────────────────────────────────────────────────────────
  // The codeword goes in as a plain instruction needing no tools.
  const seed = await run(
    [
      '-p',
      `Remember this codeword: ${CODEWORD}. Reply with the single word: seeded.`,
      '--session-id',
      idA,
      '--permission-mode',
      'default',
    ],
    { cwd: folderA }
  );
  console.log(`[seed] exit=${seed.code} ms=${seed.ms} out=${JSON.stringify(seed.out.trim().slice(0, 120))}`);

  const fileA = findTranscript(idA);
  findings.seed = { exit: seed.code, out: seed.out.trim().slice(0, 200), file: fileA };
  if (!fileA) {
    console.log('❌ ABORT: no transcript for A — every variant would render NO VERDICT.');
    findings.abort = 'no seed transcript';
    return findings;
  }

  // ASSERT THE INPUT ARRIVED before reading any verdict out of it (s-09).
  const seedCarriesCodeword = readFileSync(fileA, 'utf8').includes(CODEWORD);
  findings.seedCarriesCodeword = seedCarriesCodeword;
  const beforeA = fingerprint(fileA);
  findings.parent = { file: fileA, dir: dirOf(fileA), before: beforeA };
  console.log(`[seed] file=${fileA}`);
  console.log(`[seed] codeword present in transcript: ${seedCarriesCodeword}`);
  console.log(`[seed] sha=${beforeA.sha256.slice(0, 16)}… lines=${beforeA.lines}\n`);
  if (!seedCarriesCodeword) {
    console.log('❌ ABORT: the codeword is not in A\'s transcript — a fork could not read it either.');
    findings.abort = 'seed did not carry the codeword';
    return findings;
  }

  // ── a fork variant ──────────────────────────────────────────────────────
  async function fork(key, label, { cwd, resumeValue, useSessionId = true, timeoutMs = 240_000 }) {
    console.log(`── ${key}: ${label}`);
    const forkId = useSessionId ? mint() : null;
    const args = [
      '--resume',
      resumeValue,
      '--fork-session',
      ...(forkId ? ['--session-id', forkId] : []),
      '--permission-mode',
      'default',
      '-p',
      ASK,
    ];
    console.log(`   cwd  ${cwd}`);
    console.log(`   argv ${args.join(' ')}`);
    const r = await run(args, { cwd, timeoutMs });

    // The verdict is bound to THIS run's codeword, not to a generic substring.
    const carried = r.out.includes(CODEWORD);
    const afterA = fingerprint(fileA);
    const parentUntouched =
      afterA !== null && afterA.sha256 === beforeA.sha256 && afterA.size === beforeA.size;

    // Where did the fork's own transcript land?
    const forkFile = forkId ? findTranscript(forkId) : null;
    const forkDir = dirOf(forkFile);
    const forkLines = forkFile ? lines(forkFile) : [];
    const relocated = forkLines.filter((l) => l.type === 'relocated');

    const v = {
      label,
      cwd,
      argv: args,
      exit: r.code,
      ms: r.ms,
      timedOut: r.timedOut,
      out: r.out.trim().slice(0, 300),
      err: r.err.trim().slice(0, 300),
      // Q1/Q3 — did it carry A's history?
      carriedHistory: carried,
      // Q2 — is A byte-identical?
      parentUntouched,
      parentAfter: afterA,
      // Q5 — did --session-id pin the forked id?
      requestedForkId: forkId,
      forkTranscriptFound: Boolean(forkFile),
      // Q4 — which project directory did it land in?
      forkFile,
      forkDir,
      forkDirIsTargetCwd: forkDir
        ? resolve(forkDir).toLowerCase() === resolve(join(PROJECTS, slugForCwd(cwd))).toLowerCase()
        : null,
      forkDirIsParentDir: forkDir ? resolve(forkDir) === resolve(dirOf(fileA)) : null,
      // does the CLI stamp the moved cwd itself?
      relocatedRecords: relocated,
      forkLineCount: forkLines.length,
    };
    findings.variants[key] = v;

    console.log(`   exit=${r.code} ms=${r.ms}${r.timedOut ? ' TIMED OUT' : ''}`);
    console.log(`   out=${JSON.stringify(r.out.trim().slice(0, 200))}`);
    if (r.err.trim()) console.log(`   err=${JSON.stringify(r.err.trim().slice(0, 200))}`);
    console.log(`   carried A's history:   ${carried}`);
    console.log(`   A byte-identical:      ${parentUntouched}`);
    console.log(`   fork transcript:       ${forkFile ?? '(not found)'}`);
    console.log(`   landed in target cwd:  ${v.forkDirIsTargetCwd}`);
    console.log(`   landed in A's dir:     ${v.forkDirIsParentDir}`);
    console.log(`   relocated records:     ${relocated.length}`);
    for (const rec of relocated) console.log(`     ${JSON.stringify(rec)}`);
    console.log('');
    return v;
  }

  // Q1/Q2/Q5 — the simple case, in A's own folder, by id.
  await fork('A', 'same-folder fork by ID', { cwd: folderA, resumeValue: idA });

  // Q3/Q4 — the one that decides the design: from folder B, by PATH.
  await fork('B', 'CROSS-FOLDER fork by absolute .jsonl PATH', {
    cwd: folderB,
    resumeValue: fileA,
  });

  // Q6 — THE CONTROL. From folder B, by ID. If this also works, the path form
  // was never load-bearing and B's success proves less than it looks like.
  await fork('C', 'CONTROL — cross-folder fork by ID (no path)', {
    cwd: folderB,
    resumeValue: idA,
  });

  // ── Q7: failure modes. No turns — these refuse before a model call. ──────
  console.log('── Q7: failure modes (must refuse readably, must not hang)');
  const missingPath = join(dirOf(fileA), `${randomUUID()}.jsonl`);
  const unknownId = randomUUID(); // deliberately NOT minted — nothing to clean
  const failures = {};
  for (const [key, value, label] of [
    ['missingFile', missingPath, 'a .jsonl path that does not exist'],
    ['unknownId', unknownId, 'an id the CLI has never seen'],
  ]) {
    const r = await run(
      ['--resume', value, '--fork-session', '--permission-mode', 'default', '-p', 'hi'],
      { cwd: folderB, timeoutMs: 60_000 }
    );
    failures[key] = {
      label,
      value,
      exit: r.code,
      ms: r.ms,
      timedOut: r.timedOut,
      out: r.out.trim().slice(0, 300),
      err: r.err.trim().slice(0, 300),
      refused: r.code !== 0 && !r.timedOut,
    };
    console.log(`   ${key} (${label})`);
    console.log(`     exit=${r.code} ms=${r.ms}${r.timedOut ? ' TIMED OUT' : ''}`);
    console.log(`     out=${JSON.stringify(r.out.trim().slice(0, 180))}`);
    console.log(`     err=${JSON.stringify(r.err.trim().slice(0, 180))}`);
  }
  findings.failures = failures;

  // A's final word, after everything.
  findings.parent.after = fingerprint(fileA);
  findings.parentUntouchedThroughout =
    findings.parent.after?.sha256 === beforeA.sha256 && findings.parent.after?.size === beforeA.size;
  console.log(`\n── A byte-identical after ALL variants: ${findings.parentUntouchedThroughout}`);

  for (const dir of [folderA, folderB]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (e) {
      console.log(`   (scratch ${dir} not removed: ${e.code ?? e})`);
    }
  }
  return findings;
}

main()
  .then((f) => {
    cleanup(f);
    console.log(`\n${'='.repeat(60)}\nFINDINGS\n${JSON.stringify(f, null, 2)}`);
  })
  .catch((e) => {
    const f = {};
    cleanup(f);
    console.error('probe failed:', e);
    process.exitCode = 1;
  });
