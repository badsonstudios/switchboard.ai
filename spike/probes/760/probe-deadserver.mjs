// Q6 — DOES A BROKEN BUS BLOCK A SESSION? Costs nothing.
//
// This is the probe that matters most for #763, and it is here because of a
// hard constraint rather than curiosity: **our breakage never blocks a
// session.** If a `--mcp-config` naming a command that does not exist stops the
// CLI starting, hangs it, or delays it materially, then #763 cannot simply add
// the flag — it needs a guard, and the "every capability call is fail-open"
// promise in §5.3 would be false the moment the bus binary goes missing after
// an app update.
//
// Three configs, run in sequence, each against a fresh CLI:
//   1. a command that does not exist at all
//   2. a command that exists, starts, and then EXITS IMMEDIATELY
//   3. a command that exists, starts, and NEVER SPEAKS MCP (silent hang)
//
// (3) is the interesting one. A server that dies is easy to notice; a server
// that holds the pipe open and says nothing is how a startup hangs.
//
//   node spike/probes/760/probe-deadserver.mjs [cwd]
import fs from 'node:fs';
import path from 'node:path';
import { artifact, pollMcpStatus, row, spawnCli } from './common.mjs';

const cwd = process.argv[2] || process.cwd();
const artifactsDir = path.join(import.meta.dirname, 'artifacts');
fs.mkdirSync(artifactsDir, { recursive: true });

// A "server" that starts cleanly and then says absolutely nothing, for ever.
const silentPath = path.join(artifactsDir, 'silent-server.mjs');
fs.writeFileSync(silentPath, 'setInterval(() => {}, 1 << 30);\n');

const CASES = {
  'missing-binary': {
    type: 'stdio',
    command: 'sb-definitely-not-a-real-binary-760',
    args: [],
  },
  'exits-immediately': {
    type: 'stdio',
    command: process.execPath,
    args: ['-e', 'process.exit(1)'],
  },
  'silent-never-speaks-mcp': {
    type: 'stdio',
    command: process.execPath,
    args: [silentPath],
  },
};

const findings = { cwd, cases: {} };

for (const [label, server] of Object.entries(CASES)) {
  const configPath = path.join(artifactsDir, `dead-${label}.json`);
  fs.writeFileSync(configPath, JSON.stringify({ mcpServers: { sbbus: server } }, null, 2));

  const t0 = Date.now();
  const session = spawnCli({ cwd, extraArgs: ['--mcp-config', configPath] });
  await new Promise((r) => setTimeout(r, 500));
  session.send({ subtype: 'initialize' });

  // THE QUESTION: does the CLI still answer us at all? `mcp_status` is the
  // probe because it is the one call guaranteed to touch the MCP subsystem —
  // if a broken server can wedge anything, it wedges this.
  const status = await pollMcpStatus(session, {
    // `sbbus` must actually be LISTED before "every server settled" means
    // anything — otherwise this settles on the pre-existing servers alone and
    // reports `ours reported as (absent)`, which reads as a pass.
    until: (servers) =>
      servers.some((s) => s.name === 'sbbus') && servers.every((s) => s.status !== 'pending'),
    timeoutMs: 30000,
  });
  const elapsedMs = Date.now() - t0;

  const out = {
    config: server,
    elapsedMs,
    why: status.why,
    responded: status.samples.length > 0,
    servers: (status.servers ?? []).map(row),
    sawTypes: [...new Set(session.messages.map((m) => `${m.type}:${m.subtype ?? ''}`))],
    stderr: session.stderr.join('').slice(0, 1500),
  };
  out.verdict = !out.responded
    ? `⚠️ BLOCKING — the CLI never answered within ${elapsedMs}ms`
    : `survivable — CLI answered, ours reported as ${
        out.servers.find((s) => s.name === 'sbbus')?.status ?? '(absent)'
      } after ${elapsedMs}ms`;

  session.kill();
  findings.cases[label] = out;
  console.log(`\n===== ${label} =====\n  ${out.verdict}`);
  console.log('  servers:', JSON.stringify(out.servers));
}

console.log('\n\n########## Q6 ##########');
console.log('does a broken bus config block a session?');
for (const [label, out] of Object.entries(findings.cases)) {
  console.log(`  ${label}: ${out.verdict}`);
}
console.log('\nartifact:', artifact('deadserver.json', findings));
process.exit(0);
