// P2-E22-03 (#974). Small, and it earns its place on one claim: main and the
// renderer must answer "which file does this touch" with the SAME string, or a
// button grants one path while the router matches another.
import { describe, it, expect } from 'vitest';
import { targetPath, TOOL_PATH_KEYS } from './tool-paths';

describe('targetPath', () => {
  it('reads the key each gated tool actually uses', () => {
    expect(targetPath({ file_path: 'C:/p/a.ts', content: 'x' })).toBe('C:/p/a.ts');
    // NotebookEdit does not spell it `file_path` — measured against the CLI's
    // own tool→input map on 2.1.280
    expect(targetPath({ notebook_path: '/p/n.ipynb' })).toBe('/p/n.ipynb');
    expect(targetPath({ path: '/p/other' })).toBe('/p/other');
  });

  it('returns null for a call that touches no file — the ORDINARY answer', () => {
    // Not a failure: most held calls are one of these, and the caller reads
    // null as "no per-file button" and "no grant can cover this".
    expect(targetPath({ command: 'npm test' })).toBeNull();
    expect(targetPath({ url: 'https://example.com' })).toBeNull();
    expect(targetPath({})).toBeNull();
    expect(targetPath(null)).toBeNull();
    expect(targetPath(undefined)).toBeNull();
  });

  // THE EDGE THAT MATTERS, and it is the one `summaryKey` already decided for
  // the same reason: an input whose `file_path` is malformed HAS a path field.
  // Falling through to `path` would scope a grant to whichever key happened to
  // parse — a standing approval on a file the user never saw named.
  it('a malformed first key answers null rather than trying the next one', () => {
    expect(targetPath({ file_path: { nope: true }, path: '/p/elsewhere' })).toBeNull();
    expect(targetPath({ file_path: '', path: '/p/elsewhere' })).toBeNull();
    expect(targetPath({ file_path: null, path: '/p/elsewhere' })).toBeNull();
  });

  it('precedence is the declared order, and the order is not alphabetical', () => {
    expect([...TOOL_PATH_KEYS]).toEqual(['file_path', 'notebook_path', 'path']);
    expect(targetPath({ path: '/p/last', notebook_path: '/p/middle' })).toBe('/p/middle');
  });
});
