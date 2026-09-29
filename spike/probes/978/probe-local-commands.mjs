// #978 probe — does a LOCAL slash command put its output on the stream, when
// the CLI is spawned the way switchboard actually spawns it?
//
// The issue asks for this ("run `/usage` against the PATH `claude` with our
// exact argument list and record EVERY line on the stream"). It is being run
// even though `spike/findings/s-11-local-slash-commands.md` already answered it
// once, for three reasons that are all about the gap between then and now:
//
//   * that probe ran on CLI **2.1.220**; the PATH binary is now **2.1.280**;
//   * it did NOT spawn with `--permission-prompt-tool stdio` or
//     `--include-partial-messages`, both of which switchboard passes
//     unconditionally since #952 (`src/main/providers/claude.ts`);
//   * two transport changes have landed in between (#381, #952), and the code
//     that depends on the old answer (`watcher.ts`'s `deriveFeed: 'sidechains'`
//     early-return on the bound file) would fail SILENTLY if it had gone stale —
//     which is exactly the shape of this bug.
//
// ---------------------------------------------------------------------------
// WHAT IS BEING MEASURED, and why each piece is here
//
// Four turns, in one session, against the real CLI:
//
//   1  /usage     the case the issue opens with
//   2  /cost      S-11 claims this is byte-identical to /usage; cheap to confirm
//   3  /context   named in the issue and in v0.8.100's in-app release notes
//   4  a PLAIN prompt, the CONTROL. If turn 4 produces assistant text and
//      turns 1-3 do not, the harness is sound and the finding is real. Without
//      it, "no output" cannot be told apart from "the probe is broken" — which
//      is the failure mode S-11's own method note warns about.
//
// FRAMES ARE STAMPED WITH THE TURN THEY ARRIVED IN, rather than split on
// `result` afterwards. A local command may well not emit a `result` at all —
// that is one of the possible answers — and a splitter keyed on `result` would
// silently fold turn 1 into turn 2 and report the CONTROL's text as /usage's.
//
// `stream_event` frames are COUNTED AND SAMPLED rather than dropped. Whether
// the text arrives as token deltas, as a whole `assistant` message, as both, or
// as neither is the actual question; dropping the deltas would answer a
// different one.
//
// THE TRANSCRIPT IS READ TOO, in the same run, because the comparison is the
// point: S-11's finding was not "the stream is empty", it was "the stream and
// the transcript disagree about what a local command is". Re-measuring only one
// side cannot confirm or refute that.
//
// Real CLI, four cheap turns, no --bg: nothing survives the kill. Temp cwd is
// removed at the end. Run `claude agents --json` before and after anyway.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CONTROL_TOKEN = 'PINEAPPLE-7731';
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sb978-probe-'));

/**
 * switchboard's own flag list, verbatim from `src/main/providers/claude.ts`
 * (the `args.push(...)` block). Copied rather than imported: the point is to
 * measure what the SHIPPED spawn does, and an import would track a refactor
 * without anyone noticing the probe's premise had moved.
 *
 * `--permission-prompt-tool stdio` makes the CLI delegate `can_use_tool` over
 * the control channel. Nothing here uses a tool, so nothing should ask — but if
 * something does, the probe records the `control_request` rather than hanging
 * on it, because an unanswered permission request is itself a finding.
 */
const ARGS = [
  '--output-format', 'stream-json',
  '--verbose',
  '--input-format', 'stream-json',
  '--permission-prompt-tool', 'stdio',
  '--replay-user-messages',
  '--include-partial-messages',
];

