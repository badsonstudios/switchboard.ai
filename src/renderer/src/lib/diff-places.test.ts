// #562 — the Changes tab's memory of where the reader was.
//
// The rule lives here rather than in the component precisely so it can be
// tested: `DiffPane` needs Monaco to mount, and Monaco does not mount in jsdom.
// What is pinned is every edge the review found by reading rather than by
// running — a nonsense line, a stale file, eviction order.
import { describe, it, expect, beforeEach } from 'vitest';
import {
  forgetAllDiffPlaces,
  forgetDiffPlace,
  MAX_DIFF_PLACES,
  placeIsStillThere,
  readDiffPlace,
  rememberDiffPlace,
} from './diff-places';

beforeEach(() => forgetAllDiffPlaces());

describe('remembering a place', () => {
  it('round-trips a file and a line', () => {
    rememberDiffPlace('card-1', { selected: 'src/app.ts', line: 42 });
    expect(readDiffPlace('card-1')).toEqual({ selected: 'src/app.ts', line: 42 });
  });

  it('hands back a COPY, so a caller cannot mutate the store', () => {
    rememberDiffPlace('card-1', { selected: 'a.ts', line: 5 });
    const got = readDiffPlace('card-1')!;
    got.line = 999;
    expect(readDiffPlace('card-1')?.line).toBe(5);
  });

  it('keeps cards apart', () => {
    rememberDiffPlace('card-1', { selected: 'a.ts', line: 1 });
    rememberDiffPlace('card-2', { selected: 'b.ts', line: 2 });
    expect(readDiffPlace('card-1')?.selected).toBe('a.ts');
    expect(readDiffPlace('card-2')?.selected).toBe('b.ts');
  });

  it('remembers nothing for a card with no durable id', () => {
    rememberDiffPlace(undefined, { selected: 'a.ts', line: 1 });
    expect(readDiffPlace(undefined)).toBeNull();
  });
});

describe('a nonsense line is refused, not stored', () => {
  // Monaco answers -1 for a viewport with no model, and there is a real window
  // where that happens: the pane asks git for both file versions over IPC and
  // the editor is empty until that resolves. Storing it would overwrite a good
  // place with a bad one — and would do it exactly when the reader left the tab
  // quickly, which is the common case.
  it.each([
    ['Monaco with no model', -1],
    ['zero', 0],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('refuses %s and leaves the previous place standing', (_why, line) => {
    rememberDiffPlace('card-1', { selected: 'a.ts', line: 120 });
    rememberDiffPlace('card-1', { selected: 'a.ts', line });
    expect(readDiffPlace('card-1')).toEqual({ selected: 'a.ts', line: 120 });
  });

  it('refuses a place with no file', () => {
    rememberDiffPlace('card-1', { selected: '', line: 10 });
    expect(readDiffPlace('card-1')).toBeNull();
  });
});

describe('the map is bounded', () => {
  it('evicts the OLDEST card once the cap is passed', () => {
    for (let i = 0; i < MAX_DIFF_PLACES + 3; i++) {
      rememberDiffPlace(`card-${i}`, { selected: `f${i}.ts`, line: i + 1 });
    }
    expect(readDiffPlace('card-0')).toBeNull();
    expect(readDiffPlace('card-2')).toBeNull();
    expect(readDiffPlace(`card-${MAX_DIFF_PLACES + 2}`)).not.toBeNull();
  });

  it('a re-touched card moves to the BACK, so the one being read survives', () => {
    for (let i = 0; i < MAX_DIFF_PLACES; i++) {
      rememberDiffPlace(`card-${i}`, { selected: `f${i}.ts`, line: 1 });
    }
    // card-0 is the oldest and would be next out — touch it, then overflow
    rememberDiffPlace('card-0', { selected: 'f0.ts', line: 7 });
    rememberDiffPlace('newcomer', { selected: 'n.ts', line: 1 });

    expect(readDiffPlace('card-0')).toEqual({ selected: 'f0.ts', line: 7 });
    expect(readDiffPlace('card-1')).toBeNull(); // the new oldest went instead
  });
});

describe('a place is only as good as the file under it', () => {
  // `git.fileVersions` does NOT fail for a file that was committed, discarded
  // or deleted — it returns empty strings. So a stale path restores as a blank
  // two-pane diff with no row highlighted and nothing saying why.
  it('is still there when the file is still changed', () => {
    const place = { selected: 'src/app.ts', line: 3 };
    expect(placeIsStillThere(place, ['src/app.ts', 'other.ts'])).toBe(true);
  });

  it('is gone when the change was committed or discarded', () => {
    expect(placeIsStillThere({ selected: 'src/app.ts', line: 3 }, ['other.ts'])).toBe(false);
  });

  it('is gone when there is nothing changed at all', () => {
    expect(placeIsStillThere({ selected: 'a.ts', line: 1 }, [])).toBe(false);
  });

  it('handles having no place at all', () => {
    expect(placeIsStillThere(null, ['a.ts'])).toBe(false);
  });
});

describe('forgetting', () => {
  it('drops one card and leaves the rest', () => {
    rememberDiffPlace('card-1', { selected: 'a.ts', line: 1 });
    rememberDiffPlace('card-2', { selected: 'b.ts', line: 1 });
    forgetDiffPlace('card-1');
    expect(readDiffPlace('card-1')).toBeNull();
    expect(readDiffPlace('card-2')).not.toBeNull();
  });
});
