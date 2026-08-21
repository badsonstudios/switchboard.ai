/**
 * Keep the build stamp out of the hashed renderer chunks (#630).
 *
 * **The problem.** `electron.vite.config.ts` bakes a build identity into every
 * target via `define` — and that identity contains `builtAt`, a millisecond
 * ISO timestamp, which is the whole point (it is what makes a stale `out/`
 * visible). The identifier is referenced in exactly one module,
 * `src/shared/build-identity.ts`, so the timestamp landed in whichever renderer
 * chunk that module got folded into: the ~9.8 MB `index` entry.
 *
 * Vite names chunks `[name]-[hash]`, and the hash is of the CONTENT. A new
 * timestamp therefore renamed `index`, which renamed every chunk that imports
 * it (their import specifier changed, so their content changed, so their hash
 * changed), and so on transitively. Two builds of the same clean commit emitted
 * nine differently-named files. Anyone comparing two builds — bisecting a
 * flake, proving a rebuild changed nothing, chasing a stale-bundle hunch — read
 * that as a real difference. Two workers lost time to it on the same day.
 *
 * **The fix.** Give `build-identity.ts` a chunk of its own with a FIXED name.
 * The timestamp still ships, unchanged, in that one small file; nothing that
 * imports it sees its own bytes move, because the specifier they import
 * (`./build-stamp.js`) no longer carries a hash. Two builds of the same commit
 * now differ in exactly two files, both of which are the stamp itself:
 * `out/renderer/assets/build-stamp.js` and `out/main/index.js` (main's bundle
 * is not content-hashed, so it only ever differed in content).
 *
 * **Why an unhashed name is safe here.** Content hashes exist to bust HTTP
 * caches. The renderer is served by `src/main/static-server.ts`, which sends no
 * `cache-control`, no `etag` and no `last-modified` — so nothing is heuristi-
 * cally cacheable — and it binds an ephemeral port (`listen(0)`), so every
 * launch is a different origin and therefore a different cache key anyway.
 *
 * Node-only, like the rest of `src/build`: this is read by the vite config, not
 * by the app.
 */

/** Rollup chunk name for the module that carries the baked identity. */
export const STAMP_CHUNK = 'build-stamp';

/** Where that chunk is emitted. No `[hash]` — that is the entire point. */
export const STAMP_CHUNK_FILE_NAME = `assets/${STAMP_CHUNK}.js`;

/** Vite's default for renderer chunks; kept verbatim for everything else. */
export const DEFAULT_CHUNK_FILE_NAME = 'assets/[name]-[hash].js';

/** The one module whose bytes move on every build. */
const STAMP_MODULE = 'src/shared/build-identity.ts';

/** `a\b` -> `a/b`. Rollup ids are POSIX-ish already, but Windows can leak. */
function toPosix(id: string): string {
  return id.replace(/\\/g, '/');
}

/**
 * `manualChunks`: put the stamp module — and only it — in its own chunk.
 *
 * Matched by suffix rather than by absolute path because rollup ids are
 * absolute and worktree-dependent. The module is a leaf (it imports nothing),
 * so promoting it to its own chunk cannot introduce a circular chunk import.
 */
export function stampManualChunks(id: string): string | undefined {
  const posix = toPosix(id);
  return posix.endsWith(`/${STAMP_MODULE}`) || posix === STAMP_MODULE ? STAMP_CHUNK : undefined;
}

/**
 * `chunkFileNames`: the fixed name for the stamp chunk, vite's default for
 * everything else. A function rather than a pattern because only one chunk is
 * special-cased.
 */
export function stampChunkFileNames(chunk: { name: string }): string {
  return chunk.name === STAMP_CHUNK ? STAMP_CHUNK_FILE_NAME : DEFAULT_CHUNK_FILE_NAME;
}
