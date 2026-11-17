// #1612: what a hook costs to START, the shell form vs the exec form.
// Times N spawns of the real forwarder against a throwaway listener on this
// machine, the way the CLI spawns them: through Git Bash (`bash -c "<cmd>"`,
// what a hook without `args` does here) and directly (`node <args>`).
// Usage: node hook-spawn-bench.mjs <forwarderPath> [N]
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const forwarder = process.argv[2];
const N = Number(process.argv[3] ?? 30);
if (!forwarder || !fs.existsSync(forwarder)) {
  console.error('forwarder path required');
  process.exit(2);
}
const tokenPath = path.join(os.tmpdir(), `sb-bench-token-${process.pid}`);
fs.writeFileSync(tokenPath, 'bench-token');
const server = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => res.end('{}'));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const node = process.execPath;
const payload = JSON.stringify({ hook_event_name: 'PostToolUse', session_id: 'bench', tool_name: 'Read' });

function once(cmd, args) {
  return new Promise((resolve) => {
    const t0 = process.hrtime.bigint();
    const p = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
    p.stdin.end(payload);
    p.on('exit', () => resolve(Number(process.hrtime.bigint() - t0) / 1e6));
  });
}
const bash = 'C:/Program Files/Git/bin/bash.exe';
const shellCmd = `"${node}" "${forwarder}" ${port} "${tokenPath}"`;
const forms = {
  shell: () => once(bash, ['-c', shellCmd]),
  exec: () => once(node, [forwarder, String(port), tokenPath]),
};
const results = { shell: [], exec: [] };
// alternate, so background load hits both forms alike
for (let i = 0; i < N; i++) {
  for (const k of i % 2 ? ['exec', 'shell'] : ['shell', 'exec']) results[k].push(await forms[k]());
}
const stat = (a) => {
  const s = [...a].sort((x, y) => x - y);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { median: q(0.5).toFixed(0), p90: q(0.9).toFixed(0), min: s[0].toFixed(0), max: s[s.length - 1].toFixed(0) };
};
console.log(JSON.stringify({ N, shell: stat(results.shell), exec: stat(results.exec) }));
server.close();
fs.rmSync(tokenPath, { force: true });
