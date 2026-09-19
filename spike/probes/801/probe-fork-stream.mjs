#!/usr/bin/env node
/**
 * Probe #801 round 2 — the same fork, under the transport the app ACTUALLY uses.
 *
 * WHY THERE IS A ROUND 2. Round 1 (`probe-fork-adopt.mjs`) drove `-p`, the
 * headless print mode. That is not how switchboard spawns a session: Direct is
 * the default transport and `providers/claude.ts` spawns with the full duplex
 * stream-json flag list. Shipping Level 3 on a measurement taken in a mode the
 * product does not use would be exactly the gap `docs/reference-implementations.md`
 * exists to close — "their behaviour is not our guarantee", one layer in.
 *
 * THE FLAG LIST IS COPIED FROM `providers/claude.ts:485-503`, not reconstructed,
 * so what this measures is the recipe the app really builds — plus the three
 * flags Level 3 would add.
 *
 * THE QUESTIONS
 *   S1  Does the fork work at all on stream-json? (does a turn complete)
 *   S2  Does `system:init` announce OUR `--session-id`? The app binds the card
 *       to the id the CLI announces, so if the fork announced the PARENT's id
 *       the card would bind to A's transcript and two cards would tail one file.
 *   S3  Does the forked session carry A's history?
 *   S4  Is A's transcript byte-identical afterwards?
 *   S5  Where does the forked transcript land?
 *   S6  Does anything arrive on the control channel we would have to answer?
 *       (the prompt needs no tools, so `can_use_tool` should never fire)
 *
 * S2 is the one that decides whether the feature is safe. Everything else could
 * be right and a wrong id there would quietly point two cards at one conversation
 * — the failure `#484` and `#539` are both about.
 *
 * COST: one seeding turn plus one forked turn. CONTAINMENT per #760 §8:
 * `--permission-mode default`, a prompt that needs no tools, no `--bg`, and
 * every transcript this run creates is deleted at the end.
 *
 *   node spike/probes/801/probe-fork-stream.mjs
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

/** EXACTLY the list `providers/claude.ts` pushes for `transport === 'stream'`. */
const STREAM_FLAGS = [
  '--output-format', 'stream-json',
  '--verbose',
  '--input-format', 'stream-json',
  '--permission-prompt-tool', 'stdio',
  '--replay-user-messages',
  '--include-partial-messages',
];

const minted = new Set();
function mint() {
  const id = randomUUID();
  minted.add(id);
  return id;
}

function findTranscript(sessionId) {
  if (!existsSync(PROJECTS)) return null;
  for (const d of readdirSync(PROJECTS)) {
    const f = join(PROJECTS, d, `${sessionId}.jsonl`);
    if (existsSync(f)) return f;
  }
  return null;
}

function fingerprint(file) {
  if (!file || !existsSync(file)) return null;
  const st = statSync(file);
  return {
    sha256: createHash('sha256').update(readFileSync(file)).digest('hex'),
    size: st.size,
    mtimeMs: st.mtimeMs,
  };
}

