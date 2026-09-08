// How the bus child gets started (P2-E11-02) — the seam #763 writes into
// `--mcp-config`, and the one `bus-check.ts` drives directly.
//
// ── WHICH BINARY RUNS THE SERVER, AND WHY IT IS NOT `node` ─────────────────
//
// #762 asked for this to be "decided and tested, not assumed", and pointed at
// `hook-listener.ts:15`'s `findNodeOnPath()` as the precedent. It is the wrong
// precedent, and the measurement is one line:
//
//   ELECTRON_RUN_AS_NODE=1 electron.exe <app.asar>/child.js  → runs; and
//                                       fs.readFileSync of a sibling INSIDE
//                                       the archive works.        rc=0
//   node <app.asar>/child.js                                 → MODULE_NOT_FOUND
//                                                                rc=1
//
// (measured 2026-09-08 against this repo's own electron and a packed asar.)
//
// The bus server is a rollup entry, so in a packaged build it lives inside
// `app.asar`. Electron patches asar support into `fs` and keeps it under
// run-as-node; plain Node has no idea what an asar is. So `node` on PATH is not
// a fallback we are declining to prefer — it CANNOT run this file at all,
// packaged, without also unpacking it. `process.execPath` needs no PATH scan
// that can fail and is always the binary we are already running.
//
// That also settles the asymmetry #762 raised: a dead hook forwarder is a
// silent no-op, while a missing bus is a broken tool in front of the agent — so
// the bus takes the launcher that cannot be absent, not the one that usually
// is not. The real precedent is `providers/fake-stream.ts`, which spawns its
// compiled CLI exactly this way.
import fs from 'fs';
import path from 'path';
import type { BusEndpoint } from './host-channel';

/**
 * The compiled bus server.
 *
 * A rollup ENTRY, so it always lands in `out/main/`. This module is not: it is
 * imported by main and rollup is free to place it under `out/main/chunks/`,
 * which is exactly where `fake-stream.ts` went the first time — making
 * `join(__dirname, …)` point one directory too deep, and failing as a spawn
 * timeout rather than an error. Same candidates, same NAMED throw: a wrong path
 * must fail as a wrong path.
 */
export function busServerPath(baseDir: string = __dirname): string {
  // `baseDir` is a parameter so BOTH candidates can be exercised. With it
  // hard-coded, the only reachable test was the not-found throw — which passes
  // precisely because neither path exists under `src/` — so the `chunks/` arm,
  // the one that exists for the exact failure described below, was executed by
  // nothing at all.
  const candidates = [
    path.join(baseDir, 'bus-server.js'), // unbundled / same dir
    path.join(baseDir, '..', 'bus-server.js'), // bundled into chunks/
  ];
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) {
    throw new Error(
      `bus-server.js not found (looked in: ${candidates.join(', ')}). ` +
        'Run `npm run build` — the session bus needs the compiled server.'
    );
  }
  return found;
}

export interface BusLaunch {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/**
 * The spawn recipe for one session's bus server — the exact shape #763 hands
 * to `--mcp-config`, which #760 measured the CLI passes through verbatim on
 * both channels.
 *
 * The TOKEN PATH goes on argv; the token does not. S-03's rule, and the reason
 * it exists is that argv is world-readable on every platform we ship.
 */
export function busLaunch(sessionId: string, endpoint: BusEndpoint, serverPath = busServerPath()): BusLaunch {
  return {
    // `process.execPath` in the main process IS the Electron binary.
    command: process.execPath,
    args: [
      serverPath,
      '--session',
      sessionId,
      '--pipe',
      endpoint.pipePath,
      '--token-file',
      endpoint.tokenPath,
    ],
    env: {
      // Set DELIBERATELY. `providers/claude.ts` strips this from the SESSION's
      // environment (an S-01 landmine — it would make the CLI re-exec as bare
      // node), so it has to be re-added here on the server entry's own env
      // block. #760 measured that an `env` block in an MCP config reaches the
      // child intact, which is the mechanism this depends on.
      ELECTRON_RUN_AS_NODE: '1',
    },
  };
}
