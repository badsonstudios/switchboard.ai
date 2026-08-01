// Environment scrubbing, shared by EVERY transport (P2-E18-02).
//
// This used to live in `pty/pty-service.ts`, which was fine while the PTY was
// the only way to host a CLI. It is not any more (DESIGN §6 amendment
// 2026-08-01), and the S-01 landmines are a property of *spawning a child from
// Electron*, not of node-pty: a stream-json child inherits the same poisoned
// env from the same parent. A hand-copied second list is how "both transports
// behave the same" quietly stops being true, so there is exactly one.

// S-01 landmines: these must never leak from our process into a hosted CLI.
// ELECTRON_RUN_AS_NODE makes the child re-exec as bare node;
// ELECTRON_NO_ATTACH_CONSOLE breaks console attachment on Windows.
const SCRUB_ALWAYS = ['ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ATTACH_CONSOLE'];

export function buildEnv(
  base: NodeJS.ProcessEnv,
  deltas?: Record<string, string | undefined>
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const k of SCRUB_ALWAYS) delete env[k];
  for (const [k, v] of Object.entries(deltas ?? {})) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env;
}
