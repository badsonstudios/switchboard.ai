// #633 — which picker commands have a NON-TUI path, and which honestly do not?
//
// #633's third done-when is "every remaining picker command has a recorded
// disposition (GUI / hand-off / out of scope)". That table is only worth
// writing if it is decided by EVIDENCE — the alternative is me picking, and the
// standing rule exists because #632 and #714 both picked "no verb exists" from
// a help page and were wrong.
//
// So: for every plausible verb behind every picker command, ask the CLI. The
// discriminator is the one `probe-mcp-verbs.mjs` established —
//
//   absent verb  -> "Unsupported control request subtype: <name>"
//   real verb    -> anything else (a payload, or a complaint about arguments)
//
// EVERY CALL HERE IS A READ or a deliberately-invalid write. Nothing is sent
// that could change a setting: the `set_*` verbs are probed with NO arguments,
// which either draws a validation complaint (proving the verb) or an
// unsupported-subtype error (disproving it). ⚠️ The ONE exception to trust:
// `set_model` is known to no-op on a missing field, so a `set_*` that
// SUCCEEDS with no arguments is a verb that may have just done something —
// flagged loudly in the output rather than assumed harmless.
import { spawn } from 'node:child_process';

const cwd = process.argv[2] || process.cwd();
const cli =
  process.env.CLAUDE_BIN ||
  'C:/Users/dheinz/AppData/Roaming/npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe';

/**
 * The picker commands #633 lists, and the verbs each might plausibly ride on.
 * Names are guesses; that is the point — the CLI says which exist.
 */
const CANDIDATES = [
  // measured already (#721) — included as positive controls
  ['/model', 'list_models'],
  ['/model', 'set_model'],
  ['/mcp', 'mcp_status'],
  // the ones #633 actually asks about
  ['/permissions', 'get_permission_mode'],
  ['/permissions', 'set_permission_mode'],
  ['/permissions', 'list_permission_modes'],
  ['/config', 'get_settings'],
  ['/config', 'set_settings'],
  ['/agents', 'list_agents'],
  ['/agents', 'get_agents'],
  ['/agents', 'set_agent'],
  ['/hooks', 'list_hooks'],
  ['/hooks', 'get_hooks'],
  ['/resume', 'list_sessions'],
  ['/resume', 'list_conversations'],
  ['/resume', 'resume_session'],
  ['/rewind', 'list_checkpoints'],
  ['/rewind', 'rewind'],
  ['/output-style', 'list_output_styles'],
  ['/output-style', 'set_output_style'],
  ['/output-style', 'get_output_style'],
  ['/context', 'get_context_usage'],
  ['/usage', 'get_usage'],
  ['/status', 'get_status'],
  // the negative control — must come back unsupported, or the discriminator is
  // meaningless and every result above is worthless
  ['(control)', '__definitely_not_a_verb__'],
];

const child = spawn(
  cli,
  ['--output-format', 'stream-json', '--verbose', '--input-format', 'stream-json',
   '--permission-prompt-tool', 'stdio', '--replay-user-messages', '--include-partial-messages'],
  { cwd, stdio: ['pipe', 'pipe', 'pipe'] }
);
let buf = '';
let n = 0;
const sent = new Map();
const results = [];

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
    if (m.type !== 'control_response') continue;
    const r = m.response || {};
    const meta = sent.get(r.request_id);
    if (!meta) continue;
    const err = r.subtype === 'error' ? String(r.error ?? '') : '';
    const unsupported = /unsupported control request subtype/i.test(err);
    results.push({
      command: meta.command,
      verb: meta.verb,
      exists: !unsupported,
      // A SUCCESS on a no-argument `set_*` is the `set_model` shape and needs a
      // human to look at it, not a tick in a table.
      suspicious: r.subtype !== 'error' && meta.verb.startsWith('set_'),
      detail: err || JSON.stringify(r.response ?? null).slice(0, 120),
    });
  }
});
child.stderr.on('data', (d) => process.stderr.write('[err] ' + d));

setTimeout(() => {
  for (const [command, verb] of CANDIDATES) {
    const id = 'sb-' + ++n;
    sent.set(id, { command, verb });
    child.stdin.write(
      JSON.stringify({ type: 'control_request', request_id: id, request: { subtype: verb } }) + '\n'
    );
  }
}, 1500);

setTimeout(() => {
  const control = results.find((r) => r.verb === '__definitely_not_a_verb__');
  console.log(
    control && !control.exists
      ? '✔ discriminator sound (the control verb came back unsupported)\n'
      : '✘ DISCRIMINATOR BROKEN — every result below is worthless\n'
  );
  console.log('EXISTS:');
  for (const r of results.filter((r) => r.exists))
    console.log(`  ${r.command.padEnd(15)} ${r.verb.padEnd(24)} ${r.suspicious ? '⚠️ SUCCEEDED WITH NO ARGS — may have acted! ' : ''}${r.detail.slice(0, 90)}`);
  console.log('\nDOES NOT EXIST:');
  for (const r of results.filter((r) => !r.exists && r.verb !== '__definitely_not_a_verb__'))
    console.log(`  ${r.command.padEnd(15)} ${r.verb}`);
  const missing = CANDIDATES.length - results.length;
  if (missing) console.log(`\n⚠️ ${missing} verb(s) never answered at all — do NOT read that as absent.`);
  child.kill();
  process.exit(0);
}, 12000);
