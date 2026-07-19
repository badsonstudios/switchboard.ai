// node-pty's bundled winpty.gyp runs `cd shared && GetCommitHash.bat`, which
// fails when NoDefaultCurrentDirectoryInExePath=1 is in the environment (cmd
// then refuses to execute batch files from the current directory). Unset it
// for the rebuild only. See findings/s-01-pty-host.md.
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const env = { ...process.env };
delete env.NoDefaultCurrentDirectoryInExePath;

// node-pty requires Spectre-mitigated MSVC libs (VS Code compliance carry-over,
// MSB8040 if the VS component is missing). Irrelevant for a throwaway local
// harness — strip the setting so any stock VS toolset builds it. Phase 1
// decision: install the Spectre libs component instead of patching.
const ptyDir = path.join(__dirname, 'node_modules', 'node-pty');
for (const rel of ['binding.gyp', 'deps/winpty/src/winpty.gyp']) {
  const f = path.join(ptyDir, rel);
  const src = fs.readFileSync(f, 'utf8');
  const out = src.replace(/^.*'SpectreMitigation'.*\r?\n/gm, '');
  if (out !== src) {
    fs.writeFileSync(f, out);
    console.log(`[rebuild] stripped SpectreMitigation from ${rel}`);
  }
}

const r = spawnSync('npx', ['electron-rebuild', '-f', '-w', 'node-pty'], {
  stdio: 'inherit',
  shell: true,
  env,
});
process.exit(r.status ?? 1);
