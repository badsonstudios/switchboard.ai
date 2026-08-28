// #721 probe C: does `list_models` answer on a session that has NEVER been
// initialize'd and has run no turn? That is the picker's PRIMARY case — a fresh
// card, user opens the model picker before typing anything.
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

const t0 = Date.now();
let buf = '';
child.stdout.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    const dt = Date.now() - t0;
    if (m.type === 'control_response') {
      const r = m.response || {};
      const n = r.response?.models?.length;
      console.log(`+${dt}ms  control_response id=${r.request_id} subtype=${r.subtype} models=${n}`);
    } else {
      console.log(`+${dt}ms  ${m.type}${m.subtype ? ':' + m.subtype : ''}`);
    }
  }
});
child.stderr.on('data', (d) => process.stderr.write('[err] ' + d));

// NO initialize. Straight to the verb, exactly as the app would.
setTimeout(() => {
  console.log('-> list_models (no initialize first)');
  child.stdin.write(
    JSON.stringify({ type: 'control_request', request_id: 'sb-1', request: { subtype: 'list_models' } }) + '\n'
  );
}, 400);

setTimeout(() => {
  console.log('=== 15s elapsed with no initialize ===');
  child.kill();
  process.exit(0);
}, 15000);
