// #1115 probe b: does EVERY level in supportedEffortLevels take, "max" included
// (the settings schema's own enum stops at xhigh)? What else is in `applied`?
// And does a level survive a model switch to one that has no effort (haiku)?
// No prompt is sent.
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
    if (m.type !== 'control_response') continue;
    const r = m.response || {};
    const note = sent.get(r.request_id) ?? '??';
    const payload = r.subtype === 'error' ? r.error : r.response;
    if (note.startsWith('read')) {
      console.log(
        `[${note}] applied = ${JSON.stringify(payload?.applied)} | effective.effortLevel = ${JSON.stringify(payload?.effective?.effortLevel)}`
      );
    } else {
      console.log(`[${note}] ${r.subtype} ${(JSON.stringify(payload) ?? '').slice(0, 200)}`);
    }
  }
});
child.stderr.on('data', (d) => process.stderr.write('[err] ' + d));

let t = 500;
const step = (fn) => {
  setTimeout(fn, t);
  t += 1200;
};
step(() => send({ subtype: 'initialize' }));
t += 2500;
step(() => send({ subtype: 'get_settings' }, 'read start'));
for (const level of ['low', 'medium', 'high', 'xhigh', 'max']) {
  step(() => send({ subtype: 'apply_flag_settings', settings: { effortLevel: level } }, `apply ${level}`));
  step(() => send({ subtype: 'get_settings' }, `read after ${level}`));
}
step(() => send({ subtype: 'set_model', model: 'haiku' }, 'set_model haiku'));
step(() => send({ subtype: 'get_settings' }, 'read after haiku'));
step(() => send({ subtype: 'set_model', model: 'sonnet' }, 'set_model sonnet'));
step(() => send({ subtype: 'get_settings' }, 'read after sonnet'));
step(() => {
  child.kill();
  process.exit(0);
});
