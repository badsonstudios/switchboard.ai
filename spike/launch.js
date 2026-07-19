// Launch Electron with a cleaned environment. When the harness is started from
// inside another Electron app (VS Code terminal, Claude Code session — i.e.
// exactly how this project dogfoods itself), ELECTRON_RUN_AS_NODE=1 leaks in
// and turns Electron into plain Node. See findings/s-01-pty-host.md.
const { spawnSync } = require('child_process');
const electronBin = require('electron'); // plain-node require → path to binary

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_NO_ATTACH_CONSOLE;

const r = spawnSync(electronBin, ['.', ...process.argv.slice(2)], {
  stdio: 'inherit',
  cwd: __dirname,
  env,
});
process.exit(r.status ?? 1);
