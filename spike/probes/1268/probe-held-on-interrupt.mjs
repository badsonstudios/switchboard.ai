// #1268: what does the PATH CLI send when a turn is interrupted while one of
// its `can_use_tool` requests is still unanswered?
//
// The app's Stop button sends `{type:'control_request', request:{subtype:
// 'interrupt'}}` (`providers/claude-protocol.ts` interruptRequest). This probe
// does exactly that, with a `can_use_tool` held (never answered), and records
// EVERY line the CLI writes afterwards, timestamped. Then it answers the stale
// request late and records whether the CLI acts on it, and finally sends one
// more tiny prompt to check the session still works.
//
// Usage:
//   node spike/probes/1268/probe-held-on-interrupt.mjs <mode>
//
//   approval   a `Write` is asked for; held; interrupted; late ALLOW
//   question   an `AskUserQuestion` is asked; held; interrupted; late answer
//   subagent   a SUBAGENT (Task tool) asks for a `Write`; held; the MAIN turn
//              is interrupted; late ALLOW
//   prompt     a `Write` is asked for; held; NO interrupt -- a new user prompt
//              is sent instead (the composer stays live while a bar is up);
//              then the held request is answered DENY, late
//
// WINDOWS, npm-global install only: the CLI path below is the npm global
// `claude.exe` on this machine (`docs/reference-implementations.md` §2.1),
// spawned directly rather than through the `.cmd` shim (S-09's first false
// negative). Elsewhere, edit `CLI`.
//
// Spawned with EXACTLY the stream flags `providers/claude.ts` pushes, plus
// `--model haiku` (cheapest) and a minted `--session-id` so the transcript
// can be removed afterwards. Each run works in its own temp folder, removed
// afterwards. No `--bg`: the child is killed at the end; check
// `claude agents --json` before and after anyway.
//
// Artifacts: spike/probes/1268/captures/<mode>.json
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const NL = String.fromCharCode(10);
const HERE = dirname(fileURLToPath(import.meta.url));
const MODES = ['approval', 'question', 'subagent', 'prompt'];
const mode = (process.argv[2] || '').toLowerCase();
if (!MODES.includes(mode)) {
  console.error('mode must be one of: ' + MODES.join(', '));
  process.exit(2);
}

const CLI = join(homedir(), 'AppData/Roaming/npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe');
const PROJECTS = join(homedir(), '.claude', 'projects');

const STREAM_FLAGS = [
  '--output-format', 'stream-json',
  '--verbose',
  '--input-format', 'stream-json',
  '--permission-prompt-tool', 'stdio',
  '--replay-user-messages',
  '--include-partial-messages',
];

const sessionId = randomUUID();
const work = mkdtempSync(join(tmpdir(), 'sb1268-'));
const args = [...STREAM_FLAGS, '--model', 'haiku', '--permission-mode', 'default', '--session-id', sessionId];

const PROMPTS = {
  prompt:
    'Use the Write tool right now to create a file named probe.txt in the current directory containing the single word hello. Do nothing else first.',
  approval:
    'Use the Write tool right now to create a file named probe.txt in the current directory containing the single word hello. Do nothing else first.',
  question:
    'Use the AskUserQuestion tool right now to ask me one question: which colour I prefer, offering exactly Red, Green and Blue. Do nothing else first.',
  subagent:
    'Use the Task tool right now to launch a general-purpose subagent. Its instructions: use the Write tool to create a file named sub.txt in the current directory containing the word hello, then stop. Do nothing else yourself.',
};
const lateFile = mode === 'subagent' ? 'sub.txt' : 'probe.txt';

const t0 = Date.now();
const at = () => Date.now() - t0;
const record = {
  mode,
  cli: CLI,
  cliVersion: null,
  model: null,
  startedAt: new Date().toISOString(),
  // every line the CLI wrote, in order, with ms since spawn; stream_event deltas
  // are counted, not stored (they are the bulk and say nothing here)
  lines: [],
  streamEventsByPhase: {},
  phases: [],
  heldRequest: null,
  interruptRequestId: null,
  lateAnswer: null,
  fileAfterLateAnswer: null,
  stderr: [],
};
let phase = 'start';
function setPhase(p) {
  phase = p;
  record.phases.push({ phase: p, atMs: at() });
  console.log(`[${at()}ms] == phase ${p}`);
}

