// The Session Bus MCP server (P2-E11-02, §5.4) — THE CHILD ENTRY. Wiring only.
//
// One process per session. The CLI spawns it from `--mcp-config` (#763 writes
// that config) and owns its stdin/stdout — which is the whole reason there is a
// second channel underneath. A stdio MCP server cannot answer `list_sessions`
// without asking Electron main, and its stdio is already spoken for; that
// channel is a named pipe / unix socket (`pipe-client.ts`, `host-channel.ts`).
//
// All behaviour lives in `bus-tools.ts` and `protocol.ts`, unit-tested without
// spawning. This file is argv and pipes, and is proven end to end — under the
// real Electron binary, over a real endpoint — by `npm run check:bus`.
// Compiled as a standalone main-process entry (`out/main/bus-server.js`) and
// run under `electron --run-as-node`, exactly like the fake stream CLI.
//
// ── IDENTITY AT SPAWN, AND WHY THE HOST DOES NOT TRUST THIS FILE ───────────
//
// §5.4 chose stdio because an MCP tool call carries no ambient session
// identity, and one process per session gets it free: `--session` on argv,
// which #760 measured arrives verbatim. But argv is world-readable and a child
// is not a trusted narrator, so the HOST derives the caller from the TOKEN it
// presents, never from this flag. `--session` labels our own log lines and
// nothing else.
//
// ── WHY THIS PROCESS NEVER EXITS ON A BAD SETUP ────────────────────────────
//
// A missing `--pipe` or `--token-file` is a misconfiguration, and the tempting
// response is to exit loudly. Don't. #760 measured what a server that fails to
// speak MCP costs the session — first token 3.0 s → 35.2 s, a ~32 s stall
// consistent with a ~30 s connect timeout — and a process that dies at startup
// is at best an unmeasured variant of that. Staying up and answering
// `initialize` costs nothing and turns the misconfiguration into a tool error
// the agent can read, instead of a stall nobody can see.
import { BUS_SERVER_NAME } from './bus-paths';
import { apply, makeCallTool, TOOLS } from './bus-tools';
import { LineReader, dispatch, parseLine } from './protocol';

const argv = process.argv.slice(2);
function arg(name: string): string | null {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

const sessionId = arg('--session') ?? '(unknown)';
const pipePath = arg('--pipe');
const tokenPath = arg('--token-file');

/** stderr only, and best-effort. The CLI may or may not surface it; a finding
 *  that depends on which would be a finding about our luck (#760's note). */
function log(...parts: unknown[]): void {
  try {
    process.stderr.write(`[sb-bus ${sessionId}] ${parts.join(' ')}\n`);
  } catch {
    /* a closed stderr is not a reason to stop serving */
  }
}

const options = {
  serverName: BUS_SERVER_NAME,
  serverVersion: '1.0.0',
  tools: TOOLS,
  callTool: makeCallTool({ pipePath, tokenPath, log: (m) => log(m) }),
};

// STDIO FAULTS ARRIVE AS EVENTS, NOT THROWS, and only a spawned process ever
// sees them. `send`'s try/catch cannot catch an EPIPE on stdout — that surfaces
// asynchronously — so without these the child dies with a stack trace printed
// onto the CLI's stderr the moment the CLI goes away. Nothing is recoverable
// here; the point is to exit quietly rather than noisily (P6: our breakage is
// never the session's problem).
process.stdout.on('error', () => process.exit(0));
process.stdin.on('error', () => process.exit(0));
process.on('uncaughtException', (err) => {
  log('uncaught exception — exiting:', String(err));
  process.exit(0);
});

function send(msg: unknown): void {
  try {
    process.stdout.write(JSON.stringify(msg) + '\n');
  } catch (err) {
    log('could not write to stdout:', String(err));
  }
}

const reader = new LineReader();
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  for (const line of reader.feed(chunk)) {
    const msg = parseLine(line);
    if (msg === null) {
      log('unparseable line, ignored');
      continue;
    }
    apply(dispatch(msg, options), send, (err) => log('tool handler rejected — this is a bug:', String(err)));
  }
  if (reader.hasOverflowed()) {
    // Past this point we cannot tell where a message ends, so continuing would
    // feed fragments to `dispatch`. The CLI owns our stdin; if it ever sends
    // something this large, silence is safer than guessing.
    log('inbound line exceeded the frame limit — refusing to read further');
  }
});
// The CLI closing our stdin is how a session ends. Nothing to flush: every
// reply is written synchronously as it is produced.
process.stdin.on('end', () => process.exit(0));
process.stdin.resume();
log('ready', pipePath ? `pipe=${pipePath}` : '(no pipe configured)');
