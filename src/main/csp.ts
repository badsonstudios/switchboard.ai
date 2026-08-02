// Header-based CSP for every renderer window (P2-E15-12, §5.29, AR-P2-10).
//
// One `onHeadersReceived` listener on the default session stamps the policy
// onto every response served from the renderer's own origin — the Vite dev
// server in dev, our loopback static server when packaged. Both the main window
// and dockview's popout window live in that session and load from that origin,
// so both are covered by the same three lines.
//
// Fail-open (the hard constraint): a `webRequest` listener that throws never
// calls its callback, and the request hangs forever — a blank window. Every
// path through the listener therefore ends in exactly one `callback(...)` — the
// last statement, outside the try — and the error path passes the response
// through untouched rather than dying.
//
// HAZARD, read before adding another webRequest listener: Electron allows
// exactly ONE `onHeadersReceived` listener per session, and a second
// registration SILENTLY REPLACES the first. Registering one elsewhere would
// remove the CSP with no error anywhere. Compose here instead. The same applies
// to any window put on a non-default session (a `partition:`ed webview gets no
// policy from this) — which is the case the sandboxed plugin panel will hit.
import type { Session } from 'electron';
import { cspPolicy } from '../shared/csp';

type Headers = Record<string, string | string[]>;

/**
 * `headers` with every existing CSP header replaced by exactly one `policy`.
 *
 * Replace, not append: multiple CSP headers are INTERSECTED by the browser, so
 * appending would silently apply the strictest combination of whatever anyone
 * happened to set. One header in, one header out — what you read here is what
 * the renderer enforces.
 */
export function withCspHeader(headers: Headers | undefined, policy: string): Headers {
  const out: Headers = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    const lower = key.toLowerCase();
    if (lower === 'content-security-policy' || lower === 'content-security-policy-report-only') {
      continue;
    }
    out[key] = value;
  }
  out['content-security-policy'] = [policy];
  return out;
}

/** True when `url` is served from the renderer's own origin. */
export function isRendererResponse(url: string, origin: string | null): boolean {
  if (!origin) return false;
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

/**
 * Stamp the CSP onto every response from the renderer's origin.
 *
 * `rendererOrigin` is read per-request rather than captured: the packaged
 * loopback server binds a RANDOM port, so the origin is not known until it
 * listens, and in dev it comes from the dev-server URL instead.
 */
export function installCspHeaders(
  session: Session,
  rendererOrigin: () => string | null,
  isDev: boolean,
  onError?: (err: unknown) => void
): void {
  let reportedError = false;
  session.webRequest.onHeadersReceived((details, callback) => {
    // omitting responseHeaders leaves the originals untouched — the
    // pass-through for anything that is not ours, and for the error path
    let response: Electron.HeadersReceivedResponse = {};
    try {
      if (isRendererResponse(details.url, rendererOrigin())) {
        response = {
          responseHeaders: withCspHeader(details.responseHeaders as Headers, cspPolicy(isDev)),
        };
      }
    } catch (err) {
      // once, not once per response: this runs for every request in the
      // session, and a persistent fault would otherwise fill the log
      if (!reportedError) {
        reportedError = true;
        onError?.(err);
      }
    }
    callback(response);
  });
}
