// `npm run package` — build, then wrap `out/` in a Windows installer
// (P2-E19-01). Output: dist/switchboard-Setup-<version>.exe.
//
// Two things this wrapper exists for:
//
//  1. The env scrub (scripts/clean-env.js). electron-builder spawns Electron
//     itself — to read the app's version and to run its native-dep logic — so
//     it inherits the same S-01 landmines every other spawner here scrubs.
//     Running `npm run package` from inside a hosted terminal without this is
//     how you get a packaging failure that reproduces on nobody else's box.
//
//  2. Building FIRST, always. `out/` is gitignored build output that can be
//     stale, absent, or from another branch, and an installer built around a
//     stale `out/` is the P2-E15-15 failure with a setup wizard on top: bytes
//     nobody can identify. The build stamps the git identity in, so a package
//     always carries the identity of the tree it was made from.
//
// Extra args pass through to electron-builder (`npm run package -- --dir`
// skips the installer and just produces dist/win-unpacked, which is the fast
// loop when you are debugging what did or did not get packed).
'use strict';

const { spawnSync } = require('child_process');
const path = require('path');
const { cleanEnv } = require('./clean-env');

const root = path.join(__dirname, '..');
const env = cleanEnv();

function run(bin, args) {
  const exe = process.platform === 'win32' ? `"${bin}"` : bin;
  const r = spawnSync(exe, args, {
    stdio: 'inherit',
    cwd: root,
    env,
    shell: process.platform === 'win32', // .cmd shims need a shell on Windows
  });
  if (r.error) {
    console.error(`package: failed to launch ${path.basename(bin)}: ${r.error.message}`);
    process.exit(1);
  }
  if (r.status !== 0) process.exit(r.status ?? 1);
}

const binDir = path.join(root, 'node_modules', '.bin');
const ext = process.platform === 'win32' ? '.cmd' : '';

run(path.join(binDir, `electron-vite${ext}`), ['build']);

// `--publish never`, explicitly, every time — the flag electron-builder 26 asks
// for by name when it detects CI and quietly escalates an unset policy to
// `onTagOrDraft` (#273: a green Windows build died on "GitHub Personal Access
// Token is not set" after the installer was already written). electron-builder.js
// also sets `publish: null`, which is the belt to this pair of braces: the config
// makes a publisher impossible to construct, the flag stops the escalation from
// being attempted, and the log stops saying publishing was triggered when it was
// not. Publishing is `gh release create` in .github/workflows/release.yml, never
// this — so this is deliberately not overridable: the pass-through args follow it
// (`npm run package -- --dir` still works), but a second `--publish` would only
// give yargs an array for a `choices` option, and the config would refuse to
// resolve a publisher regardless.
run(path.join(binDir, `electron-builder${ext}`), ['--publish', 'never', ...process.argv.slice(2)]);
