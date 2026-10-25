import { describe, it, expect } from 'vitest';
import { assignAccent } from './identity';
// The palette lives in `shared/` as of #946 — one home, one import path.
import { ACCENTS } from '../../shared/accents';

describe('assignAccent (the seven-sessions-distinct done-when)', () => {
  it('gives 8 sessions 8 different accents', () => {
    const used: string[] = [];
    for (let i = 0; i < 8; i++) used.push(assignAccent(used));
    expect(new Set(used).size).toBe(8);
  });

  it('reuses least-used colors after the palette wraps', () => {
    const used = ACCENTS.map((a) => a.value); // one of each
    const ninth = assignAccent(used);
    expect(ninth).toBe(ACCENTS[0].value);
  });
});
