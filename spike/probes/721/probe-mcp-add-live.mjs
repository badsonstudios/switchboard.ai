// #729 — does `mcp_status` NOTICE a server added after the session started?
//
// THE QUESTION DECIDES A UI DECISION. If the runtime list is frozen at spawn,
// then sourcing the pane from it means an Add succeeds and changes nothing on
// screen — and a Remove leaves its row sitting there. If the CLI re-resolves,
// the pane is simply correct.
//
// Raised in review of #729 PR 1, which declined to assume either way. The
// manual's own "a session that's already running loaded its servers when it
// started" says one thing; nothing had measured it.
//
// MUTATES, AND CLEANS UP AFTER ITSELF: adds `sbprobe` at local scope for this
// repo, polls, then removes it and polls again. Both halves matter — "does an
// add appear" and "does a remove disappear" are separate questions.
import { spawn, execFileSync } from 'node:child_process';

const cwd = process.argv[2] || process.cwd();
const cli =
  process.env.CLAUDE_BIN ||
  'C:/Users/dheinz/AppData/Roaming/npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe';
const NAME = 'sbprobe';

const mcpCmd = (args) => {
  try {
    return execFileSync(cli, ['mcp', ...args], { cwd, encoding: 'utf8' }).trim();
  } catch (e) {
    return `(failed: ${String(e.stderr || e.message).slice(0, 200)})`;
  }
};

const child = spawn(
  cli,
  ['--output-format', 'stream-json', '--verbose', '--input-format', 'stream-json',
   '--permission-prompt-tool', 'stdio', '--replay-user-messages', '--include-partial-messages'],
  { cwd, stdio: ['pipe', 'pipe', 'pipe'] }
);
const t0 = Date.now();
let buf = '';
let n = 0;
const send = () =>
  child.stdin.write(
    JSON.stringify({ type: 'control_request', request_id: 'sb-' + ++n, request: { subtype: 'mcp_status' } }) + '\n'
  );

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
    const names = (m.response?.response?.mcpServers ?? []).map((s) => `${s.name}(${s.status})`);
    console.log(`[${Date.now() - t0}ms] ${names.join(', ') || '(none)'}   ${names.some((x) => x.startsWith(NAME)) ? '<-- PROBE SERVER PRESENT' : ''}`);
  }
});
child.stderr.on('data', (d) => process.stderr.write('[err] ' + d));

setTimeout(() => { console.log('\n--- baseline, before the add ---'); send(); }, 1000);
setTimeout(() => {
  console.log('\n--- adding `sbprobe` with the CLI, session already running ---');
  console.log('   ', mcpCmd(['add', NAME, '-s', 'local', '--', 'claude', 'mcp', 'serve']));
}, 4000);
for (const at of [6000, 10000, 16000]) setTimeout(send, at);
setTimeout(() => {
  console.log('\n--- removing it again ---');
  console.log('   ', mcpCmd(['remove', NAME, '-s', 'local']));
}, 20000);
for (const at of [22000, 27000]) setTimeout(send, at);

setTimeout(() => {
  // BELT AND BRACES: if anything above threw, the entry must still not survive
  // this script. It is a server that runs a program on Dan's machine.
  console.log('\n--- final cleanup check ---');
  console.log('   ', mcpCmd(['remove', NAME, '-s', 'local']));
  child.kill();
  process.exit(0);
}, 30000);
