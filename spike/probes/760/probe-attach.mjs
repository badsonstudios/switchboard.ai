// Q1, Q3, Q4, Q5 — and NOT ONE TOKEN IS SPENT.
//
// The planning discovery that made this probe cheap: `mcp_status` answers
// `{name, status, serverInfo, config, scope, tools[]}` per server, and
// `system:init` carries `mcp_servers` too. So a server appearing as `connected`
// with `serverInfo` and our tools in `tools[]` PROVES the CLI launched it,
// spoke `initialize`, and called `tools/list` — no prompt required.
//
//   Q1  does the CLI launch our stdio server from `--mcp-config`?
//   Q3  do the user's own MCP servers survive the merge?
//   Q4  does an `env` block in the config reach the server process?
//   Q5  is argv passed through verbatim? (the identity-at-spawn premise of §5.4)
//
// Runs the CLI TWICE — once without the flag, once with — because Q3 is a
// difference and a single run cannot show one.
//
// SAFETY: `--mcp-config` is spawn-scoped and writes to NO config file (unlike
// `claude mcp add`), so there is nothing to clean up and nothing of Dan's is
// touched. Our server is named `sbbus`; his are only ever read by name.
//
//   node spike/probes/760/probe-attach.mjs [cwd]
import fs from 'node:fs';
import path from 'node:path';
import { startHost } from './pipe-host.mjs';
import { artifact, pipePathFor, pollMcpStatus, row, spawnCli } from './common.mjs';

const cwd = process.argv[2] || process.cwd();
const SERVER = path.join(import.meta.dirname, 'mcp-bus-server.mjs');
const artifactsDir = path.join(import.meta.dirname, 'artifacts');
fs.mkdirSync(artifactsDir, { recursive: true });

const pipePath = pipePathFor('attach');
// Binds the server log to THIS run. Must be a substring that survives
// `JSON.stringify` — the log records the pipe path escaped (`\\\\.\\pipe\\…`),
// so matching on `pipePath` itself silently never matches and turns Q4/Q5 into
// a permanent UNPROVEN. The tag carries our pid and contains no backslashes.
const RUN_TAG = `sb760-attach-${process.pid}`;
const logPath = path.join(artifactsDir, 'server.log');
// Fail LOUDLY rather than swallow. Q4 and Q5 are computed from this file, so a
// stale log left behind by a failed unlink would let them report YES from a
// PREVIOUS run while the current one launched nothing — the t=0 false negative
// inverted into a false positive. Every verdict below is additionally bound to
// this run by `pipePath`, which carries our pid.
try {
  fs.unlinkSync(logPath);
} catch (err) {
  if (err.code !== 'ENOENT') throw err;
}

const SESSION_ID = 'sb-session-probe-760';
const configPath = path.join(artifactsDir, 'bus-config.json');
fs.writeFileSync(
  configPath,
  JSON.stringify(
    {
      mcpServers: {
        sbbus: {
          type: 'stdio',
          // process.execPath, not "node": the probe must measure the CLI, not
          // whether this machine happens to have node on PATH. Production has
          // the harder version of this question — `hook-listener.ts:15` already
          // carries `findNodeOnPath()` — and #762 owns it.
          command: process.execPath,
          args: [SERVER, '--session', SESSION_ID, '--pipe', pipePath],
          env: {
            SB_PROBE_SESSION: SESSION_ID,
            SB_PROBE_LOG: logPath,
            // Q4's real target. If an env block reaches the child, then
            // running the bus via Electron-as-node is viable — which matters
            // because `providers/claude.ts` deliberately STRIPS this variable
            // from the session's own env, so it has to be re-added here or the
            // packaged app has no interpreter to run the server with.
            ELECTRON_RUN_AS_NODE: '1',
          },
        },
      },
    },
    null,
    2
  )
);

const findings = { cwd, configPath, pipePath, cli: null, runs: {} };
const host = await startHost(pipePath);

/** One CLI run: settle `mcp_status`, capture the inventory, kill it. */
async function run(label, extraArgs, until) {
  const session = spawnCli({ cwd, extraArgs });
  findings.cli ??= session.cli;
  const init = new Promise((resolve) => {
    session.onControl((m) => {
      if (m.type === 'system' && m.subtype === 'init') resolve(m.mcp_servers ?? null);
    });
    setTimeout(() => resolve('(no system:init within 20s)'), 20000);
  });
  // Same 500 ms the 721 probes wait before their first write. See the warning
  // on `pollMcpStatus` — writing at t=0 loses the message silently.
  await new Promise((r) => setTimeout(r, 500));
  session.send({ subtype: 'initialize' });
  const status = await pollMcpStatus(session, { until, timeoutMs: 25000 });
  const out = {
    args: session.args,
    initMcpServers: await init,
    why: status.why,
    sampleCount: status.samples.length,
    servers: (status.servers ?? []).map(row),
    // Every message type seen, so an ABSENCE is diagnosable instead of
    // mysterious — the difference between "the CLI said nothing" and "we asked
    // wrong" is the whole distance between a finding and a false negative.
    sawTypes: [...new Set(session.messages.map((m) => `${m.type}:${m.subtype ?? ''}`))],
    stderr: session.stderr.join('').slice(0, 2000),
  };
  session.kill();
  findings.runs[label] = out;
  console.log(`\n===== ${label} =====`);
  console.log('settled:', out.why, `(${out.sampleCount} samples)`);
  console.log(JSON.stringify(out.servers, null, 2).slice(0, 2500));
  return out;
}

