// #1026 probe — what reaches our STREAM for a message the CLI marks "stored in
// the transcript but not rendered in the live UI", and how is it spelled?
//
// ---------------------------------------------------------------------------
// WHY THIS PROBE EXISTS
//
// #997 found two fields declared on the CLI's wire schema that nothing in
// `src/` reads in either spelling: `is_visible_in_transcript_only` and
// `is_virtual`. The ticket asks for a drop rule, and for a probe first.
//
// Reading the PATH binary (2.1.288) before spending a token changed the
// question. `is_visible_in_transcript_only` occurs TWICE in the whole binary:
// the schema, and a string table. No converter writes it. What the
// internal -> wire converter does write, for every `user` message, is
//
//   isSynthetic: e.isMeta || e.isVisibleInTranscriptOnly || e.isCompactSummary || undefined
//
// So on the wire the three internal flags are ONE field, in camelCase, and it
// is a field `src/` does not read either. And the only thing in the binary
// that SETS `isVisibleInTranscriptOnly: true` is a compaction: the summary
// that replaces the conversation ("This session is being continued from a
// previous conversation…") is built with `isCompactSummary: true,
// isVisibleInTranscriptOnly: true`.
//
// That is reading, not measuring. This measures it: one cheap turn, then
// `/compact`, then one more cheap turn, with switchboard's own flag list.
//
// ---------------------------------------------------------------------------
// WHAT IS REPORTED
//
//   * every `user` frame on the stream, with its flags and the head of its
//     text: is the summary sent at all, and what marks it;
//   * a census of every key matching /^is[_A-Z]/ on every frame, so a
//     spelling nobody predicted shows up as itself (#997's method);
//   * the same census over the transcript the session wrote, and the entry
//     that carries the summary.
//
// THE CONTROL TOKENS are the harness check: a silent result is otherwise
// indistinguishable from a broken probe (S-09, #978). Both must come back.
//
// Real CLI, three turns (two one-word replies and one compaction of a
// two-line conversation). No `--bg`: nothing survives the kill. Temp cwd
// removed at the end. Run `claude agents --json` before and after anyway.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TOKEN_ONE = 'QUINCE-1026';
const TOKEN_TWO = 'DAMSON-1026';
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sb1026-probe-'));

/**
 * switchboard's own flag list, verbatim from `src/main/providers/claude.ts`,
 * copied rather than imported for #978's reason. `--permission-mode default`
 * and prompts with no reason to act: nothing here needs a tool, so nothing
 * here gets permission to use one (#760).
 */
const ARGS = [
  '--output-format', 'stream-json',
  '--verbose',
  '--input-format', 'stream-json',
  '--permission-prompt-tool', 'stdio',
  '--replay-user-messages',
  '--include-partial-messages',
  '--permission-mode', 'default',
];

const child =
  process.platform === 'win32'
    ? spawn('cmd.exe', ['/c', 'claude', ...ARGS], { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
    : spawn('claude', ARGS, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });

const frames = [];
let sessionId = null;
let results = 0;
const waiters = [];
let buf = '';
const stderrChunks = [];
const NL = String.fromCharCode(10);

child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf(NL)) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    frames.push(m);
    if (m.type === 'system' && m.subtype === 'init' && typeof m.session_id === 'string') {
      sessionId = m.session_id;
    }
    if (m.type === 'result') {
      results++;
      for (const w of waiters.splice(0)) w();
    }
  }
});
child.stderr.setEncoding('utf8');
child.stderr.on('data', (c) => stderrChunks.push(c));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const untilResults = (n, ms) =>
  Promise.race([
    new Promise((r) => {
      const check = () => (results >= n ? r() : waiters.push(check));
      check();
    }),
    sleep(ms),
  ]);
const send = (content) =>
  child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content } }) + NL);

// #760: a frame written to stdin at t=0 is silently lost
await sleep(2500);
send(`Reply with exactly the word ${TOKEN_ONE} and nothing else.`);
await untilResults(1, 120_000);
await sleep(1500);
const beforeCompact = frames.length;
send('/compact');
// a compaction ends in a `result` of its own on some builds and not on
// others; wait for one, but not for ever
await untilResults(2, 150_000);
await sleep(3000);
const afterCompact = frames.length;
const resultsAfterCompact = results;
send(`Reply with exactly the word ${TOKEN_TWO} and nothing else.`);
await untilResults(resultsAfterCompact + 1, 120_000);
await sleep(3000);

if (process.platform === 'win32' && child.pid) {
  spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
}
child.stdin.end();
child.kill();
await sleep(1000);

