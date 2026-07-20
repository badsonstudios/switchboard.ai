// Launch electron-vite with a cleaned environment. Running from inside an
// Electron-hosted terminal (VS Code, a hosted Claude Code session — i.e. how
// this project dogfoods itself) leaks env vars that break Electron children:
// ELECTRON_RUN_AS_NODE turns our app into plain Node, and
// NoDefaultCurrentDirectoryInExePath breaks native-module gyp builds.
// Spike 01 findings (s-01-pty-host.md) — this is the day-one mitigation.
const { spawnSync } = require('child_process');
const path = require('path');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_NO_ATTACH_CONSOLE;
delete env.NoDefaultCurrentDirectoryInExePath;

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
