// #721 probe: exercise the verbs the channel will carry, and capture the
// EXACT envelopes — success, refusal, unknown subtype, and the no-field case.
import { spawn } from 'node:child_process';

const cwd = process.argv[2] || process.cwd();
const cli =
  'C:/Users/dheinz/AppData/Roaming/npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe';
const args = [
  '--output-format', 'stream-json', '--verbose',
  '--input-format', 'stream-json',
  '--permission-prompt-tool', 'stdio',
  '--replay-user-messages', '--include-partial-messages',
];
const child = spawn(cli, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });

let buf = '';
let n = 0;
const sent = new Map();
const send = (request, note) => {
  const id = 'sb-' + ++n;
  sent.set(id, note ?? request.subtype);
  child.stdin.write(JSON.stringify({ type: 'control_request', request_id: id, request }) + '\n');
};

child.stdout.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    if (m.type === 'system' && m.subtype === 'init') {
      console.log('INIT.model =', JSON.stringify(m.model));
    }
    if (m.type !== 'control_response') continue;
    const r = m.response || {};
    const note = sent.get(r.request_id) ?? '??';
    // TOP-LEVEL request_id too? the inbound can_use_tool carries it there.
    console.log(
      `\n[${note}] topLevelRequestId=${JSON.stringify(m.request_id)} ` +
        `nestedRequestId=${JSON.stringify(r.request_id)} subtype=${JSON.stringify(r.subtype)}`
    );
    const payload = r.subtype === 'error' ? r.error : r.response;
    let s = JSON.stringify(payload);
    if (note === 'initialize') s = 'keys: ' + JSON.stringify(Object.keys(payload ?? {}));
    console.log('   ', (s ?? '(none)').slice(0, 600));
  }
});
child.stderr.on('data', (d) => process.stderr.write('[err] ' + d));

setTimeout(() => send({ subtype: 'initialize' }), 500);
setTimeout(() => send({ subtype: 'list_models' }), 3500);
setTimeout(() => send({ subtype: 'set_model', model: 'haiku' }), 5000);
setTimeout(() => send({ subtype: 'set_model', model: 'no-such-model-xyz' }, 'set_model BAD'), 6500);
setTimeout(() => send({ subtype: 'set_model' }, 'set_model NO FIELD'), 8000);
setTimeout(() => send({ subtype: 'set_model', model: 42 }, 'set_model NON-STRING'), 9500);
setTimeout(() => send({ subtype: 'no_such_verb_xyz' }, 'UNKNOWN SUBTYPE'), 11000);
setTimeout(() => send({ subtype: 'get_context_usage' }), 12500);
setTimeout(() => {
  child.kill();
  process.exit(0);
}, 20000);
