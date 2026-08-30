// MCP connector sign-in — what do `mcp_authenticate` / `mcp_clear_auth` do?
//
// Found while auditing #633's verb list: three auth verbs exist on the PATH CLI
// and switchboard uses none of them. PR 2 of #729 shipped a `needs-auth` row
// state with nothing behind it, so a connector that wants signing in says so
// and offers no button. That gap only shows on a machine with claude.ai
// connectors — Dan's work laptop — which is exactly why it was never noticed
// here.
//
// ── WHAT THIS CAN AND CANNOT ANSWER ──────────────────────────────────────────
//
// CAN: the refusal shapes, which is most of what a UI needs. What does the CLI
// say for a server that does not exist, and for one that exists but has no
// authentication to do? Those two cover every row on a machine with no
// connectors — i.e. every row this dev machine has.
//
// CANNOT: the actual OAuth round trip. That needs a real claude.ai connector,
// and there is none here. **Do not infer the success path from this file.**
// The consumer must therefore treat an unrecognised answer as "we do not know"
// rather than as success — the fail-open rule the rest of the MCP code follows.
//
// Brings its own throwaway stdio server, same as the other probes here.
import { spawn, execFileSync } from 'node:child_process';

const cwd = process.argv[2] || process.cwd();
const cli =
  process.env.CLAUDE_BIN ||
  'C:/Users/dheinz/AppData/Roaming/npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe';
const NAME = 'sbprobe';

const mcpCmd = (a) => {
  try {
    return execFileSync(cli, ['mcp', ...a], { cwd, encoding: 'utf8' }).trim();
  } catch (e) {
    return `(failed: ${String(e.stderr || e.message).slice(0, 160)})`;
  }
};

console.log(mcpCmd(['add', NAME, '-s', 'local', '--', 'claude', 'mcp', 'serve']));

const child = spawn(
  cli,
  ['--output-format', 'stream-json', '--verbose', '--input-format', 'stream-json',
   '--permission-prompt-tool', 'stdio', '--replay-user-messages', '--include-partial-messages'],
  { cwd, stdio: ['pipe', 'pipe', 'pipe'] }
);
let buf = '';
let n = 0;
const sent = new Map();
const send = (label, request) => {
  const id = 'sb-' + ++n;
  sent.set(id, label);
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
    if (m.type !== 'control_response') continue;
    const r = m.response || {};
    const label = sent.get(r.request_id);
    if (!label) continue;
    if (label === 'status') {
      const rows = (r.response?.mcpServers ?? []).map((s) => `${s.name}=${s.status}`);
      console.log(`  status: ${rows.join(', ')}`);
      continue;
    }
    const body = r.subtype === 'error' ? r.error : (r.response ?? null);
    console.log(`  ${label.padEnd(34)} ${r.subtype}: ${JSON.stringify(body).slice(0, 200)}`);
  }
});
child.stderr.on('data', (d) => process.stderr.write('[err] ' + d));

setTimeout(() => {
  console.log('\n=== baseline ===');
  send('status', { subtype: 'mcp_status' });
}, 6000);

setTimeout(() => {
  console.log('\n=== the refusal shapes a UI has to render ===');
  // 1. no argument at all — is `serverName` validated, or does it act on undefined?
  send('authenticate/no-arg', { subtype: 'mcp_authenticate' });
  // 2. a server that does not exist
  send('authenticate/absent', { subtype: 'mcp_authenticate', serverName: '__nope__' });
  // 3. a REAL stdio server with nothing to authenticate — the common case on a
  //    machine with no connectors, and the one most rows will hit
  send('authenticate/stdio', { subtype: 'mcp_authenticate', serverName: NAME });
  send('clearAuth/stdio', { subtype: 'mcp_clear_auth', serverName: NAME });
  send('clearAuth/absent', { subtype: 'mcp_clear_auth', serverName: '__nope__' });
  send('callbackUrl/stdio', { subtype: 'mcp_oauth_callback_url', serverName: NAME });
}, 8000);

setTimeout(() => {
  console.log('\n=== did any of that change the server state? ===');
  send('status', { subtype: 'mcp_status' });
}, 12000);

setTimeout(() => {
  console.log('\n=== cleanup ===');
  console.log(mcpCmd(['remove', NAME, '-s', 'local']));
  child.kill();
  process.exit(0);
}, 15000);
