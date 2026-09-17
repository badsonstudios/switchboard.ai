// Launch main.cjs under the REAL Electron runtime (not `ELECTRON_RUN_AS_NODE`).
//
// The check:* family goes through scripts/run-electron-node.js, which sets
// ELECTRON_RUN_AS_NODE=1 — and under that flag there is no `app` module at
// all, so it cannot host this probe. Hence a launcher of its own.
//
// Usage: node spike/probes/719/run.mjs [seconds]
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const electron = require('electron'); // plain-node require -> path to the binary

const env = { ...process.env };
// This project dogfoods itself: an inherited ELECTRON_RUN_AS_NODE from a parent
// Electron would silently turn the probe into a plain node script with no app.
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electron, [path.join(here, 'main.cjs'), ...process.argv.slice(2)], {
  stdio: 'inherit',
  env,
});
child.on('exit', (code) => {
  process.exitCode = code ?? 1;
});
