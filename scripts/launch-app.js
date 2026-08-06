// Double-click launch path: spawn the built app under Electron with the
// Windows env landmines scrubbed (S-01 findings). Mirrors the verified smoke
// path (electron '.'), not the dev server.
const { spawnSync } = require('child_process');
const path = require('path');
const { cleanEnv } = require('./clean-env');

const electron = require('electron'); // plain-node require -> path to binary
const env = cleanEnv();

const r = spawnSync(electron, ['.'], {
  stdio: 'inherit',
  cwd: path.join(__dirname, '..'),
  env,
});
process.exit(r.status ?? 1);
