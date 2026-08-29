// #729 — do `mcp_toggle` and `mcp_reconnect` EXIST, and what do they answer?
//
// #632 and #714 both concluded there is no enable/disable verb. That was a
// claim about `claude mcp --help` stated as a fact about the whole CLI; both
// subtypes are present in the 2.1.245 binary and in Anthropic's own VS Code
// extension. LOCATED IS NOT VERIFIED, so this measures them.
//
// ── WHY EVERY CALL NAMES A SERVER THAT DOES NOT EXIST ────────────────────────
//
// `mcp_toggle` mutates. Running it against a real server on Dan's machine would
// be a probe with a side effect, and we do not know yet whether the effect
// persists to disk. We do not need to: the CLI distinguishes an unknown VERB
// from an unknown ARGUMENT, measured on #721 —
//
//   unknown verb      -> "Unsupported control request subtype: <name>"
//   known verb, bad arg -> some other sentence entirely
//
// so a call with a deliberately absent server name proves existence without
// touching anything. A REAL toggle is a separate, consented step.
//
// Also checks the `set_model` trap on `mcp_toggle`: does an ABSENT `enabled`
// field answer `success` and do nothing? That was the measured silent no-op
// that made `setModelRequest` validate before the wire.
import { spawn } from 'node:child_process';

const cwd = process.argv[2] || process.cwd();
const cli =
  process.env.CLAUDE_BIN ||
  'C:/Users/dheinz/AppData/Roaming/npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe';
// The same flag list as `main/providers/claude.ts`, so we are talking to the
// CLI in the mode the app actually spawns it in.
const args = [
  '--output-format', 'stream-json',
  '--verbose',
  '--input-format', 'stream-json',
  '--permission-prompt-tool', 'stdio',
  '--replay-user-messages',
  '--include-partial-messages',
];

const child = spawn(cli, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
let buf = '';
let n = 0;
const sent = new Map();

const send = (label, request) => {
  const id = 'sb-' + ++n;
  sent.set(id, label);
  child.stdin.write(JSON.stringify({ type: 'control_request', request_id: id, request }) + '\n');
  console.log(`-> [${id}] ${label}`);
  return id;
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
      console.log('RAW:', line.slice(0, 300));
      continue; // `continue`, not `return` — probe721b's bug, see the README
    }
    if (m.type === 'control_response') {
      const r = m.response || {};
      // request_id is NESTED (#721 finding 1) — the whole reason a correlator
      // copied from the inbound reader matches nothing.
      const label = sent.get(r.request_id) || '?';
      const payload = r.subtype === 'error' ? r.error : r.response;
      console.log(
        `<- [${r.request_id}] ${label}: ${r.subtype} = ${JSON.stringify(payload ?? null).slice(0, 4000)}`
      );
    }
  }
});
child.stderr.on('data', (d) => process.stderr.write('[err] ' + d));

// Cold session, no `initialize` handshake — measured unnecessary (#721 finding 1).
setTimeout(() => {
  console.log('\n=== 1. the inventory we want to source from ===');
  send('mcp_status', { subtype: 'mcp_status' });
}, 800);

setTimeout(() => {
  console.log('\n=== 2. does mcp_toggle exist? (nonexistent server, no mutation) ===');
  send('mcp_toggle/absent-server', {
    subtype: 'mcp_toggle',
    serverName: '__switchboard_probe_does_not_exist__',
    enabled: false,
  });
  console.log('\n=== 3. the set_model trap: mcp_toggle with NO `enabled` field ===');
  send('mcp_toggle/no-enabled', {
    subtype: 'mcp_toggle',
    serverName: '__switchboard_probe_does_not_exist__',
  });
  console.log('\n=== 4. mcp_toggle with NO serverName ===');
  send('mcp_toggle/no-server', { subtype: 'mcp_toggle', enabled: false });
  console.log('\n=== 5. does mcp_reconnect exist? (nonexistent server) ===');
  send('mcp_reconnect/absent-server', {
    subtype: 'mcp_reconnect',
    serverName: '__switchboard_probe_does_not_exist__',
  });
  console.log('\n=== 6. control: a verb we know does not exist ===');
  send('__definitely_not_a_verb__', { subtype: '__definitely_not_a_verb__' });
}, 3000);

setTimeout(() => {
  child.kill();
  process.exit(0);
}, 20000);
