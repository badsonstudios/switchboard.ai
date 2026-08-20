import { describe, expect, it } from 'vitest';
import { existsSync } from 'fs';
import path from 'path';
import {
  DEFAULT_CHUNK_FILE_NAME,
  STAMP_CHUNK,
  STAMP_CHUNK_FILE_NAME,
  stampChunkFileNames,
  stampManualChunks,
} from './stamp-chunk';

/**
 * #630 — these two functions are the whole of the renderer's build
 * determinism. They are tiny, and the thing that would break them is not a
 * logic bug but a RENAME: move or rename `src/shared/build-identity.ts` and
 * `stampManualChunks` silently stops matching, the stamp falls back into the
 * hashed `index` chunk, and chunk names start churning again with nothing
 * failing. Hence the last test, which is really a tripwire on that path.
 */
describe('stampManualChunks', () => {
  it('claims the stamp module by its absolute posix id', () => {
    expect(stampManualChunks('/home/dan/switchboard/src/shared/build-identity.ts')).toBe(
      STAMP_CHUNK,
    );
  });

  it('claims it through a windows id too — rollup ids can arrive backslashed', () => {
    expect(
      stampManualChunks(String.raw`C:\Projects\sb\src\shared\build-identity.ts`),
    ).toBe(STAMP_CHUNK);
  });

  it('claims the bare project-relative spelling', () => {
    expect(stampManualChunks('src/shared/build-identity.ts')).toBe(STAMP_CHUNK);
  });

  it('leaves every other module to rollup', () => {
    for (const id of [
      '/repo/src/shared/csp.ts',
      '/repo/src/build/git-identity.ts',
      '/repo/src/shared/build-identity.test.ts',
      '/repo/src/renderer/src/App.tsx',
      '/repo/node_modules/monaco-editor/esm/vs/editor/editor.api.js',
      // a path that merely ENDS in the file name, without the src/shared prefix
      '/repo/vendor/build-identity.ts',
    ]) {
      expect(stampManualChunks(id)).toBeUndefined();
    }
  });
});

describe('stampChunkFileNames', () => {
  it('emits the stamp chunk at a name with no content hash', () => {
    expect(stampChunkFileNames({ name: STAMP_CHUNK })).toBe(STAMP_CHUNK_FILE_NAME);
    expect(STAMP_CHUNK_FILE_NAME).not.toContain('[hash]');
  });

  it("keeps vite's hashed default for everything else", () => {
    for (const name of ['index', 'popout', 'yaml', 'editor.worker']) {
      expect(stampChunkFileNames({ name })).toBe(DEFAULT_CHUNK_FILE_NAME);
    }
    expect(DEFAULT_CHUNK_FILE_NAME).toContain('[hash]');
  });
});

describe('the module it isolates', () => {
  it('still exists at the path stampManualChunks matches', () => {
    // __dirname is src/build; the stamp module is src/shared/build-identity.ts
    const stampModule = path.resolve(__dirname, '..', 'shared', 'build-identity.ts');
    expect(existsSync(stampModule)).toBe(true);
    // and the matcher agrees about that real, absolute, platform-shaped path
    expect(stampManualChunks(stampModule)).toBe(STAMP_CHUNK);
  });
});
