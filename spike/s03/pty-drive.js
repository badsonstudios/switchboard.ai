// S-03 interactive driver: scripts a REAL interactive claude TUI session under
// ConPTY to observe permission-prompt behavior. Must run with Electron's ABI
// (node-pty was rebuilt for it):
//   ELECTRON_RUN_AS_NODE=1 <spike>/node_modules/electron/dist/electron.exe pty-drive.js \
//     <scenario: ask|hang> <settings-file-mixed-path> <fixture-cwd> <outDir>
//
// ask:  listener answers "ask" -> expect the TUI permission prompt; capture its
//       full option text (don't-ask-again evidence), accept, verify the write.
// hang: listener never answers -> does the TUI permission prompt still engage
//       (fallback) after the hook times out, and how long does that take?
const pty = require('node-pty');
const fs = require('fs');
const path = require('path');

const [, , scenario, settingsFile, fixtureCwd, outDir] = process.argv;
if (!outDir) { console.error('usage: pty-drive.js <allow|deny|ask|hang> <settings> <cwd> <outDir>'); process.exit(1); }
// deny must NOT write the file; every other scenario must.
const expectWrite = scenario !== 'deny';
fs.mkdirSync(outDir, { recursive: true });

const t0 = Date.now();
const rawPath = path.join(outDir, 'raw.log');
const evPath = path.join(outDir, 'events.log');
const ev = (s) => {
  const line = `${new Date().toISOString()} +${String(Date.now() - t0).padStart(6)}ms ${s}`;
  fs.appendFileSync(evPath, line + '\n');
  console.log(line);
};

const strip = (s) =>
  s
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '') // OSC
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')       // CSI
    .replace(/\x1b[=>NOM78]/g, '')
    .replace(/[\x00-\x08\x0b-\x1f]/g, '');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE; // S-01 landmine: don't leak into children

const child = pty.spawn('claude.cmd', ['--settings', settingsFile], {
  name: 'xterm-256color', cols: 120, rows: 32, cwd: fixtureCwd, env, useConpty: true,
});
ev(`spawned pid=${child.pid} scenario=${scenario}`);

let stripped = '';
let consumed = 0; // strip() index up to which matches were already handled
child.onData((d) => {
  fs.appendFileSync(rawPath, d);
  stripped += strip(d);
});
child.onExit(({ exitCode }) => { ev(`child exit code=${exitCode}`); finish(); });

const result = { scenario, steps: [], promptCapture: null, promptLatencyMs: null, fileWritten: null };
let finished = false;
function finish(fail) {
  if (finished) return;
  finished = true;
  const probe = path.join(fixtureCwd, `live-${scenario}.txt`);
  result.fileWritten = fs.existsSync(probe);
  if (result.fileWritten) result.fileContent = fs.readFileSync(probe, 'utf8');
  // Exit code asserts the scenario's claim, not just step completion.
  const writeOk = result.fileWritten === expectWrite;
  result.failed = !!fail || !writeOk;
  fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(result, null, 2));
  ev(`DONE fileWritten=${result.fileWritten} expectWrite=${expectWrite} failed=${result.failed}`);
  try { child.kill(); } catch (_) {}
  setTimeout(() => process.exit(result.failed ? 1 : 0), 500);
}

// Sequential step engine: each step waits for a regex in NEW stripped output.
const steps = [];
let stepIdx = 0;
let stepStart = Date.now();
function runStep() {
  const s = steps[stepIdx];
  if (!s) return finish(false);
  const iv = setInterval(() => {
    const tail = stripped.slice(consumed);
    const m = tail.match(s.match);
    if (m) {
      clearInterval(iv);
      const at = Date.now() - t0;
      ev(`step "${s.name}" matched ${JSON.stringify(m[0].slice(0, 60))}`);
      result.steps.push({ name: s.name, atMs: at, sinceStepStartMs: Date.now() - stepStart });
      if (s.capture) {
        const ctx = tail.slice(Math.max(0, m.index - 200), m.index + 1400);
        result.promptCapture = ctx;
        fs.writeFileSync(path.join(outDir, 'prompt-capture.txt'), ctx);
      }
      if (s.latency) result.promptLatencyMs = Date.now() - s.latencyFrom();
      consumed += m.index + m[0].length;
      const proceed = () => { stepIdx++; stepStart = Date.now(); runStep(); };
      if (s.send !== undefined) setTimeout(() => { child.write(s.send); proceed(); }, s.sendDelayMs || 400);
      else proceed();
    } else if (Date.now() - stepStart > s.timeoutMs) {
      clearInterval(iv);
      ev(`step "${s.name}" TIMED OUT after ${s.timeoutMs}ms`);
      result.steps.push({ name: s.name, timedOut: true });
      fs.writeFileSync(path.join(outDir, 'timeout-tail.txt'), stripped.slice(-3000));
      if (s.optional) { stepIdx++; stepStart = Date.now(); runStep(); }
      else finish(true);
    }
  }, 150);
}

