// Build the diagnostic zip (#815).
//
// What goes in, and the one thing that deliberately does not:
//
//   • the whole logs directory — `switchboard.log` and its rotated siblings.
//     Since #719 these carry a `cpu heartbeat` line every minute naming which
//     process was burning, which is the evidence this whole feature exists to
//     move off the machine.
//   • `workspace.json` — layout and policy state. It decided #813's suspect
//     list and it is a few KB.
//   • a generated `bundle-info.txt` — versions, OS, uptime, core count. The
//     things every bug report needs and nobody remembers to include.
//   • NOT the `sessions/` directory. Transcripts and scrollback are large, and
//     conversation content does not belong in a file that gets emailed or
//     dragged onto an issue — even for a single-user app today.
//
// FAIL-OPEN IS THE WHOLE POSTURE HERE. The active log is being appended to
// while we read it, the sink rotates underneath us, and a file can vanish
// mid-walk. Every one of those is skipped and RECORDED rather than thrown:
// a bundle that is missing the log is much better than no bundle, and a bundle
// silently missing it is much worse than either, because the reader assumes
// the evidence was collected.
import fs from 'fs';
import path from 'path';
import os from 'os';
import { ZipFile } from 'yazl';
import type { BundleResult, SkippedEntry } from '../../shared/diagnostics';
import type { BuildIdentity } from '../../shared/build-identity';

export interface BundleDeps {
  /** `app.getPath('logs')` */
  logsDir: string;
  /** `app.getPath('userData')` — where workspace.json lives */
  userDataDir: string;
  /** where the zip is written; usually userData, or a temp dir in tests */
  outDir: string;
  version: string;
  identity: BuildIdentity;
  /** app uptime in ms, for bundle-info */
  uptimeMs: number;
  now?: () => Date;
}

/**
 * `switchboard-logs-v0.8.90-2026-09-18-1432.zip`.
 *
 * The version and the timestamp are both in the name because a bug report
 * arrives as a file, and "which build, and when" must be answerable from the
 * filename alone — before anyone opens it.
 */
export function bundleName(version: string, at: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  const stamp =
    `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}` +
    `-${p(at.getHours())}${p(at.getMinutes())}`;
  return `switchboard-logs-v${version}-${stamp}.zip`;
}

/** The generated `bundle-info.txt`. Plain text on purpose — it gets pasted. */
export function bundleInfo(deps: BundleDeps, at: Date, skipped: SkippedEntry[]): string {
  const id = deps.identity;
  const lines = [
    `switchboard.ai diagnostic bundle`,
    `collected:     ${at.toISOString()}`,
    `version:       ${deps.version}`,
    `commit:        ${id.commit ?? 'unknown'}${id.dirty ? ' (dirty tree)' : ''}`,
    `branch:        ${id.branch ?? 'unknown'}`,
    `built:         ${id.builtAt ?? 'unknown'}`,
    `app uptime:    ${Math.round(deps.uptimeMs / 1000)}s`,
    `platform:      ${process.platform} ${os.release()}`,
    `arch:          ${process.arch}`,
    `logical cores: ${os.cpus().length}`,
    `total memory:  ${(os.totalmem() / 1024 ** 3).toFixed(1)} GB`,
    `electron:      ${process.versions.electron ?? 'n/a'}`,
    `chrome:        ${process.versions.chrome ?? 'n/a'}`,
    `node:          ${process.versions.node}`,
  ];
  // Stated in the bundle itself, not only in the code: whoever opens this must
  // be able to tell "there was no log" from "we chose not to include it".
  lines.push('', 'transcripts are deliberately NOT included (conversation content)');
  if (skipped.length > 0) {
    lines.push('', 'files that could not be included:');
    for (const s of skipped) lines.push(`  - ${s.name}: ${s.reason}`);
  }
  return lines.join('\n') + '\n';
}

/** Every file directly inside `dir`, or [] when it cannot be listed. */
function filesIn(dir: string, skipped: SkippedEntry[]): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name);
  } catch (err) {
    // A missing logs dir is an ordinary first-boot state, not an error.
    skipped.push({ name: path.basename(dir), reason: `could not list: ${String(err)}` });
    return [];
  }
}

/**
 * Read a file into memory rather than handing yazl the path.
 *
 * Deliberate: `addFile` keeps a handle open and streams later, and the live log
 * is being appended to and rotated underneath us. Reading now means the bundle
 * holds a consistent snapshot of what the file said at collection time, and a
 * file that disappears between the walk and the write is skipped rather than
 * failing the whole zip. Logs are megabytes at most (5 MB x 5, bounded by the
 * sink), so the memory cost is bounded and small.
 */
function readOrSkip(full: string, label: string, skipped: SkippedEntry[]): Buffer | null {
  try {
    return fs.readFileSync(full);
  } catch (err) {
    skipped.push({ name: label, reason: String(err) });
    return null;
  }
}

/**
 * Assemble the zip. Never throws — every failure lands in the result.
 */
export async function buildBundle(deps: BundleDeps): Promise<BundleResult> {
  const at = (deps.now ?? (() => new Date()))();
  const skipped: SkippedEntry[] = [];
  const zip = new ZipFile();

  for (const name of filesIn(deps.logsDir, skipped)) {
    const buf = readOrSkip(path.join(deps.logsDir, name), `logs/${name}`, skipped);
    if (buf) zip.addBuffer(buf, `logs/${name}`);
  }

  const workspace = path.join(deps.userDataDir, 'workspace.json');
  if (fs.existsSync(workspace)) {
    const buf = readOrSkip(workspace, 'workspace.json', skipped);
    if (buf) zip.addBuffer(buf, 'workspace.json');
  } else {
    skipped.push({ name: 'workspace.json', reason: 'not present' });
  }

  // LAST, so it can report what the walk above could not collect.
  zip.addBuffer(Buffer.from(bundleInfo(deps, at, skipped), 'utf8'), 'bundle-info.txt');
  zip.end();

  const out = path.join(deps.outDir, bundleName(deps.version, at));
  try {
    fs.mkdirSync(deps.outDir, { recursive: true });
    await new Promise<void>((resolve, reject) => {
      const ws = fs.createWriteStream(out);
      ws.on('error', reject);
      ws.on('close', () => resolve());
      zip.outputStream.on('error', reject);
      zip.outputStream.pipe(ws);
    });
  } catch (err) {
    return {
      ok: false,
      path: null,
      bytes: 0,
      skipped: [...skipped, { name: 'the bundle itself', reason: String(err) }],
      problem: 'bundle-failed',
    };
  }

  let bytes = 0;
  try {
    bytes = fs.statSync(out).size;
  } catch {
    // The zip closed but cannot be stat'ed — report the path anyway; it exists.
  }
  return { ok: true, path: out, bytes, skipped };
}
