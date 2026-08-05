// The Windows env landmines, in ONE place (S-01 findings, s-01-pty-host.md).
//
// Everything in `scripts/` that spawns Electron — or tooling that itself
// spawns Electron — has to scrub the same three variables, because this
// project dogfoods itself: `npm run …` is routinely typed inside an
// Electron-hosted terminal (VS Code, a hosted Claude Code session), which
// leaks them into every child.
//
//  - ELECTRON_RUN_AS_NODE turns a launched Electron app into plain Node, so
//    the app starts with no window and no `app` module and looks hung.
//  - ELECTRON_NO_ATTACH_CONSOLE changes console handling for the child.
//  - NoDefaultCurrentDirectoryInExePath breaks node-gyp/winpty native builds.
//
// It lived as four hand-copied blocks until P2-E19-01 added a fifth spawner
// (electron-builder), which is one copy past the point where "they all agree"
// is something anyone can still check by eye.
'use strict';

/** the variables that must never reach a spawned Electron / native build */
const LANDMINES = [
  'ELECTRON_RUN_AS_NODE',
  'ELECTRON_NO_ATTACH_CONSOLE',
  'NoDefaultCurrentDirectoryInExePath',
];

/**
 * A copy of `process.env` with the landmines removed and `overrides` applied.
 *
 * `overrides` is applied AFTER the deletions on purpose: `run-electron-node.js`
 * genuinely wants ELECTRON_RUN_AS_NODE=1, and must be able to set the very
 * variable this function exists to remove.
 *
 * @param {NodeJS.ProcessEnv} [overrides]
 * @returns {NodeJS.ProcessEnv}
 */
function cleanEnv(overrides) {
  const env = { ...process.env };
  for (const key of LANDMINES) delete env[key];
  return overrides ? { ...env, ...overrides } : env;
}

module.exports = { cleanEnv, LANDMINES };
