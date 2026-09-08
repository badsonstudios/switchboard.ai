// Where the bus child and the host meet (P2-E11-02) — the host's derivation of
// every path this channel uses.
//
// The HOST derives; the child is TOLD. `busLaunch` puts the endpoint and the
// token file on the child's argv, so the child never recomputes either and a
// `TMPDIR` that differs between Electron main and a CLI-spawned child cannot
// split them apart. (An earlier version of this comment claimed both ends
// imported this module "so they cannot disagree" — they cannot disagree, but
// not for that reason: the child imports only `BUS_SERVER_NAME`.)
//
// ── THE NAME IS DERIVED, NOT COMPOSED, AND THAT IS A UNIX CONSTRAINT ────────
//
// The obvious path is `<stateDir>/<sessionId>/bus.sock`, beside the session's
// `hook-token` and `settings.json`. It does not fit. A unix domain socket path
// lives in `sockaddr_un.sun_path`, which is 104 bytes on macOS/BSD and 108 on
// Linux — and on macOS the state dir alone is
// `~/Library/Application Support/switchboard.ai/sessions/` at ~62 characters
// before a 36-character session id and `/bus.sock` land on it. That is ~107:
// over the ceiling, on the platform with the smaller one, with a failure mode
// (`EINVAL` at bind, or a silently truncated path) that nothing in a Windows-
// only test run would ever show.
//
// So the endpoint name is a short digest of the session id, in the platform's
// runtime directory. That buys three things at once: it fits, it is stable from
// either end without passing state around, and it is unguessable — which
// matters on Linux, where `os.tmpdir()` is a world-writable `/tmp`.
//
// ── WHAT ACTUALLY GUARDS THIS CHANNEL ──────────────────────────────────────
//
// Three layers, and only the third is load-bearing:
//  1. A Windows named pipe is ACL'd to the creating user by default. On posix
//     the socket file is chmod'd 0600 after bind (`host-channel.ts`).
//  2. The name is a digest of a random session id, so it is not enumerable.
//  3. THE TOKEN. S-03's rule, unchanged: it lives in a 0600 file referenced by
//     PATH on the child's argv, never as the token itself, because argv is
//     world-readable on every platform we ship. Layers 1 and 2 are defence in
//     depth; this is the one that decides.
import crypto from 'crypto';
import os from 'os';
import path from 'path';

/**
 * The MCP server name the agent sees, and the first half of every tool name it
 * can call (`mcp__switchboard__list_sessions`).
 *
 * A plain English word rather than `sbbus` (#760's probe name): #760 measured
 * that tool NAMES are visible to the model while schemas are deferred, so this
 * string is part of what the agent reads when deciding whether the bus is
 * relevant to it. `sbbus` says nothing to anyone who has not read this file.
 */
export const BUS_SERVER_NAME = 'switchboard';

/** Filename of the per-session bus token, beside `hook-token` (S-03). */
export const BUS_TOKEN_FILE = 'bus-token';

/**
 * How much of the digest names the endpoint.
 *
 * 12 hex = 48 bits. Not a secret (the token is), so this only has to make
 * accidental collision impossible and enumeration pointless, while staying
 * short enough that the posix path clears `sun_path` with room to spare.
 */
const KEY_CHARS = 12;

export interface PathEnvironment {
  /** Defaults to the running platform. Injected so the posix path — and its
   *  length ceiling — can be exercised from a Windows test run and vice versa. */
  platform?: NodeJS.Platform;
  /** Defaults to `os.tmpdir()`. */
  tmpDir?: string;
}

/** The stable short key for a session id. */
export function busKey(sessionId: string): string {
  return crypto.createHash('sha256').update(sessionId).digest('hex').slice(0, KEY_CHARS);
}

/**
 * The endpoint both ends open: a named pipe on Windows, a unix socket
 * elsewhere.
 *
 * Per SESSION, not per app. One shared endpoint with the token as the only
 * discriminator would work, but this keeps the symmetry §5.4 chose stdio for:
 * one server process per session at the agent end, one endpoint per session at
 * the host end. A child cannot address a sibling's endpoint even if it wanted
 * to, so a token that leaks leaks against a path that is also unguessable.
 */
export function busPipePath(sessionId: string, env: PathEnvironment = {}): string {
  const key = busKey(sessionId);
  const platform = env.platform ?? process.platform;
  if (platform === 'win32') {
    // The `\\.\pipe\` namespace is flat and process-independent; the kernel
    // drops the pipe when the last handle closes, so there is nothing to unlink.
    return `\\\\.\\pipe\\switchboard-bus-${key}`;
  }
  return path.posix.join(env.tmpDir ?? os.tmpdir(), `sb-bus-${key}.sock`);
}

/** The 0600 file holding this session's token. Its PATH goes on argv; never its contents. */
export function busTokenPath(stateDir: string, sessionId: string): string {
  return path.join(stateDir, sessionId, BUS_TOKEN_FILE);
}
