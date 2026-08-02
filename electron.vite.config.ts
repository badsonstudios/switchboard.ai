import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import type { PluginOption } from 'vite';
import react from '@vitejs/plugin-react';
import { CSP_PROD_META } from './src/shared/csp';

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
    // module breaks it
    plugins: [externalizeDepsPlugin()],
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
  },
  renderer: {
    plugins: [react(), cspMetaBackstop()],
    build: {
      rollupOptions: {
        input: {
          // main app window + the same-origin popout window dockview opens
          index: 'src/renderer/index.html',
          popout: 'src/renderer/popout.html',
        },
      },
    },
  },
});