const child =
  process.platform === 'win32'
    ? spawn('cmd.exe', ['/c', 'claude', ...ARGS], { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
    : spawn('claude', ARGS, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });

/** Every frame, stamped with the turn that was in flight when it landed. */
const frames = [];
let sessionId = null;
let turnIndex = 0;
let results = 0;
const waiters = [];
let buf = '';
const stderrChunks = [];

child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    frames.push({ turn: turnIndex, m });
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
const send = (text) => {
  turnIndex++;
  child.stdin.write(
    JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n'
  );
};
const untilResults = (n, ms) =>
  Promise.race([
    new Promise((r) => {
      const check = () => (results >= n ? r() : waiters.push(check));
      check();
    }),
    sleep(ms),
  ]);

/**
 * What a turn produced, reduced to the four things that decide this issue:
 * assistant text, delta text, every frame type seen, and whether a `result`
 * ever closed it.
 */
function turnReport(n) {
  const mine = frames.filter((f) => f.turn === n).map((f) => f.m);
  const assistantText = [];
  const deltaText = [];
  const types = {};
  const otherText = [];
  for (const m of mine) {
    const key = m.subtype ? `${m.type}:${m.subtype}` : m.type;
    types[key] = (types[key] ?? 0) + 1;
    if (m.type === 'assistant') {
      for (const c of m.message?.content ?? []) {
        if (c.type === 'text') assistantText.push(c.text);
      }
    }
    if (m.type === 'stream_event') {
      const d = m.event?.delta;
      if (d?.type === 'text_delta' && typeof d.text === 'string') deltaText.push(d.text);
    }
    // Anything that is neither of the two known carriers but still holds prose:
    // a shape nobody predicted is the most useful thing this probe can find.
    if (m.type !== 'assistant' && m.type !== 'stream_event' && m.type !== 'user') {
      const s = JSON.stringify(m);
      if (s.length > 200) otherText.push({ type: key, sample: s.slice(0, 400) });
    }
  }
  const joined = assistantText.join('').trim();
  return {
    frameTypes: types,
    // `result:success`, not `result` — the key is built with the subtype when
    // there is one, and reading `types.result` here reported `false` for four
    // turns that all ended in a clean result. Caught by reading the output
    // against the frame list rather than by the probe noticing anything.
    closedByResult: Object.keys(types).some((k) => k === 'result' || k.startsWith('result:')),
    assistantText: joined.slice(0, 600),
    assistantTextLength: joined.length,
    deltaTextLength: deltaText.join('').length,
    largeNonAssistantFrames: otherText.slice(0, 4),
  };
}

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

await sleep(2500);

send('/usage');
await untilResults(1, 90_000);
await sleep(2000);

send('/cost');
await untilResults(2, 90_000);
await sleep(2000);

send('/context');
await untilResults(3, 90_000);
await sleep(2000);

// THE CONTROL. If this one is silent too, the probe is broken and nothing
// above it means anything.
send(`Reply with exactly the word ${CONTROL_TOKEN} and nothing else.`);
await untilResults(4, 90_000);
await sleep(2500);

if (process.platform === 'win32' && child.pid) {
  spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
}
child.stdin.end();
child.kill();
await sleep(1000);

const transcript = sessionId ? findTranscript(sessionId) : null;

/**
 * The transcript side of the comparison: every entry, reduced to its type and
 * whether it carries prose. This is what S-11 measured on the other transport,
 * and the only way to say whether the two sources still disagree.
 */
function transcriptShape() {
  if (!transcript) return null;
  const out = [];
  for (const l of fs.readFileSync(transcript, 'utf8').split('\n')) {
    if (!l.trim()) continue;
    let e;
    try {
      e = JSON.parse(l);
    } catch {
      continue;
    }
    const content = e.message?.content ?? e.content;
    const text =
      typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content
              .filter((c) => c?.type === 'text')
              .map((c) => c.text)
              .join('')
          : '';
    out.push({
      type: e.type,
      subtype: e.subtype ?? null,
      isMeta: e.isMeta ?? null,
      textHead: String(text).replace(/\s+/g, ' ').slice(0, 120),
      textLength: String(text).length,
    });
  }
  return out;
}

const usage = turnReport(1);
const cost = turnReport(2);
const context = turnReport(3);
const control = turnReport(4);

const controlWorked = control.assistantText.includes(CONTROL_TOKEN);
const localCarried = usage.assistantTextLength > 0;

const report = {
  cli: spawnSync(
    process.platform === 'win32' ? 'cmd.exe' : 'claude',
    process.platform === 'win32' ? ['/c', 'claude', '--version'] : ['--version'],
    { encoding: 'utf8' }
  ).stdout.trim(),
  args: ARGS,
  sessionId,
  transcript,
  turns: { 1: usage, 2: cost, 3: context, 4: control },
  // ⚠️ THE RAW FRAMES OF TURN 1, WHOLE. The summary above answers "did the text
  // arrive"; only the raw frame answers "in a shape our derivation accepts",
  // which is the half that decides where the fix goes. `stream_event` is
  // excluded — there are none on a local-command turn, which is itself part of
  // the finding, and on the control turn they are noise.
  rawUsageFrames: frames
    .filter((f) => f.turn === 1 && f.m.type !== 'stream_event')
    .map((f) => f.m),
  transcriptShape: transcriptShape(),
  stderr: stderrChunks.join('').slice(0, 1200),
  verdict: !controlWorked
    ? 'PROBE BROKEN: the control turn produced no assistant text either — nothing above it is evidence'
    : localCarried
      ? 'STREAM CARRIES IT: /usage output arrived as ordinary assistant text, as S-11 measured on 2.1.220. The gap is on our side.'
      : 'STREAM DOES NOT CARRY IT: the control worked and /usage produced no assistant text. The transcript is the only source.',
};
process.stdout.write(JSON.stringify(report, null, 2) + '\n');

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
if (fs.existsSync(cwd)) process.stderr.write(`!! temp cwd survived: ${cwd}\n`);
process.exit(0);
