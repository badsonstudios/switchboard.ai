// B2 — DOES A BROKEN BUS DELAY OR BLOCK A REAL TURN? ⚠️ SPENDS ONE TINY TURN.
//
// `probe-deadserver.mjs` proved the CLI's CONTROL CHANNEL stays responsive with
// a broken bus attached. Review correctly pointed out that this is not the same
// claim as "session fine": it never ran a turn, and the question that actually
// matters for the fail-open constraint — does a `pending` MCP server delay the
// first token? — was the one not asked. It is plausible the CLI waits for MCP
// servers to settle before running a turn, which would make the headline claim
// false in exactly the case the note calls most likely to reach a user.
//
// CONTAINMENT — deliberately much tighter than `probe-toolcall`/`probe-discovery`:
// this needs NO tools, so it gets none. `--permission-mode default` and a
// prompt that asks for four characters. Those two probes used
// `bypassPermissions`, and one of them went well past its scratch directory:
// it enumerated the machine's other live Claude sessions and messaged six of
// them. A cwd is not a sandbox and it never was — the real containment is not
// handing the turn a reason or a permission to act.
//
//   node spike/probes/760/probe-deadturn.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { artifact, resolveCli } from './common.mjs';

const artifactsDir = path.join(import.meta.dirname, 'artifacts');
fs.mkdirSync(artifactsDir, { recursive: true });
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sb760-deadturn-'));

const silentPath = path.join(artifactsDir, 'silent-server.mjs');
fs.writeFileSync(silentPath, 'setInterval(() => {}, 1 << 30);\n');

const findings = { scratch, runs: {} };

/** One `-p` turn; report time to first token and to completion. */
async function turn(label, extraArgs) {
  const t0 = Date.now();
  const child = spawn(
    resolveCli(),
    [
      '-p',
      'Reply with exactly: ok',
      '--output-format',
      'stream-json',
      '--verbose',
      // NOT bypassPermissions. Nothing here should touch a tool, and if the
      // model reaches for one anyway the run stalls instead of acting — which
      // is the outcome we want from a probe that is only timing startup.
      '--permission-mode',
      'default',
      ...extraArgs,
    ],
    { cwd: scratch, stdio: ['ignore', 'pipe', 'pipe'] }
  );

  let firstTokenMs = null;
  const toolUses = [];
  let buf = '';
  let result = null;
  child.stdout.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let m;
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      if (m.type === 'assistant' || m.type === 'stream_event') firstTokenMs ??= Date.now() - t0;
      for (const b of m.message?.content ?? []) if (b.type === 'tool_use') toolUses.push(b.name);
      if (m.type === 'result') result = { subtype: m.subtype, text: String(m.result ?? '').slice(0, 200) };
    }
  });
  await new Promise((resolve) => {
    child.on('exit', resolve);
    setTimeout(() => {
      child.kill();
      resolve();
    }, 120000);
  });

  const out = { firstTokenMs, totalMs: Date.now() - t0, result, toolUses, args: extraArgs };
  findings.runs[label] = out;
  console.log(`\n== ${label} ==\n  first token: ${firstTokenMs}ms · total: ${out.totalMs}ms`);
  console.log('  result:', JSON.stringify(result));
  return out;
}

// Control first, so the comparison is against this machine right now rather
// than against a remembered number.
const control = await turn('control (no --mcp-config)', []);

const configPath = path.join(artifactsDir, 'deadturn-silent.json');
fs.writeFileSync(
  configPath,
  JSON.stringify({
    mcpServers: {
      sbbus: { type: 'stdio', command: process.execPath, args: [silentPath] },
    },
  })
);
const silent = await turn('with a SILENT (never-speaks-MCP) bus', ['--mcp-config', configPath]);

const delta = (silent.firstTokenMs ?? Infinity) - (control.firstTokenMs ?? 0);
findings.B2 = {
  question: 'does a permanently-pending MCP server delay or block the first turn?',
  controlFirstTokenMs: control.firstTokenMs,
  silentFirstTokenMs: silent.firstTokenMs,
  deltaMs: delta,
  completed: silent.result?.subtype ?? null,
  verdict:
    silent.result == null
      ? '⚠️ BLOCKING — the turn never completed with a silent bus attached'
      : delta > 5000
        ? `⚠️ DELAYS THE TURN by ~${delta}ms — fail-open is NOT free`
        : `survivable — first token ${delta}ms apart; the turn completed normally`,
};

console.log('\n\n########## B2 ##########');
console.log(findings.B2.verdict);
console.log('\nartifact:', artifact('deadturn.json', findings));
process.exit(0);
