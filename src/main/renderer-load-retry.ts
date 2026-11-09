// A main window whose page failed to load gets the page again (#1592).
//
// WHAT IT LOOKED LIKE. Windows CI run 42520563496 (2026-11-08): the window
// came up and was shown, and then nothing — no rail, no renderer log line at
// all, for 30 s. Its kept `switchboard.log` had exactly one renderer line after
// the usual boot noise: Electron's "Insecure Content-Security-Policy" warning.
// Every page of ours carries a policy (`csp.ts`), so that warning can only come
// from a page that is NOT ours — and a bare Electron probe showed the exact
// signature for a failed main-frame load: `did-fail-load`, then a
// `did-finish-load` of `chrome-error://chromewebdata/`, then that warning, and
// `ready-to-show` fires as usual. The window was showing Chromium's error page.
//
// WHY THE LOAD FAILED is not known: nothing logged the error code. The page
// comes from our own loopback server, which is listening before the load
// starts. So this does two things, and claims no more than that:
//
//   1. it LOGS the failure (code, description, URL) — the next sighting names
//      its cause instead of leaving a blank window and a guess;
//   2. it LOADS THE PAGE AGAIN, a bounded number of times. A window stuck on an
//      error page is a dead app for a user, with every session hidden behind
//      it; a second try at a page on the local disk costs nothing.
//
// What is NOT retried: `ERR_ABORTED` (-3), which is a load replaced by a newer
// one rather than a failure; subframes; and anything after the attempts run
// out — the last failure is logged at `error` and the window is left as it is.
//
// Fail-open: every path is inside a try, and nothing here can throw into the
// window's creation.
import { errorText } from '../shared/error-text';
import type { Logger } from './log/logger';

/** Chromium's net error for a load replaced by another one — not a failure. */
export const ERR_ABORTED = -3;

/** How many times the page is loaded AGAIN after a failed load. */
export const RENDERER_LOAD_RETRIES = 3;

/** The slice of `WebContents` this needs. */
export interface LoadEvents {
  on(
    event: 'did-fail-load',
    listener: (
      event: unknown,
      errorCode: number,
      errorDescription: string,
      validatedURL: string,
      isMainFrame: boolean
    ) => void
  ): unknown;
  on(event: 'did-finish-load', listener: () => void): unknown;
  isDestroyed(): boolean;
  getURL(): string;
}

export interface RendererLoadRetryDeps {
  /** load the renderer's page (again); a rejection is reported through `did-fail-load` */
  load: () => Promise<void>;
  log: Pick<Logger, 'info' | 'warn' | 'error'>;
  retries?: number;
  /** ms before retry `n` (1-based); 250, 500, 750 by default */
  delayMs?: (attempt: number) => number;
  schedule?: (fn: () => void, ms: number) => void;
}

/**
 * Watch `contents` for a failed main-frame load of the renderer's page, log it,
 * and load the page again up to `retries` times.
 */
export function retryFailedRendererLoad(contents: LoadEvents, deps: RendererLoadRetryDeps): void {
  const retries = deps.retries ?? RENDERER_LOAD_RETRIES;
  const delayMs = deps.delayMs ?? ((n: number) => n * 250);
  const schedule = deps.schedule ?? ((fn: () => void, ms: number) => void setTimeout(fn, ms));
  let attempts = 0;
  // A load that succeeds after a retry says so, once, so the log shows the
  // window recovered rather than only that it failed. Armed when the retry is
  // ISSUED, not when the failure is seen: a failed load also finishes — as
  // Chromium's error page, a few ms after did-fail-load — and the URL is not a
  // reliable tell at that moment (measured: it still read as the page asked
  // for), so only a finish after our own retry counts.
  let retryIssued = false;

  contents.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
    try {
      if (!isMainFrame || errorCode === ERR_ABORTED) return;
      // whatever happens next, the load that just finished was not a recovery
      retryIssued = false;
      const line = { errorCode, errorDescription, url: validatedURL, attempt: attempts };
      if (attempts >= retries) {
        deps.log.error('the window could not load its page; giving up', line);
        return;
      }
      attempts += 1;
      deps.log.warn('the window failed to load its page; loading it again', line);
      schedule(() => {
        try {
          if (contents.isDestroyed()) return;
          // the outcome arrives as another did-fail-load or did-finish-load
          retryIssued = true;
          deps.load().catch(() => undefined);
        } catch (err) {
          deps.log.warn('reloading the window page threw', { error: errorText(err) });
        }
      }, delayMs(attempts));
    } catch (err) {
      deps.log.warn('the window load-failure handler threw', { error: errorText(err) });
    }
  });
  contents.on('did-finish-load', () => {
    if (!retryIssued) return;
    try {
      if (contents.getURL().startsWith('chrome-error:')) return;
      retryIssued = false;
      deps.log.info('the window loaded its page on a retry', { attempt: attempts });
    } catch {
      // logging is best-effort
    }
  });
}
