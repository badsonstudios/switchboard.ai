// Rebuild native modules (node-pty) against Electron's ABI. Runs on
// postinstall so fresh clones and CI just work.
//
// Windows landmines (spike findings s-01-pty-host.md):
//  - NoDefaultCurrentDirectoryInExePath breaks winpty's gyp — always unset.
//  - node-pty wants Spectre-mitigated MSVC libs (MSB8040). The sanctioned fix
//    is installing the VS component ("MSVC Spectre-mitigated libs"); if the
//    build fails without it we strip the gyp setting and retry, loudly.
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const env = { ...process.env };
delete env.NoDefaultCurrentDirectoryInExePath;
delete env.ELECTRON_RUN_AS_NODE;

function rebuild() {
  return spawnSync('npx', ['electron-rebuild', '-f', '-w', 'node-pty'], {
    stdio: 'inherit',
    shell: true,
    env,
  });
}

let r = rebuild();
if (r.status !== 0 && process.platform === 'win32') {
  console.warn(
    '[rebuild-native] build failed — retrying with SpectreMitigation stripped.\n' +
      '[rebuild-native] sanctioned fix: install the "MSVC Spectre-mitigated libs" VS component.'
  );
  const ptyDir = path.join(__dirname, '..', 'node_modules', 'node-pty');
  for (const rel of ['binding.gyp', 'deps/winpty/src/winpty.gyp']) {
    const f = path.join(ptyDir, rel);
    try {
      const src = fs.readFileSync(f, 'utf8');
      const out = src.replace(/^.*'SpectreMitigation'.*\r?\n/gm, '');
      if (out !== src) fs.writeFileSync(f, out);
    } catch {
      /* file layout changed — let the retry surface the real error */
    }
  }
  r = rebuild();
}
process.exit(r.status ?? 1);
