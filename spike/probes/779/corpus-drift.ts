// Probe for #779 — what the real corpus says about the keys `schema.ts` has not
// been told about.
//
// `npm run check:transcripts` drives ONE turn against the installed CLI and
// reports the drift on that one transcript, which is how #779's five keys were
// spotted. Five keys from one `-p` turn is a lower bound on a lower bound: the
// check's transcript has no tool calls, no subagents, no compaction and no
// errors. This walks the whole of `~/.claude/projects` instead, so the answer to
// "which keys does this schema not know about" is measured against every line
// this machine has ever written rather than against one hello-world turn.
//
// WHY THE `version` FIELD IS THE POINT. Every line carries the CLI `version`
// that wrote it, so a key's version RANGE dates it: a key that appears only from
// 2.1.x is a recent addition, one spanning 1.0.x → 2.1.x has been there all
// along and the schema simply never saw it. That distinction decides whether a
// key is "the CLI grew something" or "our corpus measurement was too small", and
// it cannot be had from a single transcript.
//
// Run: node spike/probes/779/run.mjs
import fs from 'fs';
import path from 'path';
import os from 'os';
import { unknownKeys } from '../../../src/main/transcripts/drift';

/** Sample values are echoed into a findings note, so keep them short and few. */
const MAX_SAMPLES = 4;
const SAMPLE_LEN = 160;

interface KeyReport {
  count: number;
  files: Set<string>;
  lineTypes: Set<string>;
  versions: Set<string>;
  samples: string[];
}

function collect(root: string): Map<string, KeyReport> {
  const reports = new Map<string, KeyReport>();
  let lines = 0;
  let malformed = 0;
  let files = 0;

  for (const file of walkJsonl(root)) {
    files++;
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const raw of text.split('\n')) {
      if (!raw.trim()) continue;
      lines++;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        malformed++;
        continue;
      }
      const keys = unknownKeys(parsed);
      if (keys.length === 0) continue;
      const rec = parsed as Record<string, unknown>;
      for (const key of keys) {
        let r = reports.get(key);
        if (!r) {
          r = {
            count: 0,
            files: new Set(),
            lineTypes: new Set(),
            versions: new Set(),
            samples: [],
          };
          reports.set(key, r);
        }
        r.count++;
        r.files.add(path.basename(file));
        r.lineTypes.add(String(rec.type ?? '(none)'));
        r.versions.add(String(rec.version ?? '(none)'));
        if (r.samples.length < MAX_SAMPLES) {
          const v = valueAt(rec, key);
          const s = JSON.stringify(v);
          r.samples.push(s === undefined ? '(unreadable)' : s.slice(0, SAMPLE_LEN));
        }
      }
    }
  }
  console.log(`[probe] ${files} files, ${lines} lines, ${malformed} malformed, root=${root}`);
  return reports;
}

/**
 * Resolve a drift report path (`a.b[].c`) back to its value, for samples.
 *
 * `drift.ts` reports an array element as `message.content[].foo` WITHOUT the
 * index, so the index has to be searched for rather than assumed. The first
 * version of this took element 0 and called it "any element carrying the rest of
 * the path will do" — which is what it should do and not what it did: drift found
 * at `message.content[2].foo` resolved to `undefined` and printed
 * `(unreadable)`, with nothing saying the SAMPLE had failed rather than the key
 * being odd. A silently-wrong answer in a probe built to be re-run is worse than
 * no answer, so it now actually searches.
 *
 * Two cases it still cannot resolve, both harmless and both worth knowing:
 * `drift.ts` truncates a report path longer than 120 chars and appends `…`, and
 * a key containing a literal `.` is indistinguishable from a path separator.
 * Each yields `(unreadable)`, which is the honest output.
 */
function valueAt(line: Record<string, unknown>, reportPath: string): unknown {
  if (reportPath.startsWith('type=')) return line.type;
  return resolve(line, reportPath.split('.'));
}

function resolve(node: unknown, segments: readonly string[]): unknown {
  if (segments.length === 0) return node;
  const [seg, ...rest] = segments;
  const isElement = seg.endsWith('[]');
  const key = isElement ? seg.slice(0, -2) : seg;
  if (typeof node !== 'object' || node === null) return undefined;
  const child = (node as Record<string, unknown>)[key];
  if (!isElement) return resolve(child, rest);
  if (!Array.isArray(child)) return undefined;
  // The report names no index, so find the element that actually carries the
  // rest of the path instead of hoping it is the first one.
  for (const el of child) {
    const found = resolve(el, rest);
    if (found !== undefined) return found;
  }
  return undefined;
}

function* walkJsonl(dir: string): Generator<string> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walkJsonl(full);
    else if (e.isFile() && e.name.endsWith('.jsonl')) yield full;
  }
}

const root = process.argv[2] ?? path.join(os.homedir(), '.claude', 'projects');
const reports = [...collect(root).entries()].sort((a, b) => b[1].count - a[1].count);
console.log(`\n[probe] ${reports.length} drifted key(s), most frequent first:\n`);
for (const [key, r] of reports) {
  const versions = [...r.versions].sort();
  const span =
    versions.length <= 3 ? versions.join(', ') : `${versions[0]} … ${versions[versions.length - 1]} (${versions.length})`;
  console.log(`${key}`);
  console.log(`  count=${r.count} files=${r.files.size} types=[${[...r.lineTypes].join(', ')}]`);
  console.log(`  versions=${span}`);
  for (const s of r.samples) console.log(`  sample: ${s}`);
  console.log('');
}
