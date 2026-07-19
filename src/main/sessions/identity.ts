// Session identity kit v1 (P1-E3-03, §5.11): auto accent assignment from the
// distinguishable palette (least-used first — seven sessions get seven
// different colors) and project-type detection for the lang badge.
import fs from 'fs';
import path from 'path';

/** §5.11 accent palette — token names match theme/tokens.css. */
export const ACCENTS = [
  { name: 'amber', value: '#e3b341' },
  { name: 'teal', value: '#39c5bb' },
  { name: 'violet', value: '#a78bfa' },
  { name: 'green', value: '#3fb950' },
  { name: 'blue', value: '#58a6ff' },
  { name: 'coral', value: '#f0776b' },
  { name: 'pink', value: '#db61a2' },
  { name: 'orange', value: '#f0883e' },
] as const;

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
