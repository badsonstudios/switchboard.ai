// S-11 probe 2 — `AskUserQuestion`, the chooser (#563 / plan item E18-11).
//
// THE QUESTIONS, in the order the issue asks them:
//
//   A. How does the question ARRIVE? The VS Code extension renders it from its
//      tool-permission renderer (`class … { name = "AskUserQuestion";
//      permissionRequest(…) }`), which says `can_use_tool` — but the extension
//      ships its own CLI, so it is a hypothesis until the CLI on PATH says so.
//   B. What is the INPUT shape? (`questions[]` with `header`, `question`,
//      `options[{label, description}]`, `multiSelect`.)
//   C. What is the RESPONSE shape? The extension writes an `answers` map onto
//      the tool input and allows with `updatedInput` — does the CLI on PATH
//      accept that, and what does the tool_result say?
//   D. Does free text that is NOT one of the offered labels survive? (The
//      owner's "Other" is the whole reason this matters.)
//   E. What happens on DENY, and on NO ANSWER AT ALL — does the CLI fall back
//      to its own TUI prompt, or does it park for ever? (P6, fail-open.)
//   F. What does a BARE ALLOW do — `updatedInput` echoed back with no `answers`
//      at all? This is not hypothetical: it is exactly what an allow-all
//      session's server-side auto-allow would send, on both of our allow-all
//      paths, if `AskUserQuestion` were treated as an ordinary gated tool.
//
// Usage:
//   node probe-2-ask-user-question.cjs [answer|other|deny|ignore|empty]
//
//   answer  (default) allow with answers taken from the offered labels
//   other             allow with free text that is in NO option list  (D)
//   deny              behavior:'deny'                                 (E)
//   ignore            never respond to the can_use_tool               (E)
//   empty             allow with the input echoed back, no `answers`  (F)
//
// Artifacts: ../findings/artifacts/s11/ask-user-question-<mode>.json
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const mode = (process.argv[2] || 'answer').toLowerCase();
if (!['answer', 'other', 'deny', 'ignore', 'empty'].includes(mode)) {
  console.error(`unknown mode: ${mode}`);
  process.exit(2);
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-probe-auq-'));
const outDir = path.join(__dirname, '..', 'findings', 'artifacts', 's11');
fs.mkdirSync(outDir, { recursive: true });

const cli = process.env.SB_CLAUDE || 'claude.cmd';
const args = [
  '--output-format', 'stream-json',
  '--verbose',
  '--input-format', 'stream-json',
  '--permission-prompt-tool', 'stdio',
];
const isCmd = process.platform === 'win32' && cli.toLowerCase().endsWith('.cmd');
const proc = spawn(isCmd ? 'cmd.exe' : cli, isCmd ? ['/c', cli, ...args] : args, {
  cwd: work, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env },
});

/** everything we saw, verbatim — the findings note is written FROM this file */
const record = {
  mode,
  cli,
  startedAt: new Date().toISOString(),
  controlRequests: [],
  askRequest: null,
  ourResponse: null,
  toolResults: [],
  assistantText: [],
  result: null,
  stderr: [],
};

function send(o) { proc.stdin.write(JSON.stringify(o) + '\n'); }

/**
 * Build the `answers` map the extension builds.
 *
 * Its rule, read off the webview: one entry per question, KEYED BY THE QUESTION
 * TEXT, value a comma-space-joined string of chosen labels — with the literal
 * "Other" dropped and the typed text put in its place. So a free-text answer is
 * indistinguishable, on the wire, from a label. That is question D.
 */
function answersFor(questions) {
  const answers = {};
  for (const q of questions) {
    const labels = (q.options || []).map((o) => o.label);
    if (mode === 'other') {
      answers[q.question] = `zzz-probe-free-text-${q.header || 'x'}`.replace(/\s+/g, '-');
    } else if (q.multiSelect) {
      answers[q.question] = labels.slice(0, 2).join(', ');
    } else {
      answers[q.question] = labels[0];
    }
  }
  return answers;
}

