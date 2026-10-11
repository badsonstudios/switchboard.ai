// The browser cache holds nothing this app can use, so it is kept empty (#744).
//
// MEASURED, 2026-10-11, on the owner's desktop: `Cache` was 208 MB of a 226 MB
// profile, and 189 MB of that was TWENTY copies of the renderer bundle (about
// 10 MB each), dated across two weeks. The work laptop had shown 236 MB and
// about 25 copies in August.
//
// WHY THEY PILE UP, and why none of them is ever read again. The packaged
// renderer is served over loopback http on a port the system picks
// (`static-server.ts`, `listen(0)`), because dockview's pop-out needs a
// same-origin http page. A cache entry is keyed by its address, and the
// address includes the port. Every launch is therefore a new origin: the
// bundle is fetched, stored under an address that will never be asked for
// again, and the previous launch's copy is left behind. Chromium's own limit
// on the cache is a share of the disk, so nothing retires them.
//
// So there are two halves, and this file is the second:
//
//   1. `static-server.ts` answers `Cache-Control: no-store`, so nothing new is
//      written. Nothing is lost by that: a copy that cannot be reused was
//      never saving a read, and the file comes off the local disk either way.
//   2. On every start the cache is CLEARED. Once, that takes back what is
//      already there on an installed machine; after that it is a no-op on an
//      empty cache, and it keeps this true whatever is added later.
//
// Nothing else wants the cache: local pictures are served `no-store`
// (`fs/doc-image.ts`), and the content security policy allows no remote
// origin to fetch from.
//
// FAIL-OPEN, and never in the way of the window: a cache that would not clear
// costs disk, not a session.
import { errorText } from '../shared/error-text';
import type { Logger } from './log/logger';

/** The slice of Electron's `Session` this needs. */
export interface CacheSession {
  getCacheSize(): Promise<number>;
  clearCache(): Promise<void>;
  /** V8's compiled-code cache: keyed by the same never-repeated addresses */
  clearCodeCaches?(options: { urls?: string[] }): Promise<void>;
}

/** Below this, clearing is not worth a log line at `info`. */
const WORTH_SAYING_BYTES = 1024 * 1024;

/**
 * Empty the browser cache. Resolves with how many bytes it held, or `null`
 * when it could not be asked or cleared. Never rejects.
 */
export async function clearDeadHttpCache(
  session: CacheSession,
  log: Pick<Logger, 'info' | 'warn' | 'debug'>
): Promise<number | null> {
  try {
    const before = await session.getCacheSize();
    await session.clearCache();
    // the code cache is separate, and stale for the same reason
    await session.clearCodeCaches?.({});
    const line = { bytes: before, megabytes: Math.round((before / (1024 * 1024)) * 10) / 10 };
    if (before >= WORTH_SAYING_BYTES) log.info('cleared the browser cache: nothing in it could be reused', line);
    else log.debug('browser cache was already empty', line);
    return before;
  } catch (err) {
    log.warn('the browser cache could not be cleared', { error: errorText(err) });
    return null;
  }
}
