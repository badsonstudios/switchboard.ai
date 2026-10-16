// A stub stdio MCP server standing in for the Session Bus. It answers
// `initialize`, `tools/list` (one tool, `probe_echo`) and `tools/call`, and logs
// every message it receives, its argv and the env names it was given, to
// STUB_LOG — so the probe can prove whether Codex launched it and listed its
// tools when it was passed through ACP `session/new` `mcpServers`.

import fs from 'node:fs';

const LOG = process.env.STUB_LOG || 'mcp-stub.log';
const log = (rec) => fs.appendFileSync(LOG, JSON.stringify({ t: Date.now(), ...rec }) + '\n');
log({ ev: 'started', argv: process.argv.slice(2), pid: process.pid, cwd: process.cwd(), probeEnv: process.env.PROBE_STUB_MARK ?? null });

const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      log({ ev: 'nonjson', line });
      continue;
    }
    log({ ev: 'recv', msg: m });
    if (m.id === undefined) continue;
    if (m.method === 'initialize') {
      send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'probe-stub', version: '0.0.1' } } });
    } else if (m.method === 'tools/list') {
      send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'probe_echo', description: 'Echo the given text back, prefixed with stub-echo:', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] } });
    } else if (m.method === 'tools/call') {
      send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'stub-echo:' + (m.params?.arguments?.text ?? '') }] } });
    } else {
      send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'not in stub' } });
    }
  }
});
process.stdin.on('end', () => {
  log({ ev: 'stdin-end' });
  process.exit(0);
});
