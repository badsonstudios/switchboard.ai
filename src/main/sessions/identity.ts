// Session identity kit v1 (P1-E3-03, §5.11): auto accent assignment from the
// distinguishable palette (least-used first — seven sessions get seven
// different colors) and project-type detection for the lang badge.
import fs from 'fs';
import path from 'path';
// The palette itself moved to `shared/accents.ts` in #946 so the §5.15 role
// templates can name an accent without a second copy of the hex values; see that
// file's header. NOT re-exported from here: the whole point of the move is that
// there is one home for it, and a re-export would leave two import paths for one
// constant — the shape `shared/sessions.ts` spends a header warning about.
import { ACCENTS } from '../../shared/accents';

export function assignAccent(inUse: string[]): string {
  const counts = new Map<string, number>(ACCENTS.map((a) => [a.value, 0]));
  for (const c of inUse) counts.set(c, (counts.get(c) ?? 0) + 1);
  let best: string = ACCENTS[0].value;
  let bestCount = Infinity;
  for (const a of ACCENTS) {
    const n = counts.get(a.value) ?? 0;
    if (n < bestCount) {
      best = a.value;
      bestCount = n;
    }
  }
  return best;
}

const TYPE_MARKERS: Array<{ file: string; badge: string }> = [
  { file: 'cargo.toml', badge: 'Rs' },
  { file: 'Cargo.toml', badge: 'Rs' },
  { file: 'go.mod', badge: 'Go' },
  { file: 'pyproject.toml', badge: 'Py' },
  { file: 'requirements.txt', badge: 'Py' },
  { file: 'tsconfig.json', badge: 'TS' },
  { file: 'package.json', badge: 'JS' },
  { file: 'pom.xml', badge: 'Jv' },
  { file: 'build.gradle', badge: 'Jv' },
  { file: 'Gemfile', badge: 'Rb' },
];

export function detectProjectType(folder: string): string {
  for (const m of TYPE_MARKERS) {
    try {
      if (fs.existsSync(path.join(folder, m.file))) return m.badge;
    } catch {
      /* unreadable folder -> generic */
    }
  }
  return '·';
}