let buf = '';
proc.stdout.on('data', (d) => {
  buf += d.toString('utf8');
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let m;
    try { m = JSON.parse(line); } catch { continue; }

    if (m.type === 'control_request') {
      const req = m.request || {};
      record.controlRequests.push({ subtype: req.subtype, tool: req.tool_name });
      if (req.subtype !== 'can_use_tool') {
        send({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: {} } });
        continue;
      }
      console.log(`\n=== can_use_tool: ${req.tool_name} ===`);
      console.log(JSON.stringify(req.input, null, 2).slice(0, 3000));

      if (req.tool_name !== 'AskUserQuestion') {
        // anything else it wants on the way there — let it through
        send({
          type: 'control_response',
          response: { subtype: 'success', request_id: m.request_id, response: { behavior: 'allow', updatedInput: req.input } },
        });
        continue;
      }

      record.askRequest = { requestId: m.request_id, request: req };
      if (mode === 'ignore') {
        console.log('--> deliberately NOT responding (question E)');
        continue;
      }
      let response;
      if (mode === 'deny') {
        response = { behavior: 'deny', message: 'Probe denied the question.' };
      } else if (mode === 'empty') {
        // The bare allow an allow-all session would send. Question F.
        response = { behavior: 'allow', updatedInput: req.input };
      } else {
        const questions = (req.input && req.input.questions) || [];
        response = {
          behavior: 'allow',
          updatedInput: { ...req.input, answers: answersFor(questions) },
        };
      }
      record.ourResponse = response;
      console.log('--> replying', JSON.stringify(response).slice(0, 600));
      send({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response } });
      continue;
    }

    if (m.type === 'assistant') {
      for (const c of m.message?.content ?? []) {
        if (c.type === 'text' && c.text.trim()) {
          record.assistantText.push(c.text);
          console.log('[asst]', c.text.slice(0, 300));
        }
        if (c.type === 'tool_use') console.log('[tool_use]', c.name);
      }
      continue;
    }
    if (m.type === 'user') {
      // the tool_result comes back as a synthetic user message
      for (const c of m.message?.content ?? []) {
        if (c.type === 'tool_result') {
          record.toolResults.push(c);
          console.log('[tool_result]', JSON.stringify(c).slice(0, 1200));
        }
      }
      continue;
    }
    if (m.type === 'result') {
      record.result = { subtype: m.subtype, is_error: m.is_error, duration_ms: m.duration_ms };
      console.log('\n[result]', m.subtype, 'is_error=' + m.is_error);
      // In `ignore` mode a result must NOT arrive while we are holding the
      // question — if one does, the CLI answered it some other way, which is
      // exactly what question E is asking.
      finish();
      continue;
    }
    if (m.type === 'system') console.log('[sys]', m.subtype);
  }
});
proc.stderr.on('data', (d) => {
  const s = d.toString().trim();
  if (s) { record.stderr.push(s.slice(0, 500)); console.log('[err]', s.slice(0, 300)); }
});

let done = false;
function finish() {
  if (done) return; done = true;
  record.endedAt = new Date().toISOString();
  const file = path.join(outDir, `ask-user-question-${mode}.json`);
  fs.writeFileSync(file, JSON.stringify(record, null, 2));
  console.log('\n--- VERDICT ---');
  console.log('control_request subtypes seen  :', [...new Set(record.controlRequests.map((c) => c.subtype))].join(', ') || 'NONE');
  console.log('AskUserQuestion via can_use_tool:', Boolean(record.askRequest));
  console.log('tool_results                   :', record.toolResults.length);
  console.log('artifact                       :', file);
  proc.kill();
  setTimeout(() => process.exit(0), 500);
}

// The prompt has to make the CLI reach for the tool without us describing the
// payload to it — we are measuring the tool's own shape, not our idea of it.
const PROMPT = [
  'Use the AskUserQuestion tool right now to ask me two questions before doing anything else.',
  'The first: which colour I prefer, offering exactly Red, Green and Blue — pick one only.',
  'The second: which of these languages I use, offering exactly TypeScript, Rust, Go and Python — I may pick several.',
  'Ask both in a single AskUserQuestion call, then tell me what I answered.',
].join(' ');

setTimeout(() => {
  send({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: PROMPT }] },
    parent_tool_use_id: null,
    session_id: '',
  });
}, 1500);

// `ignore` needs a long window: the question is whether ANYTHING happens when
// nobody answers — a TUI fallback, a timeout, or silence for ever.
setTimeout(() => { console.log('[probe] timeout'); finish(); }, mode === 'ignore' ? 180_000 : 120_000);
