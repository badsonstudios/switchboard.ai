import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { assignAccent, detectProjectType, ACCENTS } from './identity';
import { cleanupTempDirs, tempDir } from '../../test-temp-dirs';

// The two `detectProjectType` tests below each make a throwaway project dir
// (#213). Nothing here outlives its test, so sweeping per test is safe.
afterEach(() => cleanupTempDirs());

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

describe('detectProjectType', () => {
  it('detects markers with TS beating JS', () => {
    const dir = tempDir('sb-id-');
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');
    expect(detectProjectType(dir)).toBe('JS');
    fs.writeFileSync(path.join(dir, 'tsconfig.json'), '{}');
    expect(detectProjectType(dir)).toBe('TS');
  });

  it('falls back to a generic badge', () => {
    const dir = tempDir('sb-id-');
    expect(detectProjectType(dir)).toBe('·');
  });
});
