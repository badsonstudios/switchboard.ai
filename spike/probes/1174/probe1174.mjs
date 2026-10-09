// #1174 probe: does `get_settings.applied.model` answer "which model is this
// session on", and how does it line up with `system:init.model` and with the
// rows `list_models` offers?
//
// Four cases, chosen by the first argument:
//   cold     no prompt, no cost: initialize, list_models, get_settings,
//            set_model haiku, get_settings, set_model sonnet, get_settings,
//            set_model default, get_settings
//   turn     ONE tiny prompt on Haiku (the only case that costs a turn):
//            get_settings before, system:init.model during, get_settings after.
//            Prints the session id for `resume`.
//   resume   <session-id>: --resume it, no prompt, get_settings
//   old      the `cold` steps against another binary (third argument), to see
//            what a CLI with no `applied` block answers
//
//   node spike/probes/1174/probe1174.mjs cold   <cwd>
//   node spike/probes/1174/probe1174.mjs turn   <cwd>
//   node spike/probes/1174/probe1174.mjs resume <cwd> <session-id>
//   node spike/probes/1174/probe1174.mjs old    <cwd> <path-to-claude.exe>
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
      console.log(`[system:init] model = ${JSON.stringify(m.model)} | session_id = ${m.session_id}`);
      continue;
    }
    if (m.type === 'result') {
      console.log(`[result] ${m.subtype} | modelUsage keys = ${JSON.stringify(Object.keys(m.modelUsage ?? {}))}`);
      continue;
    }
    if (m.type !== 'control_response') continue;
    const r = m.response || {};
    const note = sent.get(r.request_id) ?? '??';
    const payload = r.subtype === 'error' ? r.error : r.response;
    if (note === 'list_models') {
      for (const mo of payload?.models ?? []) {
        console.log(`    list_models: value = ${JSON.stringify(mo.value)} | resolvedModel = ${JSON.stringify(mo.resolvedModel)}`);
      }
    } else if (note.startsWith('read')) {
      console.log(
        `[${note}] ${r.subtype} | top-level keys = ${JSON.stringify(Object.keys(payload ?? {}))} | applied = ${JSON.stringify(payload?.applied)} | effective.model = ${JSON.stringify(payload?.effective?.model)}`
      );
    } else {
      console.log(`[${note}] ${r.subtype} ${(JSON.stringify(payload) ?? '').slice(0, 200)}`);
    }
  }
});
child.stderr.on('data', (d) => process.stderr.write('[err] ' + d));

let t = 500;
const step = (fn, gap = 1200) => {
  setTimeout(fn, t);
  t += gap;
};
step(() => send({ subtype: 'initialize' }), 3500);
step(() => send({ subtype: 'get_settings' }, 'read cold'));
if (mode === 'cold' || mode === 'old') {
  step(() => send({ subtype: 'list_models' }));
  for (const model of ['haiku', 'sonnet', 'default']) {
    step(() => send({ subtype: 'set_model', model }, `set_model ${model}`));
    step(() => send({ subtype: 'get_settings' }, `read after ${model}`));
  }
}
if (mode === 'turn') {
  step(() => {
    child.stdin.write(
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: 'Reply with the single word: ok' }] },
      }) + '\n'
    );
  }, 20000);
  step(() => send({ subtype: 'get_settings' }, 'read after turn'));
}
step(() => {
  child.kill();
  process.exit(0);
});
