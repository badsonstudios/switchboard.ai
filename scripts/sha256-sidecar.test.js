// P2-E19-02 — the checksum sidecar's format is a contract with code that does
// not exist yet (E19-04 verifies the download against it and DELETES an
// installer that fails), so it is pinned here rather than discovered later by
// an update that refuses to install.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { SIDECAR_EXT, sidecarLine, hashFile, writeSidecar } from './sha256-sidecar.js';
import { tempDir } from '../src/test-temp-dirs';

const root = process.cwd();
const SCRIPT = path.join(root, 'scripts', 'sha256-sidecar.js');

/** the canonical SHA-256 test vector */
const ABC = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

function tempFile(name, contents) {
  // Registered, so `test-setup.ts`'s `afterAll` net takes it (#213, #360).
  // Before that this file had no teardown at all: one leaked directory per
  // call, for ever.
  const dir = tempDir('sb-sha-');
  const file = path.join(dir, name);
  fs.writeFileSync(file, contents);
  return file;
}

describe('sha256 sidecar', () => {
  it('hashes a file correctly', () => {
    expect(hashFile(tempFile('a.bin', 'abc'))).toBe(ABC);
  });

  it('writes sha256sum format: hash, TWO spaces, bare filename, LF', () => {
    // Two spaces is sha256sum's text-mode separator; one space, or a `*`, and
    // `sha256sum -c` rejects the file.
    expect(sidecarLine(ABC, 'switchboard-Setup-0.1.0.exe')).toBe(
      `${ABC}  switchboard-Setup-0.1.0.exe\n`
    );
  });

  it('records the BASENAME even when handed a path', () => {
    // The sidecar travels with the installer to whatever directory the updater
    // downloads into; a recorded `dist/...` path would be wrong everywhere else.
    expect(sidecarLine(ABC, path.join('dist', 'x.exe'))).toBe(`${ABC}  x.exe\n`);
  });

  it('uses LF even on Windows', () => {
    expect(sidecarLine(ABC, 'x.exe')).not.toContain('\r');
  });

  it('writes <file>.sha256 beside the file', () => {
    const file = tempFile('switchboard-Setup-0.1.0.exe', 'abc');
    const { sidecar, hash, line } = writeSidecar(file);
    expect(sidecar).toBe(`${file}${SIDECAR_EXT}`);
    expect(hash).toBe(ABC);
    expect(fs.readFileSync(sidecar, 'utf8')).toBe(line);
    expect(line).toBe(`${ABC}  switchboard-Setup-0.1.0.exe\n`);
  });

  it('parses back the way a verifier will read it', () => {
    // E19-04 takes the first whitespace-delimited token as the expected digest.
    const file = tempFile('switchboard-Setup-0.1.0.exe', 'abc');
    const [digest, name] = fs.readFileSync(writeSidecar(file).sidecar, 'utf8').trim().split(/\s+/);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(name).toBe('switchboard-Setup-0.1.0.exe');
    expect(digest).toBe(hashFile(file));
  });

  it('is stable across runs and changes with the bytes', () => {
    const file = tempFile('x.exe', 'abc');
    expect(writeSidecar(file).hash).toBe(writeSidecar(file).hash);
    fs.writeFileSync(file, 'abd');
    expect(writeSidecar(file).hash).not.toBe(ABC);
  });
});

describe('the CLI release.yml calls', () => {
  it('writes the sidecar and exits 0', () => {
    const file = tempFile('switchboard-Setup-0.1.0.exe', 'abc');
    const r = spawnSync(process.execPath, [SCRIPT, file], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    expect(fs.readFileSync(`${file}${SIDECAR_EXT}`, 'utf8')).toBe(
      `${ABC}  switchboard-Setup-0.1.0.exe\n`
    );
  });

  it('fails LOUDLY on a missing installer rather than shipping without one', () => {
    // How this happens in practice: electron-builder's artifactName changes and
    // packaging quietly produces a differently-named file.
    const r = spawnSync(process.execPath, [SCRIPT, path.join(os.tmpdir(), 'nope-42.exe')], {
      encoding: 'utf8',
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/::error::sha256-sidecar: no such file/);
  });

  it('exits 2 with usage when given no argument', () => {
    const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/usage: node scripts\/sha256-sidecar\.js/);
  });
  // 30 s rather than vitest's 5 s default: every case here spawns a real
  // process, and #512 is what that costs on a loaded Windows runner —
  // a test that runs in well under a second locally took 7123 ms there.
}, 30_000);