const child = spawn(CLI, args, { cwd: work, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
function send(o) {
  const line = JSON.stringify(o);
  record.lines.push({ dir: 'OUT', atMs: at(), phase, msg: o });
  console.log(`[${at()}ms] OUT ${line.slice(0, 300)}`);
  child.stdin.write(line + NL);
}

let held = null; // the control_request we are deliberately NOT answering
let resultsSeen = 0;
let healthResult = null;
let buf = '';

child.stdout.on('data', (d) => {
  buf += d.toString('utf8');
  let i;
  while ((i = buf.indexOf(NL)) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      record.lines.push({ dir: 'IN', atMs: at(), phase, raw: line.slice(0, 500) });
      continue;
    }
    if (m.type === 'stream_event') {
      record.streamEventsByPhase[phase] = (record.streamEventsByPhase[phase] || 0) + 1;
      continue;
    }
    record.lines.push({ dir: 'IN', atMs: at(), phase, msg: m });
    console.log(`[${at()}ms] IN  ${line.slice(0, 300)}`);

    if (m.type === 'system' && m.subtype === 'init') {
      record.cliVersion = m.claude_code_version || null;
      record.model = m.model || null;
    }
    if (m.type === 'control_request') {
      const req = m.request || {};
      if (req.subtype !== 'can_use_tool') {
        // plumbing (hook_callback etc.): answer it so it is not what we measure
        send({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: {} } });
        continue;
      }
      if (!held && phase === 'asked') {
        // a Task launch in subagent mode is itself gated: allow it, so the
        // request we hold is the SUBAGENT's Write
        if (mode === 'subagent' && req.tool_name !== 'Write') {
          send({
            type: 'control_response',
            response: { subtype: 'success', request_id: m.request_id, response: { behavior: 'allow', updatedInput: req.input } },
          });
          continue;
        }
        held = m;
        record.heldRequest = { request_id: m.request_id, tool: req.tool_name, atMs: at(), request: req };
        setPhase('holding');
        // hold it for 3 s, unanswered, then press Stop the way the app does
        setTimeout(interrupt, 3000);
        continue;
      }
      // anything after the hold: deny, so nothing new is left parked
      send({
        type: 'control_response',
        response: { subtype: 'success', request_id: m.request_id, response: { behavior: 'deny', message: 'Probe: denied.' } },
      });
      continue;
    }
    if (m.type === 'result') {
      resultsSeen += 1;
      if (phase === 'health') {
        healthResult = m;
        setTimeout(finish, 1500);
      }
    }
  }
});
child.stderr.on('data', (d) => {
  const s = d.toString().trim();
  if (s) record.stderr.push({ atMs: at(), text: s.slice(0, 500) });
});
child.on('exit', (code, signal) => {
  record.exit = { code, signal, atMs: at() };
  console.log(`[${at()}ms] child exit ${code} ${signal}`);
});

function interrupt() {
  if (mode === 'prompt') {
    setPhase('second-prompt');
    send({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'Also: reply with the word BANANA.' }] },
      parent_tool_use_id: null,
      session_id: '',
    });
    setTimeout(lateAnswer, 8000);
    return;
  }
  setPhase('interrupted');
  record.interruptRequestId = randomUUID();
  send({ type: 'control_request', request_id: record.interruptRequestId, request: { subtype: 'interrupt' } });
  // watch what comes back for 8 s, then answer the stale request late
  setTimeout(lateAnswer, 8000);
}

function lateAnswer() {
  setPhase('late-answer');
  const req = held.request;
  const response =
    mode === 'question'
      ? {
          behavior: 'allow',
          updatedInput: { ...req.input, answers: { [req.input.questions[0].question]: 'Green' } },
        }
      : mode === 'prompt'
        ? { behavior: 'deny', message: 'Probe: denied late.' }
        : { behavior: 'allow', updatedInput: req.input };
  record.lateAnswer = { atMs: at(), response };
  send({ type: 'control_response', response: { subtype: 'success', request_id: held.request_id, response } });
  // 6 s for the CLI to act on it (or not), then check the folder and ask once more
  setTimeout(health, 6000);
}

function health() {
  record.fileAfterLateAnswer = existsSync(join(work, lateFile));
  setPhase('health');
  send({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: 'Reply with just the word OK and use no tools.' }] },
    parent_tool_use_id: null,
    session_id: '',
  });
}

let done = false;
function finish() {
  if (done) return;
  done = true;
  setPhase('end');
  record.healthResult = healthResult
    ? { subtype: healthResult.subtype, is_error: healthResult.is_error, result: String(healthResult.result || '').slice(0, 200) }
    : null;
  record.resultsSeen = resultsSeen;
  record.fileAtEnd = existsSync(join(work, lateFile));
  record.endedAt = new Date().toISOString();
  const out = join(HERE, 'captures');
  mkdirSync(out, { recursive: true });
  const file = join(out, `${mode}.json`);
  try {
    child.stdin.end();
  } catch {
    /* gone */
  }
  setTimeout(() => {
    try {
      child.kill();
    } catch {
      /* gone */
    }
    // cleanup: the temp folder and the transcript this run minted
    let removed = 0;
    try {
      for (const d of readdirSync(PROJECTS)) {
        const f = join(PROJECTS, d, `${sessionId}.jsonl`);
        if (existsSync(f)) {
          rmSync(f, { force: true });
          removed += 1;
        }
        const sub = join(PROJECTS, d, sessionId);
        if (existsSync(sub)) rmSync(sub, { recursive: true, force: true });
      }
    } catch {
      /* best effort */
    }
    rmSync(work, { recursive: true, force: true });
    // the CLI also makes a project folder (an empty memory dir) for the temp cwd,
    // and a background subagent writes its output under %TEMP%/claude/<same key>
    const key = work.replace(/[^A-Za-z0-9]/g, '-');
    rmSync(join(PROJECTS, key), { recursive: true, force: true });
    rmSync(join(tmpdir(), 'claude', key), { recursive: true, force: true });
    record.cleanup = { transcriptsRemoved: removed };
    writeFileSync(file, JSON.stringify(record, null, 2));
    console.log('artifact:', file, 'transcripts removed:', removed);
    setTimeout(() => process.exit(0), 300);
  }, 1500);
}

setPhase('asked');
setTimeout(() => {
  send({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: PROMPTS[mode] }] },
    parent_tool_use_id: null,
    session_id: '',
  });
}, 1500);

// hard stop: nothing about this probe should take more than two minutes
setTimeout(() => {
  console.log('[probe] hard timeout');
  finish();
}, 120000);
