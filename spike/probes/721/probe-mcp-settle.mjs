// #729 — does `mcp_status` change its answer as the session warms up?
//
// The first `mcp_status` on a cold session answered `status:"pending"` with NO
// `serverInfo` and NO `tools[]` — strictly less than §1.2.2's captured example,
// which has all three. If that is a TIMING fact rather than a machine
// difference, then a pane that fires `mcp_status` the instant it opens gets a
// worse answer than one that waits, and "pending" is a state the UI has to be
// able to draw rather than a bug.
//
// Read-only: `mcp_status` mutates nothing. Polls the same verb on a schedule
// and prints only what CHANGED, so the transition is the output.
import { spawn } from 'node:child_process';

const cwd = process.argv[2] || process.cwd();
const cli =
  process.env.CLAUDE_BIN ||
  'C:/Users/dheinz/AppData/Roaming/npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe';
const args = [
  '--output-format', 'stream-json',
  '--verbose',
  '--input-format', 'stream-json',
  '--permission-prompt-tool', 'stdio',
  '--replay-user-messages',
  '--include-partial-messages',
];

const child = spawn(cli, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
const t0 = Date.now();
let buf = '';
let n = 0;
let last = '';

const send = (request) => {
  const id = 'sb-' + ++n;
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
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    // `system:init` carries `mcp_servers` too — worth comparing against the
    // control channel's answer, since it is the one the feed already sees.
    if (m.type === 'system' && m.subtype === 'init') {
      console.log(`[${Date.now() - t0}ms] INIT.mcp_servers =`, JSON.stringify(m.mcp_servers));
      continue;
    }
    if (m.type !== 'control_response') continue;
    const r = m.response || {};
    const body = JSON.stringify(r.subtype === 'error' ? r.error : r.response);
    if (body === last) {
      console.log(`[${Date.now() - t0}ms] (unchanged)`);
      continue;
    }
    last = body;
    console.log(`[${Date.now() - t0}ms] ${r.subtype} = ${body.slice(0, 3000)}`);
  }
});
child.stderr.on('data', (d) => process.stderr.write('[err] ' + d));

for (const at of [500, 2000, 5000, 10000, 20000, 30000]) {
  setTimeout(() => send({ subtype: 'mcp_status' }), at);
}
setTimeout(() => {
  child.kill();
  process.exit(0);
}, 34000);
