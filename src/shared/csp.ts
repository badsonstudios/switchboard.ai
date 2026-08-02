// Content-Security-Policy for our renderer windows (P2-E15-12, §5.29, AR-P2-10).
//
// The policy is a RESPONSE HEADER, not a <meta> tag. The loopback static server
// emits it on everything it serves, and main re-asserts it for every response
// on the renderer's origin (`installCspHeaders`) so the Vite dev server's
// documents are covered by the same mechanism.
//
// What this replaces: index.html used to carry the policy in a <meta> tag, and
// said of itself that dev only worked because Vite happened to inject its
// react-refresh preamble ABOVE the tag — meta CSP governs only what is parsed
// after it. That was an accident of injection order, one Vite release away from
// breaking, and it meant the strictest-looking part of our security posture was
// the least reliable.
//
// The BUILT html still carries the policy as a meta backstop (injected at build
// time by electron.vite.config.ts; never present in dev). If the static server
// ever fails to bind, main falls back to `loadFile()`, and `file://` responses
// cannot be intercepted by `webRequest` — that degraded path would otherwise
// run with no policy at all. Header and backstop are rendered from one
// directive list, so they cannot drift, and identical policies intersect to
// themselves.

// Directives a <meta> CSP cannot carry: the browser IGNORES them there and
// logs an error saying so — which our renderer-console bridge would then write
// into switchboard.log on every launch, reading like a CSP failure to whoever
// is triaging. The meta backstop is rendered without them.
const META_IGNORED = ['frame-ancestors', 'report-uri', 'report-to', 'sandbox'];

const PROD_DIRECTIVES = [
  "default-src 'self'",
  "script-src 'self'",
  // xterm, dockview and Monaco all inject <style> elements and inline style
  // attributes at runtime, and popout.html carries a pre-paint <style> block.
  // Dropping this needs a nonce plumbed through three vendored libraries.
  "style-src 'self' 'unsafe-inline'",
  // NOTE: no worker-src. Monaco's own factory would wrap its worker in a
  // blob: URL, but DiffPane sets MonacoEnvironment.getWorker to Vite's
  // same-origin `?worker` build, so that path is unreachable and default-src
  // 'self' covers the worker we do create. Allowing blob: for a case the code
  // makes impossible would be the one directive weaker than the meta tag this
  // item replaced.
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
];

/** The real policy. Packaged builds, and the floor every change starts from. */
export const CSP_PROD = PROD_DIRECTIVES.join('; ');

/**
 * `CSP_PROD` minus the directives a <meta> tag cannot express — the build-time
 * backstop, and nothing else, should use this.
 */
export const CSP_PROD_META = PROD_DIRECTIVES.filter(
  (d) => !META_IGNORED.includes(d.split(/\s+/)[0])
).join('; ');

/**
 * Dev policy. Identical to prod except for what the Vite dev server needs:
 * its react-refresh preamble is an inline <script>, and HMR runs over a
 * WebSocket back to the dev server. Nothing here relaxes what ships.
 */
export const CSP_DEV = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "connect-src 'self' ws://localhost:* ws://127.0.0.1:* http://localhost:* http://127.0.0.1:*",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

/** The policy for the mode we are running in. */
export function cspPolicy(isDev: boolean): string {
  return isDev ? CSP_DEV : CSP_PROD;
}
