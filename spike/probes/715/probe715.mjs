// #715 probe: what does `get_context_usage` answer on the CLI on PATH?
//
//   cold   no prompt, no cost: the answer on a session that has taken no turn
//   turn   ONE short prompt on Haiku: the answer before, DURING (asked while
//          the reply streams) and after the turn
//   resume <session-id>: --resume it, no prompt: is the fill of the old
//          conversation reported before any turn?
//   old    the cold steps against another binary (4th argument)
//
//   node spike/probes/715/probe715.mjs cold   <cwd>
//   node spike/probes/715/probe715.mjs turn   <cwd>
//   node spike/probes/715/probe715.mjs resume <cwd> <session-id>
//   node spike/probes/715/probe715.mjs old    <cwd> <path-to-claude.exe>
import { spawn } from 'node:child_process';

const mode = process.argv[2] || 'cold';
const cwd = process.argv[3] || process.cwd();
const extra = process.argv[4];
const PATH_CLI =
  'C:/Users/dheinz/AppData/Roaming/npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe';
const cli = mode === 'old' ? extra : PATH_CLI;
const args = [
  '--output-format', 'stream-json', '--verbose',
  '--input-format', 'stream-json',
  '--permission-prompt-tool', 'stdio',
  '--replay-user-messages', '--include-partial-messages',
];
if (mode === 'resume') args.push('--resume', extra);
if (mode === 'turn') args.push('--model', 'haiku');
const child = spawn(cli, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });

let buf = '';
let n = 0;
let askedDuring = false;
const sent = new Map();
const send = (request, note) => {
  const id = 'sb-' + ++n;
  sent.set(id, note ?? request.subtype);
  child.stdin.write(JSON.stringify({ type: 'control_request', request_id: id, request }) + '\n');
};

/** the answer with every array cut to its first two entries, so the SHAPE shows */
function shape(v, depth = 0) {
  if (Array.isArray(v)) return v.slice(0, 2).map((x) => shape(x, depth + 1)).concat(v.length > 2 ? [`…${v.length} in all`] : []);
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = depth > 3 ? '…' : shape(x, depth + 1);
    return out;
  }
  return typeof v === 'string' && v.length > 80 ? v.slice(0, 80) + '…' : v;
}

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
      console.log(`[system:init] model = ${JSON.stringify(m.model)} | session_id = ${m.session_id}`);
      continue;
    }
    if (m.type === 'stream_event' && mode === 'turn' && !askedDuring) {
      askedDuring = true;
      send({ subtype: 'get_context_usage' }, 'usage DURING the turn');
      continue;
    }
    if (m.type === 'result') {
      console.log(`[result] ${m.subtype} | usage = ${JSON.stringify(m.usage)}`.slice(0, 600));
      continue;
    }
    if (m.type !== 'control_response') continue;
    const r = m.response || {};
    const note = sent.get(r.request_id) ?? '??';
    const payload = r.subtype === 'error' ? r.error : r.response;
    if (note.startsWith('usage')) {
      console.log(`\n[${note}] ${r.subtype}`);
      console.log('  top-level keys:', JSON.stringify(Object.keys(payload ?? {})));
      const flat = {};
      for (const [k, v] of Object.entries(payload ?? {})) if (v === null || typeof v !== 'object') flat[k] = v;
      console.log('  scalars:', JSON.stringify(flat));
      if (note.endsWith('FULL')) console.log('  shape:', JSON.stringify(shape(payload), null, 1));
    } else {
      console.log(`[${note}] ${r.subtype}`);
    }
  }
});
child.stderr.on('data', (d) => process.stderr.write('[err] ' + d));

let t = 500;
const step = (fn, gap = 1500) => {
  setTimeout(fn, t);
  t += gap;
};
step(() => send({ subtype: 'initialize' }), 3500);
step(() => send({ subtype: 'get_context_usage' }, 'usage cold FULL'), 2500);
if (mode === 'turn') {
  step(() => {
    child.stdin.write(
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: 'Count from 1 to 40, one number per line.' }] },
      }) + '\n'
    );
  }, 25000);
  step(() => send({ subtype: 'get_context_usage' }, 'usage after the turn'));
}
if (mode === 'cold' || mode === 'old') {
  step(() => send({ subtype: 'set_model', model: 'haiku' }, 'set_model haiku'));
  step(() => send({ subtype: 'get_context_usage' }, 'usage after set_model haiku'));
}
step(() => {
  child.kill();
  process.exit(0);
});
