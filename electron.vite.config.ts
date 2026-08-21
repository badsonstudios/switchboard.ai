import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import type { PluginOption } from 'vite';
import react from '@vitejs/plugin-react';
import { CSP_PROD_META } from './src/shared/csp';
import { describeIdentity, probeBuildIdentity } from './src/build/git-identity';
import { stampChunkFileNames, stampManualChunks } from './src/build/stamp-chunk';
import { BUNDLED_INTO_MAIN } from './src/build/bundled-deps';

/**
 * Build identity (P2-E15-15) — git SHA + branch + dirty + build time, asked
 * ONCE here and compiled into all three targets as `__SWITCHBOARD_BUILD__`.
 *
 * Once, at config load, deliberately: electron-vite evaluates this module a
 * single time for main + preload + renderer, so all three carry the same
 * timestamp and the same SHA. Probing per-target would let a slow build stamp
 * three different times and make the About panel disagree with the window
 * title.
 *
 * The `define` has to be repeated on each target because vite scopes it per
 * build — a define on `renderer` alone would leave main's window title with a
 * dangling identifier. See src/shared/build-identity.ts for why this is a
 * stamp and not a committed counter.
 */
const BUILD_IDENTITY = probeBuildIdentity();
// echoed so `npm run build` says on stdout what it just baked in — the fastest
// possible confirmation that the bytes in out/ are the ones you meant
console.log(`[switchboard] build identity: ${describeIdentity(BUILD_IDENTITY)}`);
const buildDefine = { __SWITCHBOARD_BUILD__: JSON.stringify(BUILD_IDENTITY) };

/**
 * Put the prod CSP back into the BUILT html as a <meta> backstop (P2-E15-12).
 *
 * The policy normally arrives as a response header (src/shared/csp.ts). The one
 * path a header cannot reach is main's emergency `loadFile()` fallback, used
 * when the loopback static server fails to bind: `file://` responses are not
 * interceptable by `webRequest`, so that window would run with no policy at
 * all. `apply: 'build'` keeps the tag out of dev, where it would intersect with
 * the (deliberately looser) dev header and re-break Vite's inline preamble —
 * the exact accident this item removed.
 *
 * CSP_PROD_META, not CSP_PROD: a <meta> tag cannot carry `frame-ancestors` and
 * Chromium logs an error when it sees one there — an error our renderer-console
 * bridge would write into switchboard.log on every launch.
 *
 * `head-prepend` because a policy has to be the first thing parsed to govern
 * what follows. It therefore sits ahead of <meta charset>, which is fine while
 * the policy is a few hundred bytes (the encoding declaration must land inside
 * the first 1024) — worth remembering if the policy ever grows a lot.
 */
function cspMetaBackstop(): PluginOption {
  return {
    name: 'switchboard:csp-meta-backstop',
    apply: 'build',
    transformIndexHtml() {
      return [
        {
          tag: 'meta',
          attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP_PROD_META },
          injectTo: 'head-prepend',
        },
      ];
    },
  };
}

export default defineConfig({
  main: {
    // native/runtime deps (node-pty) must stay external — bundling a native
    // module breaks it. The exceptions are listed in src/build/bundled-deps.ts,
    // with the reason: i18next + i18next-icu are inlined because ICU's
    // formatter arrives through a PEER dependency this app never declares, so
    // externalizing them would ship an app that cannot compose a notification.
    plugins: [externalizeDepsPlugin({ exclude: [...BUNDLED_INTO_MAIN] })],
    define: buildDefine,
    build: {
      rollupOptions: {
        input: {
          index: 'src/main/index.ts',
          // standalone done-when checks, run via `electron --run-as-node`
          'pty-check': 'src/main/pty/lifecycle-check.ts',
          'adapter-check': 'src/main/providers/adapter-check.ts',
          'hook-check': 'src/main/hooks/hook-check.ts',
          'transcript-check': 'src/main/transcripts/transcript-check.ts',
          // the stream-json fake CLI (P2-E18-04) — a real program the fake
          // adapter spawns, run under `electron --run-as-node` like the checks
          'fake-stream-cli': 'src/main/providers/fake-stream-cli.ts',
          'fake-stream-check': 'src/main/providers/fake-stream-check.ts',
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    define: buildDefine,
  },
  renderer: {
    plugins: [react(), cspMetaBackstop()],
    define: buildDefine,
    build: {
      rollupOptions: {
        input: {
          // main app window + the same-origin popout window dockview opens
          index: 'src/renderer/index.html',
          popout: 'src/renderer/popout.html',
        },
        /**
         * The build stamp gets a chunk of its own, at a name with no [hash]
         * in it (#630). Without this, `builtAt` — a millisecond timestamp —
         * sat inside the hashed `index` chunk, so two builds of the same
         * commit renamed index and, transitively, eight more chunks. See
         * src/build/stamp-chunk.ts for the full mechanism and for why an
         * unhashed asset name is safe for this renderer.
         */
        output: {
          manualChunks: stampManualChunks,
          chunkFileNames: stampChunkFileNames,
        },
      },
    },
  },
});
