// A minimal stdio MCP server that records its own pid, so the probe can tell
// afterwards whether it survived its session. Answers just enough of the
// protocol (initialize, tools/list) that the CLI keeps it connected.
const fs = require('fs');
const path = require('path');
fs.writeFileSync(path.join(process.env.PROBE_OUT, `server-${process.pid}.pid`), String(process.pid));

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.id === undefined) continue;
    let result = {};
    if (msg.method === 'initialize') {
      result = {
        protocolVersion: msg.params?.protocolVersion ?? '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'probe', version: '0.0.1' },
      };
    } else if (msg.method === 'tools/list') {
      result = { tools: [] };
    }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n');
  }
});
// Deliberately NOT exiting on stdin end: a real npx-launched server that
// outlives its pipe is exactly the thing being measured.
setInterval(() => {}, 1 << 30);
