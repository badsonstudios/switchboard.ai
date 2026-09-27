// Carried over from `terminal-find.test.ts` when #952 deleted it with the PTY
// transport. Both assertions moved UNCHANGED, which is the point: neither was
// ever about a terminal, so neither lost anything by the surface going away.
//
// This is the "#418 re-read" clause of E18-16's done-when, applied: a spec that
// was honestly marked as losing coverage gets its assertion back wherever the
// thing it asserted still exists.
import { describe, it, expect } from 'vitest';
import { snippetAround } from './find-snippet';

describe('snippetAround (§5.31)', () => {
  it('windows a very long row around the match rather than pasting 500 columns in', () => {
    const line = `${'x'.repeat(400)}NEEDLE${'y'.repeat(400)}`;
    const { snippet, matchStart } = snippetAround(line, 400, 6);
    expect(snippet.length).toBeLessThan(line.length);
    // THE RE-BASED OFFSET IS THE ASSERTION. Slicing the snippet at `matchStart`
    // has to land on the term — that is what makes the bar highlight the right
    // characters, and it is the half a "just truncate it" implementation gets
    // wrong.
    expect(snippet.slice(matchStart, matchStart + 6)).toBe('NEEDLE');
    expect(snippet.startsWith('…')).toBe(true);
    expect(snippet.endsWith('…')).toBe(true);
  });

  it('leaves a short row alone', () => {
    expect(snippetAround('line 0 NEEDLE', 7, 6)).toEqual({
      snippet: 'line 0 NEEDLE',
      matchStart: 7,
    });
  });
});
