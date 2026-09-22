// Stands in for `npx -y <server>`: a node process whose only job is to start
// the real server as a CHILD and wait on it — the wrapper + server pair the
// laptop showed 53 of.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
fs.writeFileSync(path.join(process.env.PROBE_OUT, `wrapper-${process.pid}.pid`), String(process.pid));
// PROBE_DELAY_MS stands in for npx's own startup (registry check for @latest,
// cache walk, AV scan of every file) — seconds on a laptop running VIPRE.
setTimeout(() => {
  const child = spawn(process.execPath, [path.join(__dirname, 'mcp-server.cjs')], {
    stdio: 'inherit',
    windowsHide: true,
  });
  child.on('exit', (code) => process.exit(code ?? 0));
}, Number(process.env.PROBE_DELAY_MS ?? 0));
