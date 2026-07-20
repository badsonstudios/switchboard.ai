// Double-click launch path: spawn the built app under Electron with the
// Windows env landmines scrubbed (S-01 findings). Mirrors the verified smoke
// path (electron '.'), not the dev server.
const { spawnSync } = require('child_process');
const path = require('path');

const electron = require('electron'); // plain-node require -> path to binary
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_NO_ATTACH_CONSOLE;
delete env.NoDefaultCurrentDirectoryInExePath;

const r = spawnSync(electron, ['.'], {
  stdio: 'inherit',
  cwd: path.join(__dirname, '..'),
  env,
});
process.exit(r.status ?? 1);