function flagCensus(objects) {
  const seen = {};
  const note = (where, k, v) => {
    const key = `${where}.${k}`;
    seen[key] = seen[key] ?? { count: 0, values: new Set() };
    seen[key].count++;
    seen[key].values.add(JSON.stringify(v));
  };
  for (const m of objects) {
    for (const [k, v] of Object.entries(m)) {
      if (/^is[_A-Z]/.test(k)) note('frame', k, v);
    }
    const msg = m.message;
    if (msg && typeof msg === 'object' && !Array.isArray(msg)) {
      for (const [k, v] of Object.entries(msg)) {
        if (/^is[_A-Z]/.test(k)) note('frame.message', k, v);
      }
    }
  }
  return Object.fromEntries(
    Object.entries(seen).map(([k, v]) => [k, { count: v.count, values: [...v.values] }])
  );
}

const textOf = (m) => {
  const c = m?.message?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((x) => (x?.type === 'text' ? x.text : `<${x?.type}>`)).join(' ');
  return '';
};
const flagsOf = (m) => Object.fromEntries(Object.entries(m).filter(([k]) => /^is[_A-Z]/.test(k)));
const typeOf = (m) => (m.subtype ? `${m.type}:${m.subtype}` : m.type);
const tally = (list) =>
  list.reduce((acc, m) => {
    acc[typeOf(m)] = (acc[typeOf(m)] ?? 0) + 1;
    return acc;
  }, {});

function findTranscript(id) {
  const root = path.join(os.homedir(), '.claude', 'projects');
  if (!fs.existsSync(root)) return null;
  for (const dir of fs.readdirSync(root, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const f = path.join(root, dir.name, `${id}.jsonl`);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

// a compaction can move the conversation to a new id: every init is recorded
const sessionIds = [...new Set(frames.filter((m) => typeof m.session_id === 'string').map((m) => m.session_id))];
const transcripts = sessionIds.map(findTranscript).filter(Boolean);
function transcriptShape(file) {
  const all = [];
  for (const l of fs.readFileSync(file, 'utf8').split(NL)) {
    if (!l.trim()) continue;
    try {
      all.push(JSON.parse(l));
    } catch {
      /* partial tail */
    }
  }
  return {
    file: path.basename(file),
    entryCount: all.length,
    entryTypes: tally(all),
    flagCensus: flagCensus(all),
    flaggedEntries: all
      .filter((e) => e.isVisibleInTranscriptOnly || e.isVirtual || e.isCompactSummary || e.isMeta)
      .map((e) => ({ type: e.type, flags: flagsOf(e), head: textOf(e).slice(0, 90) })),
  };
}

const allText = frames
  .filter((m) => m.type === 'assistant')
  .map(textOf)
  .join(' ');

const report = {
  cli: spawnSync(
    process.platform === 'win32' ? 'cmd.exe' : 'claude',
    process.platform === 'win32' ? ['/c', 'claude', '--version'] : ['--version'],
    { encoding: 'utf8' }
  ).stdout.trim(),
  args: ARGS,
  sessionIds,
  // --- the harness checks
  controlOneWorked: allText.includes(TOKEN_ONE),
  controlTwoWorked: allText.includes(TOKEN_TWO),
  results,
  // --- the finding
  frameCount: frames.length,
  frameTypesBeforeCompact: tally(frames.slice(0, beforeCompact)),
  frameTypesDuringCompact: tally(frames.slice(beforeCompact, afterCompact)),
  frameTypesAfterCompact: tally(frames.slice(afterCompact)),
  flagCensus: flagCensus(frames),
  userFrames: frames
    .map((m, i) => ({ m, i }))
    .filter(({ m }) => m.type === 'user')
    .map(({ m, i }) => ({
      at: i < beforeCompact ? 'before' : i < afterCompact ? 'during-compact' : 'after',
      flags: flagsOf(m),
      keys: Object.keys(m),
      contentIs: typeof m.message?.content === 'string' ? 'string' : 'array',
      head: textOf(m).slice(0, 90),
    })),
  // everything the compaction itself put on the wire, whole (minus token deltas)
  compactFramesRaw: frames
    .slice(beforeCompact, afterCompact)
    .filter((m) => m.type !== 'stream_event')
    .map((m) => JSON.stringify(m).slice(0, 600)),
  transcripts: transcripts.map(transcriptShape),
  stderr: stderrChunks.join('').slice(0, 1200),
};
process.stdout.write(JSON.stringify(report, null, 2) + NL);

await sleep(800);
for (let i = 0; i < 6; i++) {
  try {
    fs.rmSync(cwd, { recursive: true, force: true });
  } catch {
    /* handle may linger */
  }
  if (!fs.existsSync(cwd)) break;
  await sleep(500);
}
if (fs.existsSync(cwd)) process.stderr.write(`!! temp cwd survived: ${cwd}` + NL);
process.exit(0);
