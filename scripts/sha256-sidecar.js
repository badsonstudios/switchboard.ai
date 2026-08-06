// P2-E19-02 — write `<installer>.sha256` next to a built asset.
//
// This is not a convenience: E19-04 REFUSES to run an installer it cannot
// verify (ClaudeMon's rule, and the reason an unsigned build is acceptable at
// all — the checksum does the integrity work signing would). No sidecar means
// no in-app update, so the release workflow treats a missing one as a failure.
//
// It is a script rather than a `Get-FileHash` line in release.yml because the
// FORMAT is a contract with a consumer that does not exist yet, and a contract
// nothing tests is a contract that will be wrong the first time it is read.
//
// The format is sha256sum's: `<64 lowercase hex>  <basename><LF>` — two spaces,
// the bare filename (never a path, so the file stays valid wherever it is
// downloaded to), and a Unix newline even on Windows. That makes
// `sha256sum -c switchboard-Setup-0.1.0.exe.sha256` work verbatim, and leaves
// E19-04's parser a first whitespace-delimited token.
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SIDECAR_EXT = '.sha256';

/**
 * One sidecar line, terminated. Explicit `\n` rather than os.EOL: the file is
 * produced on a Windows runner and consumed by whatever downloads it.
 *
 * @param {string} hash lowercase hex digest
 * @param {string} name the asset's basename
 */
function sidecarLine(hash, name) {
  return `${hash}  ${path.basename(name)}\n`;
}

/**
 * SHA-256 of a file, lowercase hex.
 *
 * Read whole: the installer is ~100 MB, far inside Node's buffer ceiling, and a
 * synchronous digest keeps this script a straight line with no promise plumbing
 * to get wrong in a release path.
 *
 * @param {string} file
 */
function hashFile(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/**
 * Write `<file>.sha256` beside `file`.
 *
 * @param {string} file
 * @returns {{sidecar: string, hash: string, line: string}}
 */
function writeSidecar(file) {
  const hash = hashFile(file);
  const line = sidecarLine(hash, file);
  const sidecar = file + SIDECAR_EXT;
  fs.writeFileSync(sidecar, line, 'utf8');
  return { sidecar, hash, line };
}

module.exports = { SIDECAR_EXT, sidecarLine, hashFile, writeSidecar };

if (require.main === module) {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: node scripts/sha256-sidecar.js <file>');
    process.exit(2);
  }
  if (!fs.existsSync(file)) {
    // Loud, because the way this happens is packaging having quietly produced a
    // differently-named artifact — and then the release ships without the file
    // the updater requires.
    console.error(`::error::sha256-sidecar: no such file: ${file}`);
    process.exit(1);
  }
  const { sidecar, hash } = writeSidecar(file);
  console.log(`${hash}  ${path.basename(file)}  ->  ${sidecar}`);
}
