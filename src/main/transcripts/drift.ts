// Round-trip drift detector (P2-E15-10, §5.26, AR-P1-8).
//
// §5.26 mandates two ingestion patterns. The TOLERANT READER has always been
// there (unknown shapes produce nothing, malformed lines are counted and
// skipped, never thrown) — this is the second one: walk each parsed line
// against the declared contract in `schema.ts` and report keys that contract
// has never heard of. Warn ONCE per key, per process.
//
// What this buys, concretely: the CLI ships roughly monthly and its transcript
// schema is unversioned; §5.26 names schema drift an EXPECTED MAINTENANCE LINE
// ITEM rather than a background assumption. Without this, a release that
// renames `message.usage.output_tokens` shows up as token totals quietly
// reading zero. With it, the same release writes one line in the log naming
// the new key the day it lands.
//
// What it deliberately does NOT do: change ingestion. A line with fifty unknown
// keys is parsed, absorbed and rendered exactly as before — fail-open is the
// house rule (PHILOSOPHY), and a drift detector that could break the Feed would
// be worse than no drift detector.
import { PathContract, SchemaPath, TRANSCRIPT_SCHEMA, KNOWN_LINE_TYPES } from './schema';

/** Never track more than this many distinct drifted keys. A hostile or simply
 *  broken producer must not be able to grow this set without bound — it lives
 *  for the life of the process. */
const MAX_TRACKED = 200;

/** Longest key name we will echo into a log or a snapshot. */
const MAX_KEY_LEN = 120;

/** Deepest we walk. The schema declares three levels; this is a backstop
 *  against a cyclic or pathologically nested line, not a tuning knob. */
const MAX_DEPTH = 8;

/** Most array elements we inspect at a declared `.*` path. Content arrays run
 *  to a handful of items; a thousand-element array is not new information. */
const MAX_ELEMENTS = 50;

function truncate(s: string): string {
  return s.length > MAX_KEY_LEN ? `${s.slice(0, MAX_KEY_LEN)}…` : s;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Known-key lookup per path, built once — `includes` on every key of every
 *  line would put a linear scan of a 68-entry array on the ingest path. */
const KNOWN: ReadonlyMap<SchemaPath, ReadonlySet<string>> = new Map(
  (Object.entries(TRANSCRIPT_SCHEMA) as Array<[SchemaPath, PathContract]>).map(([p, c]) => [
    p,
    new Set([...c.consumed, ...c.ignored]),
  ])
);

const KNOWN_TYPES: ReadonlySet<string> = new Set(KNOWN_LINE_TYPES);

/**
 * Every key in `line` that the declared contract does not know about, as
 * dotted paths (`message.usage.output_tokens_v2`). An unknown line `type`
 * value is reported as the pseudo-key `type=<value>` — §5.26 asks for unknown
 * TYPES to be warned about as well as unknown fields, and both are one signal:
 * "the shape moved".
 *
 * Pure: no logging, no state, no I/O. The caller owns the warn-once policy.
 */
export function unknownKeys(line: unknown): string[] {
  // A transcript line is an object. A bare string or array parses perfectly
  // well as JSON, and walking one would report its INDICES as drifted keys
  // ('0', '1', '2'…) — burning warn-once slots on junk.
  if (!isPlainObject(line)) return [];
  const out: string[] = [];
  const t = line.type;
  if (typeof t === 'string' && !KNOWN_TYPES.has(t)) out.push(`type=${truncate(t)}`);
  walk(line, '', '', 0, out);
  return out;
}

function walk(
  node: Record<string, unknown>,
  schemaPath: SchemaPath,
  reportPath: string,
  depth: number,
  out: string[]
): void {
  if (depth > MAX_DEPTH) return;
  const contract = TRANSCRIPT_SCHEMA[schemaPath];
  const known = KNOWN.get(schemaPath);
  if (!contract || !known) return;
  for (const key of Object.keys(node)) {
    // One line cannot produce more findings than the whole run can hold.
    // Without this a single pathological flat object emits a report per key
    // before `inspect` gets a chance to cap.
    if (out.length >= MAX_TRACKED) return;
    const here = reportPath ? `${reportPath}.${key}` : key;
    if (!known.has(key)) {
      out.push(truncate(here));
      // Do not descend into an unknown key. Its interior is not drift we can
      // say anything useful about — one report naming the new field is the
      // signal; enumerating everything inside it is noise.
      continue;
    }
    const child = contract.descend?.[key];
    if (!child) continue; // known key, interior not part of the contract
    const value = node[key];
    if (child.endsWith('.*')) {
      // a declared element path: the value may legitimately be a string
      // (a plain user prompt is `message.content: "…"`), which is not a shape
      // we walk — absence of an array here is normal, not drift
      if (!Array.isArray(value)) continue;
      for (const el of value.slice(0, MAX_ELEMENTS)) {
        if (isPlainObject(el)) walk(el, child, `${here}[]`, depth + 1, out);
      }
    } else if (isPlainObject(value)) {
      walk(value, child, here, depth + 1, out);
    }
  }
}

/**
 * Warn-once-per-key wrapper around `unknownKeys`.
 *
 * Scoped per transcripts ROOT, not per session and not per process:
 *
 *  - per session would be wrong in the noisy direction — eight sessions
 *    against one CLI all see the same new field, and eight identical warnings
 *    is how a useful signal becomes something you filter out;
 *  - per PROCESS would be wrong in the silent direction, and worse. The
 *    watcher has been provider-generic since P2-E15-01 (each session brings
 *    the root its provider declares), while this schema is Claude-shaped. One
 *    adapter writing a different JSONL dialect would blow through MAX_TRACKED
 *    within a few hundred lines and switch drift detection off for the Claude
 *    sessions too — the detector disabling itself is exactly the silence it
 *    exists to break.
 *
 * A root is one provider writing one format, which is the natural unit.
 */
export class DriftDetector {
  private readonly scopes = new Map<string, { seen: Set<string>; capped: boolean }>();

  constructor(private readonly warn: (key: string, sample: string) => void) {}

  private scope(root: string): { seen: Set<string>; capped: boolean } {
    let s = this.scopes.get(root);
    if (!s) {
      s = { seen: new Set(), capped: false };
      this.scopes.set(root, s);
    }
    return s;
  }

  /**
   * Inspect one parsed line, warning for each key not seen before this run.
   * Never throws — a detector that can break ingest is a bug in the very thing
   * it exists to protect.
   */
  inspect(root: string, line: unknown, sample: string): void {
    const s = this.scope(root);
    if (s.capped) return;
    try {
      for (const key of unknownKeys(line)) {
        if (s.seen.has(key)) continue;
        if (s.seen.size >= MAX_TRACKED) {
          s.capped = true;
          this.warn(
            '(too many unknown keys — drift detection stopped for this transcripts root)',
            truncate(sample)
          );
          return;
        }
        s.seen.add(key);
        this.warn(key, truncate(sample));
      }
    } catch {
      // unreachable by construction (the walk is depth- and breadth-capped and
      // touches only own enumerable keys) — but this sits on the ingest path of
      // every transcript line in the app, so it fails open rather than loudly
    }
  }

  /** Drifted keys seen under one root, for diagnostics and the check script. */
  keys(root: string): string[] {
    return [...(this.scopes.get(root)?.seen ?? [])];
  }
}
