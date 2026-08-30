// #729 PR 2 — the three things `mcp_toggle` / `mcp_reconnect` have not told us.
//
// probe-mcp-verbs.mjs proved both verbs EXIST, using a server name that does
// not exist so nothing was mutated. That trick is spent: every remaining
// question needs a REAL server, because the CLI's lookup runs before anything
// else and a fake name never gets past it.
//
// ── SO IT BRINGS ITS OWN SERVER ──────────────────────────────────────────────
//
// `sbprobe` is added by this script and removed by this script. Dan's real
// servers are never named, never toggled and never removed — which is why this
// needs no permission that `probe-mcp-add-live.mjs` did not already have.
// It also prints the `~/.claude.json` MCP-relevant keys before and after, so
// "did the toggle persist" is answered by a diff rather than by an opinion.
//
// THE THREE QUESTIONS:
//
//  1. Does `mcp_toggle` with a valid `serverName` and NO `enabled` field answer
//     `success` and do nothing? That is the measured `set_model` shape, and if
//     it repeats here the builder MUST validate before the wire.
//  2. Does a toggle PERSIST to disk, or die with the session? Decides whether
//     the UI says "turned off" or "turned off for this session".
//  3. Does `mcp_reconnect` pick up a server the session NEVER LOADED? PR 1
//     measured that `mcp_status` is frozen at spawn; if reconnect thaws it, the
//     "not loaded by this session" group gets a working per-row button. If not,
//     its only honest advice is "restart the session".
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const cwd = process.argv[2] || process.cwd();
const cli =
  process.env.CLAUDE_BIN ||
  'C:/Users/dheinz/AppData/Roaming/npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe';
const NAME = 'sbprobe';
const CLAUDE_JSON = path.join(os.homedir(), '.claude.json');

const mcpCmd = (args) => {
  try {
    return execFileSync(cli, ['mcp', ...args], { cwd, encoding: 'utf8' }).trim();
  } catch (e) {
    return `(failed: ${String(e.stderr || e.message).slice(0, 200)})`;
  }
};

/** Everything in `~/.claude.json` that could record a toggle, for THIS project
 *  and at top level. The diff between two of these is question 2's answer. */
const configFingerprint = () => {
  let j;
  try {
    j = JSON.parse(readFileSync(CLAUDE_JSON, 'utf8'));
  } catch (e) {
    return `(unreadable: ${e.message})`;
  }
  const proj = j.projects?.[cwd] ?? j.projects?.[cwd.replace(/\//g, '\\')] ?? {};
  return JSON.stringify(
    {
      projectMcpServers: Object.keys(proj.mcpServers ?? {}),
      enabledMcpjsonServers: proj.enabledMcpjsonServers,
      disabledMcpjsonServers: proj.disabledMcpjsonServers,
      // any key with "abled" and "cp" in it that we have not thought of
      otherProjectKeys: Object.keys(proj).filter((k) => /disabled|enabled/i.test(k)),
      topLevelMcpServers: Object.keys(j.mcpServers ?? {}),
      topLevelToggleKeys: Object.keys(j).filter((k) => /disabled|enabled/i.test(k)),
    },
    null,
    0
  );
};

console.log('BEFORE ANYTHING:', configFingerprint());
console.log(`\n--- adding \`${NAME}\` BEFORE the session starts, so it is loaded ---`);
console.log('   ', mcpCmd(['add', NAME, '-s', 'local', '--', 'claude', 'mcp', 'serve']));
console.log('AFTER ADD:      ', configFingerprint());

const child = spawn(
  cli,
  ['--output-format', 'stream-json', '--verbose', '--input-format', 'stream-json',
   '--permission-prompt-tool', 'stdio', '--replay-user-messages', '--include-partial-messages'],
  { cwd, stdio: ['pipe', 'pipe', 'pipe'] }
);
const t0 = Date.now();
let buf = '';
let n = 0;
const sent = new Map();
const send = (label, request) => {
  const id = 'sb-' + ++n;
  sent.set(id, label);
  child.stdin.write(JSON.stringify({ type: 'control_request', request_id: id, request }) + '\n');
  console.log(`-> [${id}] ${label}`);
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
    const label = sent.get(r.request_id) || '?';
    if (label === 'mcp_status') {
      const rows = (r.response?.mcpServers ?? []).map((s) => `${s.name}(${s.status})`);
      console.log(`<- [${Date.now() - t0}ms] mcp_status: ${rows.join(', ') || '(none)'}`);
      continue;
    }
    const payload = r.subtype === 'error' ? r.error : r.response;
    console.log(`<- [${Date.now() - t0}ms] ${label}: ${r.subtype} = ${JSON.stringify(payload ?? null).slice(0, 800)}`);
  }
});
child.stderr.on('data', (d) => process.stderr.write('[err] ' + d));

// Let the session settle past the measured ~5s pending window first.
setTimeout(() => { console.log('\n=== baseline: is sbprobe loaded? ==='); send('mcp_status', { subtype: 'mcp_status' }); }, 6000);

setTimeout(() => {
  console.log('\n=== Q1: mcp_toggle on a REAL server with NO `enabled` field ===');
  console.log('    (the set_model trap: does it answer success and do nothing?)');
  send('toggle/no-enabled', { subtype: 'mcp_toggle', serverName: NAME });
}, 8000);
setTimeout(() => send('mcp_status', { subtype: 'mcp_status' }), 10000);

setTimeout(() => {
  console.log('\n=== Q2: a REAL toggle off ===');
  send('toggle/off', { subtype: 'mcp_toggle', serverName: NAME, enabled: false });
}, 12000);
setTimeout(() => send('mcp_status', { subtype: 'mcp_status' }), 14000);
setTimeout(() => {
  console.log('AFTER TOGGLE OFF:', configFingerprint(), '   <-- Q2: did it persist?');
}, 15000);

setTimeout(() => {
  console.log('\n=== and back on ===');
  send('toggle/on', { subtype: 'mcp_toggle', serverName: NAME, enabled: true });
}, 16000);
setTimeout(() => {
  console.log('AFTER TOGGLE ON: ', configFingerprint());
}, 18000);

// Q3 — a server the session never loaded. Added AFTER spawn, so `mcp_status`
// cannot see it (PR 1 measured that). Does reconnect thaw it?
setTimeout(() => {
  console.log('\n=== Q3: add a SECOND server mid-session, then mcp_reconnect it ===');
  console.log('   ', mcpCmd(['add', NAME + '2', '-s', 'local', '--', 'claude', 'mcp', 'serve']));
  send('mcp_status', { subtype: 'mcp_status' });
}, 20000);
setTimeout(() => send('reconnect/never-loaded', { subtype: 'mcp_reconnect', serverName: NAME + '2' }), 23000);
setTimeout(() => {
  console.log('   (does sbprobe2 appear below? that is Q3)');
  send('mcp_status', { subtype: 'mcp_status' });
}, 26000);

// ── CLEANUP, unconditionally ────────────────────────────────────────────────
setTimeout(() => {
  console.log('\n=== cleanup ===');
  console.log('   ', mcpCmd(['remove', NAME, '-s', 'local']));
  console.log('   ', mcpCmd(['remove', NAME + '2', '-s', 'local']));
  console.log('AFTER CLEANUP:  ', configFingerprint());
  console.log('\n^^ compare with BEFORE ANYTHING at the top. They must match.');
  child.kill();
  process.exit(0);
}, 30000);
