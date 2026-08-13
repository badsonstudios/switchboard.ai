// #435 — the NUL-byte gate: fail `npm run lint` when a text file in the working
// tree contains a `\x00`.
//
// #410's worker lost a debugging cycle to a single stray NUL in a source file.
// Nothing in this repo reported it: eslint parsed the file, `tsc` typechecked
// it, CI went green, and the byte only showed up as a confusing failure
// somewhere downstream — a truncated string, a mismatched snapshot, a tool that
// said something unrelated. The byte is invisible in every editor and in every
// diff, so the search goes everywhere except the one place it is.
//
// A NUL never belongs in the text we write. There is no legitimate reason for
// one to be in a `.ts`, a `.md` or a `.json` in this tree — it arrives by
// accident (a bad write, a mangled copy-paste, a half-decoded UTF-16 read), so
// this is a HARD FAIL with the filename and the line in it, not a warning.
// The whole value is turning a mystery into one line of output.
//
// Wired ahead of eslint in the `lint` script, so it runs locally and in CI (the
// workflow runs `npm run lint`) and fails before the slower linter starts.
//
// Two deliberate choices about WHAT gets scanned:
//
//   • `git ls-files --cached --others --exclude-standard`, not a directory walk.
//     Tracked files PLUS untracked ones git is not ignoring — i.e. everything a
//     `git add .` would stage. Tracked-only was the original list and it left a
//     hole: a NUL lands in a NEW file at least as often as in an old one, and
//     #414's worker lost a cycle to exactly that — lint stayed green until the
//     `git add` that made the file tracked (#459). Asking git still means
//     `node_modules/`, `out/`, `dist/` and every ignored piece of local junk are
//     excluded for free rather than by a skip list that drifts.
//   • a SKIP list of binary extensions, not an allowlist of text ones. A new
//     text extension is then covered the day it appears; the cost is that a new
//     BINARY extension (a font, a `.wasm`) fails loudly until someone adds it to
//     `BINARY_EXTENSIONS` below — a one-line fix, named in the failure message.
//     An allowlist would trade that for silence, and silence is the defect this
//     file exists to remove.
//
// Fail-open on the one thing outside our control: if `git ls-files` cannot run
// (no git, no repo, a source tarball), the check says so and exits 0. Our
// breakage must never be what blocks a session.
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

/**
 * Extensions whose files are EXPECTED to contain NUL bytes, and are therefore
 * not scanned. Lower-case, with the dot, as `path.extname()` returns it.
 *
 * Everything tracked in this repo today is text apart from `.png` and `.ico`;
 * the rest of the list is the ordinary binary furniture a desktop app grows
 * (icons, fonts, archives, native modules, media). Adding to it is the correct
 * response to this check failing on a genuinely binary file.
 */
const BINARY_EXTENSIONS = new Set([
  // images
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.bmp',
  '.webp',
  '.avif',
  '.ico',
  '.icns',
  '.tif',
  '.tiff',
  '.psd',
  // fonts
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.eot',
  // archives & packages
  '.zip',
  '.gz',
  '.tgz',
  '.bz2',
  '.xz',
  '.7z',
  '.rar',
  '.jar',
  '.asar',
  // executables & native modules
  '.exe',
  '.dll',
  '.node',
  '.so',
  '.dylib',
  '.wasm',
  '.pdb',
  '.bin',
  // documents & media
  '.pdf',
  '.mp3',
  '.wav',
  '.mp4',
  '.webm',
  '.mov',
  '.avi',
]);

/** `a\b` -> `a/b`, so a path prints and compares the same on both platforms. */
const toPosix = (p) => String(p).replace(/\\/g, '/');

/**
 * Should this path be read and searched?
 *
 * @param {string} relPath path relative to the repo root, either separator
 */
function isScannable(relPath) {
  return !BINARY_EXTENSIONS.has(path.extname(toPosix(relPath)).toLowerCase());
}

/**
 * Every file this check is responsible for — tracked, plus untracked ones git is
 * not ignoring — repo-root-relative and posix-shaped, or null if git could not
 * answer (see the fail-open note in the header).
 *
 * `--cached` is the index, `--others` the untracked files, `--exclude-standard`
 * applies `.gitignore` and friends to the second half so it is the files a
 * `git add .` would stage rather than `node_modules/`.
 *
 * `-z` because it is the only output form git does not quote or escape: a path
 * with a space, a quote or a non-ASCII character comes back verbatim.
 *
 * De-duplicated: during a merge conflict `--cached` prints an unmerged path once
 * per stage, and scanning one file three times would triple-count it.
 *
 * @param {string} root
 * @returns {string[]|null}
 */
function filesToScan(root) {
  try {
    const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 30_000,
    });
    return [...new Set(out.split('\0').filter((p) => p !== ''))];
  } catch {
    return null;
  }
}

/**
 * Where the first NUL is, in the terms a reader needs to go and look at it:
 * 1-based line and column, plus the byte offset for anyone reaching for a hex
 * editor. Columns are counted in BYTES, not characters — a NUL is a byte-level
 * accident, and the honest coordinate for it is the byte one.
 *
 * @param {Buffer} buffer
 * @returns {{offset: number, line: number, column: number}|null}
 */