// Baseline: whatever Dan already has, with no flag of ours.
// `servers.length > 0` is NOT belt-and-braces: `[].every(...)` is `true`, so an
// early empty `mcpServers` would settle the baseline instantly with zero
// servers — and Q3 ("nothing lost") is trivially satisfied by an empty before,
// which is a headline claim reported from no data at all.
const before = await run(
  'baseline',
  [],
  (servers) => servers.length > 0 && servers.every((s) => s.status !== 'pending')
);

// With the bus attached — and NO `--strict-mcp-config`, which is the flag that
// would evict everything above. Verified against `claude --help` 2.1.261:
// "Only use MCP servers from --mcp-config, ignoring all other MCP
// configurations". That is a help string; this run is the measurement.
// `until` waits for EVERY server to leave `pending`, not just ours. The first
// version stopped as soon as `sbbus` was connected and caught DeepWiki still
// pending — which would have made Q3 compare a settled baseline against a
// half-settled after, i.e. compare two different moments and call the
// difference a merge behaviour.
const after = await run('with --mcp-config', ['--mcp-config', configPath], (servers) => {
  const ours = servers.find((s) => s.name === 'sbbus');
  return Boolean(ours) && servers.every((s) => s.status !== 'pending');
});

// ── the three verdicts ──────────────────────────────────────────────────────
const ours = after.servers.find((s) => s.name === 'sbbus') ?? null;
findings.Q1 = {
  question: 'does the CLI launch our stdio server from --mcp-config?',
  server: ours,
  verdict: !ours
    ? 'NO — sbbus never appeared in mcp_status'
    : ours.status === 'connected' && ours.tools.length > 0
      ? `YES — connected, serverInfo=${JSON.stringify(ours.serverInfo)}, tools=${ours.tools.join(',')}`
      : `PARTIAL — status=${ours.status}, tools=${ours.tools.length}`,
};

const names = (r) => r.servers.map((s) => s.name).sort();
const lost = names(before).filter((n) => !names(after).includes(n));
findings.Q3 = {
  question: "do the user's own MCP servers survive the merge?",
  before: names(before),
  after: names(after),
  lost,
  // REFUSE to answer from an empty baseline. "Nothing was lost" is not a
  // finding when there was nothing to lose, and rendering it as YES is how a
  // probe reports a pass it never earned.
  verdict:
    names(before).length === 0
      ? 'UNPROVEN — the baseline listed no servers, so there was nothing to lose'
      : lost.length === 0
        ? `YES — nothing lost (measured against ${names(before).length}: ${names(before).join(', ')})`
        : `NO — LOST: ${lost.join(', ')}`,
};

// S8: `--strict-mcp-config` is the flag that should EVICT everything else. The
// note previously asserted that from the help string alone while measuring only
// its absence — and a third run costs nothing, so measure it rather than cite it.
const strict = await run(
  'with --mcp-config AND --strict-mcp-config',
  ['--mcp-config', configPath, '--strict-mcp-config'],
  (servers) => servers.length > 0 && servers.every((s) => s.status !== 'pending')
);
const strictNames = names(strict);
findings.Q7 = {
  question: 'does --strict-mcp-config really evict the user’s servers?',
  servers: strictNames,
  verdict: strictNames.length === 1 && strictNames[0] === 'sbbus'
    ? 'YES — only sbbus survives; this is the flag we must never pass'
    : `see servers: ${strictNames.join(', ') || '(none)'}`,
};

const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
const grab = (key) => log.split('\n').find((l) => l.includes(` ${key} `))?.trim() ?? null;
// Is this log OURS? `pipePath` carries `process.pid`, so a log from any earlier
// run cannot contain it. Without this, both verdicts below are computed from
// "some file on disk" rather than from this run.
const logIsThisRun = log.includes(RUN_TAG);

findings.Q4 = {
  question: 'does the config `env` block reach the server process?',
  SB_PROBE_SESSION: grab('ENV.SB_PROBE_SESSION'),
  ELECTRON_RUN_AS_NODE: grab('ENV.ELECTRON_RUN_AS_NODE'),
  logIsThisRun,
  // Bind the "1" to its own key. `log.includes('"1"')` scanned the whole file
  // and would match a "1" anywhere in it — including a timestamp.
  verdict:
    logIsThisRun && grab('ENV.ELECTRON_RUN_AS_NODE')?.endsWith('"1"')
      ? 'YES'
      : 'NO or UNPROVEN — check server.log',
};
findings.Q5 = {
  question: 'is argv passed through verbatim? (§5.4 identity-at-spawn)',
  argv: grab('ARGV'),
  sessionFromArgv: grab('SESSION_FROM_ARGV'),
  execPath: grab('EXECPATH'),
  clientProtocolVersion: grab('CLIENT_PROTOCOL_VERSION'),
  clientInfo: grab('CLIENT_INFO'),
  logIsThisRun,
  // Read the ARGV-derived line specifically. The old check was
  // `log.includes(SESSION_ID)`, which also matches the `ENV.SB_PROBE_SESSION`
  // line — so Q5 ("argv is verbatim") was passing on Q4's evidence.
  verdict:
    logIsThisRun && grab('SESSION_FROM_ARGV')?.includes(SESSION_ID)
      ? 'YES'
      : 'NO or UNPROVEN — check server.log',
};
findings.hostSaw = host.seen;
findings.serverLog = log;

console.log('\n\n########## VERDICTS ##########');
for (const q of ['Q1', 'Q3', 'Q4', 'Q5', 'Q7']) {
  console.log(`\n${q}: ${findings[q].question}\n  -> ${findings[q].verdict}`);
}
console.log('\nartifact:', artifact('attach.json', findings));
host.close();
process.exit(0);
