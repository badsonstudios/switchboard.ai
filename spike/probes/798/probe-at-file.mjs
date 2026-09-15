// #798 pre-planning probe — does the CLI expand `@path` file mentions in a
// DIRECT-MODE (stream-json) prompt, the way the 2.1.272 binary's
// `at_mentioned_files` attachment step suggests?
//
// Load-bearing for #798: if it does, an `@SessionName` left in a sent prompt is
// ALSO tried as a file/folder path in that session's cwd.
//
// Method: a temp cwd holding NOTES.md with a token the model cannot guess.
//   Turn 1  "What is the magic word in @NOTES.md? Answer with just the word."
//           → expansion is evidenced by (a) the token in the reply with NO Read
//             tool_use in the turn, and (b) an attachment-shaped line carrying
//             the token in the session transcript.
//   Turn 2  the same question about @NOPE.md (missing) → expect a normal reply,
//           no error: the silent-skip branch.
//
// Real CLI, two cheap turns. No --bg: nothing survives the kill. Temp cwd
// removed at the end. Run `claude agents --json` before and after anyway.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TOKEN = 'PERIWINKLE-7731';
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sb798-probe-'));
fs.writeFileSync(path.join(cwd, 'NOTES.md'), `# Notes\n\nThe magic word is ${TOKEN}.\n`);

const ARGS = [
  '--output-format', 'stream-json', '--verbose', '--input-format', 'stream-json',
  '--replay-user-messages', '--permission-mode', 'default',
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
    if (m.type === 'stream_event') continue;
    frames.push(m);
    if (m.type === 'system' && m.subtype === 'init' && typeof m.session_id === 'string') sessionId = m.session_id;
    if (m.type === 'result') {
      results++;
      for (const w of waiters.splice(0)) w();
    }
  }
});
child.stderr.on('data', () => {});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const send = (text) =>
  child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n');
const untilResults = (n, ms) =>
  Promise.race([
    new Promise((r) => {
      const check = () => (results >= n ? r() : waiters.push(check));
      check();
    }),
    sleep(ms),
  ]);

/** assistant text + tool_use names from the frames of turn `n` (1-based) */
function turn(n) {
  let seen = 0;
  const text = [];
  const tools = [];
  for (const f of frames) {
    if (f.type === 'result') {
      seen++;
      if (seen === n) break;
      continue;
    }
    if (seen !== n - 1 || f.type !== 'assistant') continue;
    for (const c of f.message?.content ?? []) {
      if (c.type === 'text') text.push(c.text);
      if (c.type === 'tool_use') tools.push(c.name);
    }
  }
  return { text: text.join(' ').trim(), tools };
}

function findTranscript(id) {
  const root = path.join(os.homedir(), '.claude', 'projects');
  for (const dir of fs.readdirSync(root, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const f = path.join(root, dir.name, `${id}.jsonl`);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

await sleep(2500);
send(`What is the magic word in @NOTES.md? Answer with just the word.`);
await untilResults(1, 90_000);
send(`What is the magic word in @NOPE.md? If there is no such file, answer with just the word MISSING.`);
await untilResults(2, 90_000);
await sleep(1500);

if (process.platform === 'win32' && child.pid) {
  spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
}
child.stdin.end();
child.kill();

const t1 = turn(1);
const t2 = turn(2);
const transcript = sessionId ? findTranscript(sessionId) : null;
let attachmentLines = [];
if (transcript) {
  for (const l of fs.readFileSync(transcript, 'utf8').split('\n')) {
    if (!l.includes(TOKEN)) continue;
    try {
      const e = JSON.parse(l);
      attachmentLines.push({
        type: e.type,
        isMeta: e.isMeta ?? null,
        attachmentType: e.attachment?.type ?? null,
        hasToolUseResult: e.toolUseResult != null,
      });
    } catch {
      /* torn line */
    }
  }
}

const report = {
  cli: spawnSync(process.platform === 'win32' ? 'cmd.exe' : 'claude', process.platform === 'win32' ? ['/c', 'claude', '--version'] : ['--version'], { encoding: 'utf8' }).stdout.trim(),
  sessionId,
  transcript,
  turn1: { reply: t1.text, tools: t1.tools, tokenInReply: t1.text.includes(TOKEN) },
  turn2: { reply: t2.text, tools: t2.tools },
  transcriptLinesCarryingToken: attachmentLines,
  verdict:
    t1.text.includes(TOKEN) && !t1.tools.includes('Read')
      ? 'EXPANDED: token answered with no Read call'
      : t1.tools.includes('Read')
        ? 'NOT EXPANDED (or not relied on): the model called Read'
        : 'INCONCLUSIVE: token not in reply',
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
