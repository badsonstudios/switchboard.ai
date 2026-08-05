// Launch electron-vite with a cleaned environment — see scripts/clean-env.js
// for which variables and why (S-01 findings, s-01-pty-host.md). This is the
// day-one mitigation for a project that dogfoods itself.
const { spawnSync } = require('child_process');
const path = require('path');
const { cleanEnv } = require('./clean-env');

const env = cleanEnv();

const bin = path.join(
  __dirname, '..', 'node_modules', '.bin',
  process.platform === 'win32' ? 'electron-vite.cmd' : 'electron-vite'
);
const r = spawnSync(
  process.platform === 'win32' ? `"${bin}"` : bin,
  process.argv.slice(2),
  {
    stdio: 'inherit',
    env,
    shell: process.platform === 'win32', // .cmd shims need a shell on Windows
  }
);
if (r.error) {
  console.error(`ev: failed to launch electron-vite: ${r.error.message}`);
  process.exit(1);
}
process.exit(r.status ?? 1);
