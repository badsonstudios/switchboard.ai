// #1226: what the CLI writes as the RESULT of `AskUserQuestion`, for the
// shapes the question read-back (#1201) handles from reading the binary and
// had never measured.
//
// The sentence is built by the tool's `mapToolResultToToolResultBlockParam`
// (read out of the 2.1.288 binary, `docs/reference-implementations.md` §2.1).
// It takes more than the `answers` map S-11 measured:
//
//   annotations   { [question]: { notes?, preview? } }
//   response      free text, instead of or beside the answers
//   followUp      true: "the user wants to clarify"
//   afkTimeoutMs  a number: "before going idle the user had selected"
//
// Reading the code says what each does. Whether the CLI on PATH ACCEPTS each
// of them on `updatedInput` from a client, and what it then writes, is what
// this measures. S-11's probe (`spike/s11/probe-2-ask-user-question.cjs`) is
// the parent of this one; its six modes are not repeated.
//
// Usage:
//   node probe-ask-result-shapes.cjs <mode>
//
//   note        answer both, with a note on the first
//   notepick    NO pick on the first but a note; the second answered
//   preview     answer both, with a preview and a note on the first
//   response    no answers, `response` free text
//   both        answers AND `response`
//   followup    answers, followUp: true
//   followtext  no answers, followUp: true, `response` text
//   followboth  answers, followUp: true, AND `response` text
//   array       the multi-select answer sent as an ARRAY, not a joined string
//   afk         answers, afkTimeoutMs: 60000
//
// Artifacts: ../../findings/artifacts/1226/ask-result-<mode>.json
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MODES = ['note', 'notepick', 'preview', 'response', 'both', 'followup', 'followtext', 'followboth', 'array', 'afk'];
const mode = (process.argv[2] || '').toLowerCase();
if (!MODES.includes(mode)) {
  console.error('mode must be one of: ' + MODES.join(', '));
  process.exit(2);
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-probe-1226-'));
const outDir = path.join(__dirname, '..', '..', 'findings', 'artifacts', '1226');
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

const record = {
  mode,
  cli,
  cliVersion: null,
  startedAt: new Date().toISOString(),
  askInput: null,
  ourResponse: null,
  toolResults: [],
  assistantText: [],
  result: null,
  stderr: [],
};

function send(o) { proc.stdin.write(JSON.stringify(o) + '\n'); }

/** what we put on `updatedInput`, per mode */
function fieldsFor(questions) {
  const [q1, q2] = questions;
  const first = (q) => (q.options || [])[0] && q.options[0].label;
  const two = (q) => (q.options || []).slice(0, 2).map((o) => o.label);
  const answered = { [q1.question]: first(q1), [q2.question]: two(q2).join(', ') };
  switch (mode) {
    case 'note':
      return { answers: answered, annotations: { [q1.question]: { notes: 'PROBE-NOTE because it is warm' } } };
    case 'notepick':
      return {
        answers: { [q2.question]: two(q2).join(', ') },
        annotations: { [q1.question]: { notes: 'PROBE-NOTE none of these' } },
      };
    case 'preview':
      return {
        answers: answered,
        annotations: { [q1.question]: { preview: '<b>PROBE-PREVIEW</b>', notes: 'PROBE-NOTE bright' } },
      };
    case 'response':
      return { answers: {}, response: 'PROBE-RESPONSE I would rather describe it in my own words' };
    case 'both':
      return { answers: answered, response: 'PROBE-RESPONSE and one more thing' };
    case 'followup':
      return { answers: answered, followUp: true };
    case 'followtext':
      return { answers: {}, followUp: true, response: 'PROBE-RESPONSE what do you mean by colour' };
    case 'followboth':
      return { answers: answered, followUp: true, response: 'PROBE-RESPONSE but ask me about "shade" too' };
    case 'array':
      return { answers: { [q1.question]: first(q1), [q2.question]: two(q2) } };
    case 'afk':
      return { answers: answered, afkTimeoutMs: 60000 };
    default:
      return { answers: answered };
  }
}

let asked = 0;
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

    if (m.type === 'system' && m.subtype === 'init') {
      record.cliVersion = m.claude_code_version || m.version || null;
      continue;
    }
    if (m.type === 'control_request') {
      const req = m.request || {};
      if (req.subtype !== 'can_use_tool') {
        send({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: {} } });
        continue;
      }
      if (req.tool_name !== 'AskUserQuestion') {
        send({
          type: 'control_response',
          response: { subtype: 'success', request_id: m.request_id, response: { behavior: 'allow', updatedInput: req.input } },
        });
        continue;
      }
      asked += 1;
      if (asked > 1) {
        // a follow-up mode makes the model ask again: one result is what we came
        // for, so the second question is declined and the turn allowed to end
        send({
          type: 'control_response',
          response: { subtype: 'success', request_id: m.request_id, response: { behavior: 'deny', message: 'Probe: one question was enough.' } },
        });
        continue;
      }
      const questions = (req.input && req.input.questions) || [];
      record.askInput = req.input;
      const response = { behavior: 'allow', updatedInput: { ...req.input, ...fieldsFor(questions) } };
      record.ourResponse = response;
      console.log('--> replying', JSON.stringify(response.updatedInput).slice(0, 700));
      send({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response } });
      continue;
    }
    if (m.type === 'assistant') {
      for (const c of (m.message && m.message.content) || []) {
        if (c.type === 'text' && c.text.trim()) record.assistantText.push(c.text);
      }
      continue;
    }
    if (m.type === 'user') {
      for (const c of (m.message && m.message.content) || []) {
        if (c.type === 'tool_result') {
          record.toolResults.push(c);
          console.log('[tool_result]', JSON.stringify(c).slice(0, 1500));
        }
      }
      continue;
    }
    if (m.type === 'result') {
      record.result = { subtype: m.subtype, is_error: m.is_error, duration_ms: m.duration_ms };
      finish();
    }
  }
});
proc.stderr.on('data', (d) => {
  const s = d.toString().trim();
  if (s) record.stderr.push(s.slice(0, 500));
});

let done = false;
function finish() {
  if (done) return;
  done = true;
  record.endedAt = new Date().toISOString();
  const file = path.join(outDir, `ask-result-${mode}.json`);
  fs.writeFileSync(file, JSON.stringify(record, null, 2));
  console.log('artifact:', file, 'tool_results:', record.toolResults.length);
  proc.kill();
  setTimeout(() => process.exit(0), 500);
}

// S-11's own prompt, word for word, so the questions (and so the keys of the
// answers map) are the ones its artifacts hold.
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

setTimeout(() => { console.log('[probe] timeout'); finish(); }, 150000);
