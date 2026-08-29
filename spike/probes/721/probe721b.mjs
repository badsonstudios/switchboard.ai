// #721 probe B: where does the CURRENT model live? The picker needs it.
import { spawn } from 'node:child_process';
import fs from 'node:fs';

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
      console.log('SYSTEM:INIT model =', JSON.stringify(m.model));
    }
    if (m.type !== 'control_response') return;
    const r = m.response || {};
    const note = sent.get(r.request_id) ?? '??';
    if (note === 'initialize') {
      const p = r.response ?? {};
      fs.writeFileSync('.claude/work_files/723/init.json', JSON.stringify(p, null, 2));
      console.log('initialize.session_state =', JSON.stringify(p.session_state));
      console.log('initialize.fast_mode_state =', JSON.stringify(p.fast_mode_state));
      console.log('initialize.output_style =', JSON.stringify(p.output_style));
      console.log('initialize.models[0] =', JSON.stringify(p.models?.[0]));
      console.log('any key matching /model/i:', Object.keys(p).filter((k) => /model/i.test(k)));
    } else if (note === 'list_models') {
      const p = r.response ?? {};
      fs.writeFileSync('.claude/work_files/723/models.json', JSON.stringify(p, null, 2));
      console.log('\nlist_models count =', p.models?.length);
      for (const mm of p.models ?? []) {
        console.log(
          '  value=' + JSON.stringify(mm.value).padEnd(18),
          'resolved=' + JSON.stringify(mm.resolvedModel).padEnd(26),
          'display=' + JSON.stringify(mm.displayName),
          'extraKeys=' +
            JSON.stringify(
              Object.keys(mm).filter(
                (k) => !['value', 'resolvedModel', 'displayName', 'description'].includes(k)
              )
            )
        );
      }
    }
  }
});
child.stderr.on('data', (d) => process.stderr.write('[err] ' + d));

setTimeout(() => send({ subtype: 'initialize' }), 500);
setTimeout(() => send({ subtype: 'list_models' }), 3500);
setTimeout(() => { child.kill(); process.exit(0); }, 9000);
