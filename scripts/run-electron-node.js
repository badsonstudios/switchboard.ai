// Run a script under Electron's Node (`ELECTRON_RUN_AS_NODE=1 electron.exe`)
// — required for anything loading native modules built for Electron's ABI
// (node-pty). Usage: node scripts/run-electron-node.js <script> [args...]
const { spawnSync } = require('child_process');
const path = require('path');

const electron = require('electron'); // plain-node require -> path to binary
const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
delete env.ELECTRON_NO_ATTACH_CONSOLE;
delete env.NoDefaultCurrentDirectoryInExePath;

const r = spawnSync(electron, process.argv.slice(2), {
  stdio: 'inherit',
  env,
  cwd: path.join(__dirname, '..'),
});
if (r.error) {
  console.error(`run-electron-node: ${r.error.message}`);
  process.exit(1);
}
process.exit(r.status ?? 1);
