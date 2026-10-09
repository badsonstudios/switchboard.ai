// #1115 probe: how is the EFFORT level set and read on the CLI on PATH?
//
// The ticket was written against 2.1.245 and names `set_thinking_level`. This
// asks the installed binary, without sending a prompt (no turns, no cost):
//   1. list_models            -> which models carry supportsEffort / levels
//   2. get_settings           -> is the current effort level readable?
//   3. set_thinking_level     -> does the verb still exist?
//   4. apply_flag_settings    -> does {effortLevel} take, and does get_settings show it?
//   5. apply_flag_settings with a level that is not in the list
//   6. apply_flag_settings {effortLevel: null} -> back to the default?
import { spawn } from 'node:child_process';

const cwd = process.argv[2] || process.cwd();
const cli =
  'C:/Users/dheinz/AppData/Roaming/npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe';
const args = [
  '--output-format', 'stream-json', '--verbose',
  '--input-format', 'stream-json',
  '--permission-prompt-tool', 'stdio',
  '--replay-user-messages', '--include-partial-messages',
];
const child = spawn(cli, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });

let buf = '';
let n = 0;
const sent = new Map();
const send = (request, note) => {
  const id = 'sb-' + ++n;
  sent.set(id, note ?? request.subtype);
  child.stdin.write(JSON.stringify({ type: 'control_request', request_id: id, request }) + '\n');
};

/** every path in an object whose key mentions effort or thinking */
function effortPaths(obj, at = '', out = []) {
  if (!obj || typeof obj !== 'object') return out;
  for (const [k, v] of Object.entries(obj)) {
    const p = at ? `${at}.${k}` : k;
    if (/effort|thinking/i.test(k)) out.push(`${p} = ${JSON.stringify(v)}`.slice(0, 220));
    if (v && typeof v === 'object' && !Array.isArray(v)) effortPaths(v, p, out);
  }
  return out;
}

child.stdout.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    if (m.type !== 'control_response') {
      // anything unsolicited that mentions effort is worth seeing
      if (/effort/i.test(line)) console.log(`\n[unsolicited ${m.type}/${m.subtype ?? ''}]`, line.slice(0, 400));
      continue;
    }
    const r = m.response || {};
    const note = sent.get(r.request_id) ?? '??';
    console.log(`\n[${note}] subtype=${JSON.stringify(r.subtype)}`);
    const payload = r.subtype === 'error' ? r.error : r.response;
    if (note === 'list_models') {
      for (const mo of payload?.models ?? []) {
        console.log(
          '   ', mo.value, '| supportsEffort =', mo.supportsEffort,
          '| levels =', JSON.stringify(mo.supportedEffortLevels),
          '| other effort keys:', JSON.stringify(Object.keys(mo).filter((k) => /effort|think/i.test(k)))
        );
      }
    } else if (note.startsWith('get_settings') || note === 'initialize') {
      console.log('    top-level keys:', JSON.stringify(Object.keys(payload ?? {})));
      const paths = effortPaths(payload);
      console.log('    effort/thinking paths:', paths.length ? '' : '(none)');
      for (const p of paths) console.log('      ', p);
    } else {
      console.log('   ', (JSON.stringify(payload) ?? '(none)').slice(0, 500));
    }
  }
});
child.stderr.on('data', (d) => process.stderr.write('[err] ' + d));

const at = (ms, fn) => setTimeout(fn, ms);
at(500, () => send({ subtype: 'initialize' }));
at(3500, () => send({ subtype: 'list_models' }));
at(5000, () => send({ subtype: 'get_settings' }, 'get_settings BEFORE'));
at(6500, () => send({ subtype: 'set_thinking_level', level: 'high' }, 'set_thinking_level'));
at(8000, () => send({ subtype: 'apply_flag_settings', settings: { effortLevel: 'high' } }, 'apply effortLevel=high'));
at(9500, () => send({ subtype: 'get_settings' }, 'get_settings AFTER high'));
at(11000, () => send({ subtype: 'apply_flag_settings', settings: { effortLevel: 'no-such-level' } }, 'apply effortLevel=BAD'));
at(12500, () => send({ subtype: 'get_settings' }, 'get_settings AFTER bad'));
at(14000, () => send({ subtype: 'apply_flag_settings', settings: { effortLevel: null } }, 'apply effortLevel=null'));
at(15500, () => send({ subtype: 'get_settings' }, 'get_settings AFTER null'));
at(19000, () => {
  child.kill();
  process.exit(0);
});
