// Shared harness for the #760 probes (P2-E11-00).
//
// The `721/` probes each carried their own copy of the spawn + NDJSON read
// loop, and one of them (`probe721b.mjs`) diverged in a way that made every
// ABSENCE it reported unsound — it `return`s where the others `continue`, so it
// abandons the rest of a chunk after the first non-`control_response` line.
// That is a copy-paste bug with a documented cost, so this set shares the loop.
//
// Nothing here is production code. It talks to the real CLI on the real
// account; no probe in this directory sends a prompt except `probe-toolcall`,
// which says so in its own header and in the README table.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Find the `claude` binary — and resolve PAST the npm `.cmd` shim.
 *
 * ⚠️ A PROBE DETAIL, NOT A FINDING ABOUT THE APP. On this machine PATH holds
 * only `claude.cmd` (plus `.ps1` and the shell script); the real 218 MB
 * `claude.exe` lives in the npm prefix's `node_modules`. **Node 22 refuses to
 * `child_process.spawn` a `.cmd` at all — `EINVAL`** (the CVE-2024-27980 fix;
 * it now demands `shell: true`, which drags cmd.exe's parser into the middle of
 * our argv). The first run of `probe-attach` died on exactly this.
 *
 * The APP does not have this problem and no finding here should imply it does:
 * sessions spawn through `node-pty`, which handles the shim, and the places
 * that do use `child_process` go through `main/transport/win-cmd.ts`'s
 * `execSpec()` — which exists because of #714 and escapes for both the MSVCRT
 * and cmd.exe parsers. We cannot import that TypeScript from a plain `.mjs`
 * probe, so we sidestep the shim instead: find the shim, then look for the
 * real executable underneath it.
 */
export function resolveCli() {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const isFile = (f) => {
    try {
      return fs.statSync(f).isFile();
    } catch {
      return false;
    }
  };
  if (process.platform !== 'win32') {
    for (const dir of dirs) {
      const full = path.join(dir, 'claude');
      if (isFile(full)) return full;
    }
    throw new Error('claude CLI not found on PATH — every finding here would be about nothing');
  }
  // A real .exe anywhere on PATH wins outright.
  for (const dir of dirs) {
    const full = path.join(dir, 'claude.exe');
    if (isFile(full)) return full;
  }
  // Otherwise: the npm shim tells us which prefix to dig under.
  for (const dir of dirs) {
    if (!isFile(path.join(dir, 'claude.cmd'))) continue;
    const real = path.join(dir, 'node_modules/@anthropic-ai/claude-code/bin/claude.exe');
    if (isFile(real)) return real;
  }
  throw new Error(
    'claude CLI not found as a spawnable .exe — a .cmd shim alone cannot be spawned by Node 22'
  );
}

/**
 * The stream-json flag list, kept identical to `main/providers/claude.ts`.
 *
 * Deliberately NOT reconstructed from `--help`, whose claim that these only
 * work with `--print` is stale (S-10 probe A ran without it).
 */
export const STREAM_ARGS = [
  '--output-format',
  'stream-json',
  '--verbose',
  '--input-format',
  'stream-json',
  '--permission-prompt-tool',
  'stdio',
  '--replay-user-messages',
  '--include-partial-messages',
];

/**
 * Spawn the CLI and hand back a reader over its stdout.
 *
 * `onMessage` sees every parsed line. Unparseable lines are surfaced rather
 * than swallowed — a CLI that starts printing something else is a finding, not
 * noise.
 */
export function spawnCli({ cwd, extraArgs = [], onRaw }) {
  const cli = resolveCli();
  const args = [...STREAM_ARGS, ...extraArgs];
  const child = spawn(cli, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  const listeners = [];
  const messages = [];
  const raw = [];
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d.toString();
    let i;
    // `continue`, never `return` — see the header.
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let m;
      try {
        m = JSON.parse(line);
      } catch {
        raw.push(line);
        onRaw?.(line);
        continue;
      }
      messages.push(m);
      for (const fn of listeners) fn(m);
    }
  });
  const stderr = [];
  child.stderr.on('data', (d) => stderr.push(d.toString()));
  let n = 0;
  const send = (request) => {
    const id = 'sb760-' + ++n;
    child.stdin.write(JSON.stringify({ type: 'control_request', request_id: id, request }) + '\n');
    return id;
  };
  return {
    child,
    args,
    send,
    stderr,
    raw,
    messages,
    cli,
    onControl: (fn) => listeners.push(fn),
    kill: () => child.kill(),
  };
}

/**
 * Ask for `mcp_status` and resolve with the server list.
 *
 * ⚠️ POLLS, and that is not defensiveness. `probe-mcp-settle.mjs` (#729)
 * measured this exact call answering `pending` with no tools at 0.9 s and
 * `connected` with `serverInfo` and 3 tools at 5.0 s. A single sample taken
 * early reports a healthy server as broken.
 */
export function pollMcpStatus(session, { until, timeoutMs = 25000, intervalMs = 1500 }) {
  return new Promise((resolve) => {
    const seen = [];
    let done = false;
    const finish = (why) => {
      if (done) return;
      done = true;
      clearInterval(timer);
      clearTimeout(cap);
      resolve({ servers: seen.at(-1) ?? null, samples: seen, why });
    };
    const handler = (m) => {
      if (m.type !== 'control_response') return;
      const r = m.response ?? {};
      // ⚠️ The payload is DOUBLY nested: `m.response.response.mcpServers`. The
      // outer `response` carries the subtype, the inner one the data — the same
      // shape 721's finding 1 flagged for `request_id`. A reader that stops one
      // level too early matches nothing, for ever, and looks exactly like a CLI
      // that never answered.
      const servers = r.response?.mcpServers ?? r.mcpServers ?? null;
      if (!servers) return;
      seen.push(servers);
      if (!until || until(servers)) finish('settled');
    };
    session.onControl(handler);
    // ⚠️ DO NOT WRITE AT t=0. The first version of this polled from the instant
    // `spawn()` returned and got ZERO samples across two full runs — which read
    // as "the CLI never answers" and produced a confident FALSE NEGATIVE on Q1,
    // while the server log proved the CLI had launched our server and completed
    // the handshake. The 721 probes all wait ~500 ms before their first write;
    // that delay was load-bearing and undocumented. This is 721's own lesson 2
    // ("a silent CLI is worth suspecting your own probe over") collected a
    // second time, by the same trap.
    const first = setTimeout(() => session.send({ subtype: 'mcp_status' }), 800);
    const timer = setInterval(() => session.send({ subtype: 'mcp_status' }), intervalMs);
    const cap = setTimeout(() => {
      clearTimeout(first);
      finish('timeout');
    }, timeoutMs);
  });
}

/** Compact one server's status row to the fields every finding here cites. */
export function row(s) {
  return {
    name: s.name,
    status: s.status,
    scope: s.scope,
    serverInfo: s.serverInfo ?? null,
    tools: (s.tools ?? []).map((t) => (typeof t === 'string' ? t : t.name)),
  };
}

/** Write a JSON artifact beside the probes so a finding cites a file, not a scrollback. */
export function artifact(name, data) {
  const dir = path.join(import.meta.dirname, 'artifacts');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
  return file;
}

/** The pipe/socket address for a probe run. Windows wants the `\\.\pipe\` form. */
export function pipePathFor(tag) {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\sb760-${tag}-${process.pid}`
    : path.join(process.env.TMPDIR ?? '/tmp', `sb760-${tag}-${process.pid}.sock`);
}