function runPrint(args, cwd) {
  return new Promise((res) => {
    const p = spawn(CLI, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    const t = setTimeout(() => p.kill(), 180_000);
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

/**
 * Drive one stream-json session and collect everything it says.
 *
 * The 500 ms delay before the first write is LOAD-BEARING and not politeness:
 * #760 measured that a frame written to stdin at t=0 is silently lost, and it
 * cost that item a confident false negative. Every 721 probe waits and none of
 * them says why; this one says why.
 */
function runStream(args, cwd, prompt, { timeoutMs = 240_000 } = {}) {
  return new Promise((res) => {
    const started = Date.now();
    const child = spawn(CLI, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    const frames = [];
    const controlRequests = [];
    let init = null;
    let result = null;
    let assistantText = '';
    let buf = '';
    let err = '';
    let done = false;

    const finish = (why) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      res({
        why,
        frames,
        init,
        result,
        assistantText,
        controlRequests,
        err,
        ms: Date.now() - started,
        timedOut: why === 'timeout',
      });
    };

    const timer = setTimeout(() => finish('timeout'), timeoutMs);

    child.stdout.on('data', (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          frames.push({ __unparseable: line.slice(0, 200) });
          continue;
        }
        frames.push(msg);
        if (msg.type === 'system' && msg.subtype === 'init') init ??= msg;
        // S6 — anything the CLI wants US to answer.
        if (msg.type === 'control_request') controlRequests.push(msg);
        if (msg.type === 'assistant' && msg.message?.content) {
          for (const b of msg.message.content) {
            if (b?.type === 'text' && typeof b.text === 'string') assistantText += b.text;
          }
        }
        if (msg.type === 'result') {
          result = msg;
          finish('result');
        }
      }
    });
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => {
      err += String(e);
      finish('spawn-error');
    });
    child.on('close', () => finish('closed'));

    setTimeout(() => {
      if (done) return;
      const frame = {
        type: 'user',
        uuid: randomUUID(),
        message: { role: 'user', content: [{ type: 'text', text: prompt }] },
        parent_tool_use_id: null,
        session_id: '',
        origin: { kind: 'human' },
      };
      try {
        child.stdin.write(JSON.stringify(frame) + '\n');
      } catch (e) {
        err += `stdin write failed: ${e}`;
      }
    }, 500);
  });
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
  const CODEWORD = `SBSTREAM-${RUN}`;
  const findings = { cli: CLI, run: RUN, codeword: CODEWORD, streamFlags: STREAM_FLAGS };

  const folderA = mkdtempSync(join(tmpdir(), 'sb801s-A-'));
  const folderB = mkdtempSync(join(tmpdir(), 'sb801s-B-'));
  const idA = mint();
  const forkId = mint();

  console.log(`cli      ${CLI}`);
  console.log(`folderA  ${folderA}`);
  console.log(`folderB  ${folderB}`);
  console.log(`idA      ${idA}`);
  console.log(`forkId   ${forkId}   <- what --session-id asks for`);
  console.log(`codeword ${CODEWORD}\n`);

  // ── SEED (cheap `-p`; only the FORK's transport is under test) ───────────
  const seed = await runPrint(
    [
      '-p',
      `Remember this codeword: ${CODEWORD}. Reply with the single word: seeded.`,
      '--session-id', idA,
      '--permission-mode', 'default',
    ],
    folderA
  );
  console.log(`[seed] exit=${seed.code} out=${JSON.stringify(seed.out.trim().slice(0, 80))}`);
  const fileA = findTranscript(idA);
  if (!fileA) {
    console.log('❌ ABORT: no transcript for A.');
    findings.abort = 'no seed transcript';
    return findings;
  }
  // s-09: assert the input ARRIVED before reading any verdict out of it.
  const seedCarries = readFileSync(fileA, 'utf8').includes(CODEWORD);
  const beforeA = fingerprint(fileA);
  findings.seed = { exit: seed.code, file: fileA, carriesCodeword: seedCarries, before: beforeA };
  console.log(`[seed] file=${fileA}`);
  console.log(`[seed] codeword in transcript: ${seedCarries}`);
  console.log(`[seed] sha=${beforeA.sha256.slice(0, 16)}…\n`);
  if (!seedCarries) {
    console.log('❌ ABORT: codeword not in A — a fork could not read it either.');
    findings.abort = 'seed did not carry the codeword';
    return findings;
  }

  // ── THE FORK, ON THE REAL TRANSPORT, FROM THE OTHER FOLDER ───────────────
  const args = [
    ...STREAM_FLAGS,
    '--resume', idA,
    '--fork-session',
    '--session-id', forkId,
    '--permission-mode', 'default',
  ];
  console.log('── stream fork (cross-folder, by id — round 1 variant C, real transport)');
  console.log(`   cwd  ${folderB}`);
  console.log(`   argv ${args.join(' ')}\n`);

  const r = await runStream(
    args,
    folderB,
    'What codeword were you told earlier? Reply with only the codeword and nothing else.'
  );

  const afterA = fingerprint(fileA);
  const forkFile = findTranscript(forkId);
  const announced = r.init?.session_id ?? null;

  findings.stream = {
    why: r.why,
    ms: r.ms,
    timedOut: r.timedOut,
    frameCount: r.frames.length,
    frameTypes: [...new Set(r.frames.map((f) => `${f.type}${f.subtype ? ':' + f.subtype : ''}`))],
    // S1
    completed: Boolean(r.result),
    resultSubtype: r.result?.subtype ?? null,
    // S2 — THE ONE THAT DECIDES SAFETY
    requestedForkId: forkId,
    announcedSessionId: announced,
    announcedMatchesRequest: announced === forkId,
    announcedIsParent: announced === idA,
    // S3
    assistantText: r.assistantText.trim().slice(0, 300),
    carriedHistory: r.assistantText.includes(CODEWORD),
    // S4
    parentUntouched: afterA?.sha256 === beforeA.sha256 && afterA?.size === beforeA.size,
    parentAfter: afterA,
    // S5
    forkFile,
    forkDir: forkFile ? resolve(dirname(forkFile)) : null,
    forkDirIsTargetCwd: forkFile
      ? resolve(dirname(forkFile)).toLowerCase() ===
        resolve(join(PROJECTS, folderB.replace(/[\\/:. ]/g, '-'))).toLowerCase()
      : null,
    // S6
    controlRequestCount: r.controlRequests.length,
    controlRequestSubtypes: r.controlRequests.map((c) => c.request?.subtype ?? '(none)'),
    stderr: r.err.trim().slice(0, 400),
  };

  const s = findings.stream;
  console.log(`   finished via:            ${r.why} (${r.ms} ms)`);
  console.log(`   frame types:             ${s.frameTypes.join(', ')}`);
  console.log(`   turn completed:          ${s.completed} (${s.resultSubtype})`);
  console.log(`   system:init session_id:  ${announced}`);
  console.log(`   ...matches --session-id: ${s.announcedMatchesRequest}`);
  console.log(`   ...is the PARENT's id:   ${s.announcedIsParent}   <- must be false`);
  console.log(`   assistant said:          ${JSON.stringify(s.assistantText.slice(0, 120))}`);
  console.log(`   carried A's history:     ${s.carriedHistory}`);
  console.log(`   A byte-identical:        ${s.parentUntouched}`);
  console.log(`   fork transcript:         ${forkFile ?? '(not found)'}`);
  console.log(`   landed in target cwd:    ${s.forkDirIsTargetCwd}`);
  console.log(`   control requests:        ${s.controlRequestCount} ${s.controlRequestSubtypes.join(',')}`);
  if (s.stderr) console.log(`   stderr: ${JSON.stringify(s.stderr.slice(0, 200))}`);

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
