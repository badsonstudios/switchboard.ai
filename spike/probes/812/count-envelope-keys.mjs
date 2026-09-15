// #812 probe — how often do the team-session envelope keys `teamName` and
// `agentName` appear at the ROOT of a transcript line, and on which types?
//
// Read-only over ~/.claude/projects (PROBE_ROOT overrides). Spawns nothing.
// Result on 2026-09-15: 3,151 transcripts, 270,366 lines, 0 of either key on
// any type — i.e. none among the transcripts still on disk carried a team
// context. The corpus is pruned over time, so this bounds what is on disk, not
// what the machine has ever run.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = process.env.PROBE_ROOT ?? path.join(os.homedir(), '.claude', 'projects');
const KEYS = ['teamName', 'agentName', 'sessionKind'];

function* walk(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile() && p.endsWith('.jsonl')) yield p;
  }
}

let files = 0;
let lines = 0;
const counts = Object.fromEntries(KEYS.map((k) => [k, { total: 0, byType: {} }]));
for (const f of walk(ROOT)) {
  files++;
  let text;
  try {
    text = fs.readFileSync(f, 'utf8');
  } catch {
    continue;
  }
  for (const l of text.split('\n')) {
    if (!l.trim()) continue;
    lines++;
    if (!KEYS.some((k) => l.includes(k))) continue;
    let e;
    try {
      e = JSON.parse(l);
    } catch {
      continue;
    }
    for (const k of KEYS) {
      if (!Object.prototype.hasOwnProperty.call(e, k)) continue;
      counts[k].total++;
      counts[k].byType[e.type] = (counts[k].byType[e.type] ?? 0) + 1;
    }
  }
}
process.stdout.write(JSON.stringify({ root: ROOT, files, lines, counts }, null, 2) + '\n');