// TUI cursor-positioning strips out to concatenated words — every phrase
// match must tolerate missing spaces (\s*).
let promptSentAt = Date.now();
const PERM_RE = /(Do\s*you\s*want|Allow\s*this|Yes,\s*(and\s*)?(allow|don'?t\s*ask)|don'?t\s*ask\s*again|Permission\s*re)/i;
const START_RE = /(Do\s*you\s*trust|trust\s*this\s*folder|Accessing\s*workspace|\?\s*for\s*shortcuts)/i;
const TRUST_RE = /(trust|Accessing)/i;
const READY_RE = /\?\s*for\s*shortcuts/i;

steps.push(
  { name: 'placeholder-startup', match: /(?:)/, timeoutMs: 1 }, // handled by iv0 below
  { name: 'ready', match: READY_RE, timeoutMs: 20000, optional: true },
  // Text and Enter must be separate writes: a single chunk registers as a
  // paste and the trailing \r lands in the composer instead of submitting.
  // Completion marker: the model replies "SPIKE" reversed — a string that can
  // never appear in the typed prompt's own echo/redraws.
  { name: 'send-prompt', match: /(?:)/, timeoutMs: 5000,
    send:
      `Use the Write tool to create the file live-${scenario}.txt containing exactly: hello-${scenario}` +
      (scenario === 'status'
        ? ' — then use the Agent tool (general-purpose subagent) to read that file and report its line count'
        : '') +
      ' — then reply with exactly the word SPIKE spelled backwards.',
    sendDelayMs: 1200 },
  { name: 'submit', match: /(?:)/, timeoutMs: 5000, send: '\r', sendDelayMs: 900 },
);
if (scenario === 'ask' || scenario === 'hang') {
  steps.push(
    { name: 'permission-prompt', match: PERM_RE,
      timeoutMs: scenario === 'hang' ? 660000 : 90000, // headless default hook budget measured ~600s
      capture: true, latency: true, latencyFrom: () => promptSentAt,
      // settle before answering so the full option list is in the capture buffer
      send: '\r', sendDelayMs: 2500 }
  );
} else if (scenario === 'allow') {
  // No prompt expected: hook-allow lets the write run straight through; wait
  // for the model's turn to actually finish (EKIPS marker), else we /exit
  // before the tool ever runs. The existsSync check in finish() is the proof.
  steps.push({ name: 'model-finished', match: /EKIPS/, timeoutMs: 90000 });
} else if (scenario === 'deny') {
  // No prompt expected: model should surface the hook's reason string.
  steps.push({ name: 'deny-reason-visible', match: /S03-DENY-REASON/i, timeoutMs: 90000 });
} else if (scenario === 'status') {
  // S-06: permission prompt from the CLI's own flow (no PreToolUse hook),
  // then wait for the FULL turn (subagent + reply) so Stop/SubagentStop fire.
  // S06_ANSWER_DELAY_MS: leave the prompt hanging first (Notification-
  // threshold probe — does the CLI notify only after the prompt sits idle?).
  steps.push(
    { name: 'permission-prompt', match: PERM_RE, timeoutMs: 120000,
      capture: true, latency: true, latencyFrom: () => promptSentAt,
      send: '\r', sendDelayMs: Number(process.env.S06_ANSWER_DELAY_MS || 2500) },
    { name: 'model-finished', match: /EKIPS/, timeoutMs: 240000 }
  );
}
steps.push(
  { name: 'write-done', match: new RegExp(`live-${scenario}\\.txt|hello-${scenario}`, 'i'),
    timeoutMs: 90000, optional: true },
  { name: 'exit', match: /(?:)/, timeoutMs: 3000, send: '/exit\r', sendDelayMs: 1500 },
  { name: 'gone', match: /claude|exit|^\s*$/i, timeoutMs: 15000, optional: true }
);

// Mark when the edit request actually went in (for prompt latency).
const origWrite = child.write.bind(child);
child.write = (data) => {
  if (typeof data === 'string' && data.includes('Use the Write tool')) promptSentAt = Date.now();
  return origWrite(data);
};

// Startup responder: trust prompt may or may not appear; accept it if it does,
// then hand off to the step engine at 'ready'.
const iv0 = setInterval(() => {
  const m = stripped.match(START_RE);
  if (!m) {
    if (Date.now() - t0 > 60000) { clearInterval(iv0); ev('startup TIMED OUT'); finish(true); }
    return;
  }
  clearInterval(iv0);
  ev(`startup matched: ${JSON.stringify(m[0])}`);
  result.steps.push({ name: 'startup', atMs: Date.now() - t0, matched: m[0] });
  if (TRUST_RE.test(m[0])) setTimeout(() => child.write('\r'), 600);
  consumed = stripped.indexOf(m[0]) + m[0].length;
  stepIdx = 1; stepStart = Date.now();
  runStep();
}, 150);

// Global safety net.
setTimeout(() => { ev('GLOBAL TIMEOUT'); finish(true); }, 780000);
