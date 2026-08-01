// Probe: does the LOCAL claude CLI (2.1.220, Dan's install) support the duplex
// stream-json transport the VS Code extension uses — WITHOUT --print?
// Args copied verbatim from the SDK arg builder inside extension.js.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-probe-sj-'));
fs.mkdirSync(path.join(work, '.claude'), { recursive: true });
fs.writeFileSync(path.join(work, '.claude', 'settings.json'), '{}');

const cli = process.env.SB_CLAUDE || 'claude.cmd';
const args = [
  '--output-format', 'stream-json',
  '--verbose',
  '--input-format', 'stream-json',
  '--include-partial-messages',
  '--permission-prompt-tool', 'stdio',
];

const isCmd = process.platform === 'win32' && cli.toLowerCase().endsWith('.cmd');
const proc = spawn(isCmd ? 'cmd.exe' : cli, isCmd ? ['/c', cli, ...args] : args, {
  cwd: work,
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
  env: { ...process.env },
});

let buf = '';
const seen = [];
proc.stdout.on('data', (d) => {
  buf += d.toString('utf8');
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try {
      const m = JSON.parse(line);
      const tag = `${m.type}${m.subtype ? ':' + m.subtype : ''}`;
      seen.push(tag);
      const brief = JSON.stringify(m).slice(0, 260);
      console.log(`[out] ${tag}  ${brief}`);
    } catch {
      console.log('[out-raw]', line.slice(0, 200));
    }
  }
});
proc.stderr.on('data', (d) => console.log('[err]', d.toString().trim().slice(0, 400)));
proc.on('exit', (c, s) => {
  console.log(`\n[exit] code=${c} signal=${s}`);
  console.log('[types seen]', [...new Set(seen)].join(', ') || '(none)');
});

// Send one user message in the SDK's envelope shape.
setTimeout(() => {
  const msg = {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: 'Reply with exactly: PROBE-OK' }] },
    parent_tool_use_id: null,
    session_id: '',
  };
  console.log('[in ]', JSON.stringify(msg).slice(0, 160));
  proc.stdin.write(JSON.stringify(msg) + '\n');
}, 1500);

setTimeout(() => {
  console.log('[probe] timeout — killing');
  proc.kill();
  process.exit(0);
}, 60_000);