function findNul(buffer) {
  const offset = buffer.indexOf(0);
  if (offset === -1) return null;
  const before = buffer.subarray(0, offset);
  let line = 1;
  for (let i = 0; i < before.length; i++) if (before[i] === 0x0a) line++;
  const lineStart = before.lastIndexOf(0x0a) + 1; // 0 when there is no newline
  return { offset, line, column: offset - lineStart + 1 };
}

/**
 * Read every scannable file and collect the hits.
 *
 * `read` is injected so the tests can drive the scan without writing files;
 * the default is `fs.readFileSync`, which returns a Buffer (no encoding), so
 * the bytes are never decoded on the way in — decoding a NUL is exactly how a
 * text pipeline loses it.
 *
 * A file that disappears between `git ls-files` and the read (a staged delete,
 * a rebase mid-flight) is skipped, and so is anything that is not a readable
 * file at all — `--others` lists an untracked nested repo as a DIRECTORY, and
 * `readFileSync` on one throws `EISDIR`. Neither can be the file anyone is
 * debugging.
 *
 * @param {string} root
 * @param {string[]} files repo-relative paths
 * @param {(absPath: string) => Buffer} [read]
 * @returns {{scanned: number, skipped: number,
 *            hits: {file: string, offset: number, line: number, column: number}[]}}
 */
function scan(root, files, read = (p) => fs.readFileSync(p)) {
  const hits = [];
  let scanned = 0;
  let skipped = 0;
  for (const file of files) {
    if (!isScannable(file)) {
      skipped++;
      continue;
    }
    let buffer;
    try {
      buffer = read(path.join(root, file));
    } catch {
      skipped++;
      continue;
    }
    scanned++;
    const at = findNul(buffer);
    if (at) hits.push({ file: toPosix(file), ...at });
  }
  return { scanned, skipped, hits };
}

/** Hits listed in full up to here, then counted. */
const MAX_LISTED = 20;

/**
 * The report, as lines. Pure, so the tests assert on the words rather than on a
 * write to stderr.
 *
 * @param {ReturnType<typeof scan>} result
 * @param {{elapsedMs?: number}} [opts]
 * @returns {{lines: string[], failed: boolean}}
 */
function formatReport(result, opts = {}) {
  const ms = Math.round(opts.elapsedMs ?? 0);
  if (result.hits.length === 0) {
    return {
      lines: [`check-nul: ${result.scanned} text files, no NUL bytes (${ms}ms)`],
      failed: false,
    };
  }

  const shown = result.hits.slice(0, MAX_LISTED);
  const lines = [
    `NUL byte (\\x00) found in ${result.hits.length} file(s):`,
    ...shown.map((h) => `  ${h.file}:${h.line}:${h.column}  (byte offset ${h.offset})`),
  ];
  if (result.hits.length > shown.length) {
    lines.push(`  ...and ${result.hits.length - shown.length} more`);
  }
  lines.push(
    '',
    'A NUL in a text file is always an accident, and nothing else reports it:',
    'eslint parses it, tsc typechecks it, CI goes green, and it surfaces later as',
    'an unrelated-looking failure somewhere downstream (#435). Editors and diffs',
    'do not show it.',
    '',
    'Fix: re-save the file without the byte. In node:',
    "  node -e \"const f='<file>',fs=require('fs');fs.writeFileSync(f,fs.readFileSync(f).filter(b=>b!==0))\"",
    '',
    'If the file above is genuinely BINARY, add its extension to',
    'BINARY_EXTENSIONS in scripts/check-nul.js instead.'
  );
  return { lines, failed: true };
}

/** What is printed, and exited on, when git cannot list the files. */
const NO_GIT_LINES = [
  'check-nul: skipped — `git ls-files` did not answer (no git, or not a repo).',
  'check-nul: nothing to scan against; not failing the build over it.',
];

/**
 * The whole check.
 *
 * @param {string} root
 * @param {{now?: () => number}} [deps]
 * @returns {{lines: string[], failed: boolean}}
 */
function run(root, deps = {}) {
  const now = deps.now ?? (() => Date.now());
  const started = now();
  const files = filesToScan(root);
  if (files === null) return { lines: [...NO_GIT_LINES], failed: false };
  return formatReport(scan(root, files), { elapsedMs: now() - started });
}

module.exports = {
  BINARY_EXTENSIONS,
  MAX_LISTED,
  NO_GIT_LINES,
  isScannable,
  filesToScan,
  findNul,
  scan,
  formatReport,
  run,
};

if (require.main === module) {
  // Root from __dirname, not process.cwd() — the house pattern (bundle-guard.js,
  // run-electron-node.js): `git ls-files` run from a subdirectory lists only
  // that subtree, so the gate would silently shrink to wherever it was invoked.
  const { lines, failed } = run(path.join(__dirname, '..'));
  // stderr for both verdicts: this is a preamble to `eslint .`, and stdout is
  // where lint results go.
  console.error(lines.join('\n'));
  process.exit(failed ? 1 : 0);
}
