// #729 PR 2 review follow-up — does `mcp_reconnect` UNDO a `mcp_toggle`?
//
// Review asked, because "Reconnect all" loops over every row including the ones
// the user deliberately turned off. Two possible answers needing opposite code:
// if reconnect re-enables, the loop silently undoes a persisted decision; if it
// refuses, the loop reports "didn't come back" about a server that is off on
// purpose. Either way the disabled rows get filtered — this measures WHICH
// wrongness we are avoiding, and whether a per-row Reconnect on a disabled row
// is safe to offer at all.
//
// Brings its own throwaway server, same as `probe-mcp-toggle.mjs`.
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const cwd = process.argv[2] || process.cwd();
const cli =
  process.env.CLAUDE_BIN ||
  'C:/Users/dheinz/AppData/Roaming/npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe';
const NAME = 'sbprobe';
const SEP = String.fromCharCode(92); // backslash, spelled this way to survive shell heredocs

const mcpCmd = (a) => {
  try {
    return execFileSync(cli, ['mcp', ...a], { cwd, encoding: 'utf8' }).trim();
  } catch (e) {
    return `(failed: ${String(e.stderr || e.message).slice(0, 160)})`;
  }
};

const norm = (p) => p.toLowerCase().split('/').join(SEP).replace(new RegExp(SEP + '+$'), '');

/**
 * The one key a toggle writes.
 *
 * ⚠️ **DO NOT TRUST THIS FUNCTION'S OUTPUT — IT IS WRONG ON THIS MACHINE, and
 * it is left here as the demonstration.** `norm` lowercases before comparing,
 * and `~/.claude.json` holds BOTH `c:/Projects/Switchboard.ai` and
 * `C:/Projects/Switchboard.ai` as separate project keys (that is #724). So the
 * first match wins and it is the lowercase entry, which has no `mcpServers` and
 * no toggles — hence a flat `null` at every step, including right after a
 * toggle that demonstrably worked.
 *
 * The persistence question is answered by `probe-mcp-toggle.mjs`, which does
 * the lookup properly. The README's standing lesson applies: **a quiet answer
 * is worth suspecting your own probe over.** This is the second time on this
 * ticket.
 *
 * The RECONNECT question this file exists for is unaffected — it is answered by
 * `mcp_status`, off the wire, not by this.
 */
const disabledList = () => {
  try {
    const j = JSON.parse(readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8'));
    for (const [k, v] of Object.entries(j.projects ?? {})) {
      if (norm(k) === norm(cwd)) return JSON.stringify(v.disabledMcpServers ?? null);
    }
  } catch {
    /* ignore */
  }
  return '(unreadable)';
};

console.log('disabledMcpServers BEFORE:', disabledList());
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
  console.log(`-> ${label}`);
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
    if (label === 'status') {
      const rows = (r.response?.mcpServers ?? []).map((s) => `${s.name}=${s.status}`);
      console.log(`<- status: ${rows.join(', ')}`);
      continue;
    }
    const body = r.subtype === 'error' ? r.error : (r.response ?? null);
    console.log(`<- ${label}: ${r.subtype} ${JSON.stringify(body).slice(0, 200)}`);
  }
});
child.stderr.on('data', (d) => process.stderr.write('[err] ' + d));

setTimeout(() => send('status', { subtype: 'mcp_status' }), 6000);
setTimeout(() => {
  console.log('\n--- turn it OFF ---');
  send('toggle-off', { subtype: 'mcp_toggle', serverName: NAME, enabled: false });
}, 8000);
setTimeout(() => send('status', { subtype: 'mcp_status' }), 10000);
setTimeout(() => console.log('disabledMcpServers after OFF:', disabledList()), 11000);
setTimeout(() => {
  console.log('\n--- NOW RECONNECT IT. Does that undo the toggle? ---');
  send('reconnect-disabled', { subtype: 'mcp_reconnect', serverName: NAME });
}, 13000);
setTimeout(() => send('status', { subtype: 'mcp_status' }), 16000);
setTimeout(
  () =>
    console.log(
      'disabledMcpServers after RECONNECT:',
      disabledList(),
      '\n   ^^ back to connected / list emptied => reconnect UNDOES the toggle'
    ),
  17000
);

setTimeout(() => {
  console.log('\n--- cleanup ---');
  send('toggle-on', { subtype: 'mcp_toggle', serverName: NAME, enabled: true });
}, 19000);
setTimeout(() => {
  console.log(mcpCmd(['remove', NAME, '-s', 'local']));
  console.log('disabledMcpServers AFTER CLEANUP:', disabledList());
  child.kill();
  process.exit(0);
}, 22000);
