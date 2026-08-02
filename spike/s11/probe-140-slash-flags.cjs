// #140 follow-up probe — WHY DO SLASH COMMANDS DO NOTHING IN OUR DIRECT MODE?
//
// Dan hand-tested PR #163: `/usage`, `/agents`, `/model` and friends all do
// NOTHING in a Direct session, while every non-slash prompt works. Both our unit
// tests and our e2e assert the opposite — against the FAKE. Same blind-spot
// pattern as #153/#154/#139: the fake passes, the real CLI does not.
//
// `probe-local-commands.cjs` measured `/usage` working over stream-json. The one
// thing it did NOT reproduce is our ARGUMENT LIST. It spawns with four flags:
//
//     --output-format stream-json --verbose --input-format stream-json
//
// and `providers/claude.ts` spawns with three more:
//
//     --permission-prompt-tool stdio  --replay-user-messages
//     --include-partial-messages
//
// So this probe runs the SAME commands under DIFFERENT flag sets and prints the
// message sequence for each. If a flag is the cause, the difference is the
// answer; if none is, the cause is on our side of the pipe and this rules the
// CLI out — which is worth as much.
//
// Usage:
//   node spike/s11/probe-140-slash-flags.cjs <variant> [cmd ...]
//
//   variant: probe | ours | ours-no-ppt | ours-no-partial | ours-no-replay
//
// Kept deliberately small: every turn spends the owner's subscription.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BASE = ['--output-format', 'stream-json', '--verbose', '--input-format', 'stream-json'];
const PPT = ['--permission-prompt-tool', 'stdio'];
const REPLAY = ['--replay-user-messages'];
const PARTIAL = ['--include-partial-messages'];

const VARIANTS = {
  // exactly what spike/s11/probe-local-commands.cjs used, and it WORKED
  probe: BASE,
  // exactly what providers/claude.ts builds for a stream session today
  ours: [...BASE, ...PPT, ...REPLAY, ...PARTIAL],
  // one flag removed at a time from ours
  'ours-no-ppt': [...BASE, ...REPLAY, ...PARTIAL],
  'ours-no-replay': [...BASE, ...PPT, ...PARTIAL],
  'ours-no-partial': [...BASE, ...PPT, ...REPLAY],
};

const variant = process.argv[2] || 'ours';
const args = VARIANTS[variant];
if (!args) {
  console.error(`unknown variant ${variant}; one of: ${Object.keys(VARIANTS).join(', ')}`);
  process.exit(2);
}
const COMMANDS = process.argv.slice(3).length
  ? process.argv.slice(3)
  : ['/usage', 'say the single word OK'];

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-probe-140-'));
fs.mkdirSync(path.join(work, '.claude'), { recursive: true });
fs.writeFileSync(path.join(work, '.claude', 'settings.json'), '{}');

const cli = process.env.SB_CLAUDE || 'claude.cmd';
console.log(`=== variant ${variant} ===`);
console.log('args:', args.join(' '));

const proc = spawn('cmd.exe', ['/c', cli, ...args], {
  cwd: work,
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
  env: { ...process.env },
});

let buf = '';
let idx = -1;
let perCommand = [];
let sawText = false;
const results = [];

function send(text) {
  proc.stdin.write(
    JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
      parent_tool_use_id: null,
      session_id: '',
    }) + '\n'
  );
}

function next() {
  if (idx >= 0) {
    results.push({ command: COMMANDS[idx], messages: perCommand, renderedText: sawText });
  }
  idx += 1;
  if (idx >= COMMANDS.length) return finish();
  perCommand = [];
  sawText = false;
  console.log(`\n--- ${JSON.stringify(COMMANDS[idx])} ---`);
  send(COMMANDS[idx]);
}

proc.stdout.on('data', (d) => {
  buf += d.toString('utf8');
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      console.log('[unparseable]', line.slice(0, 200));
      continue;
    }
    const kind = `${m.type}${m.subtype ? ':' + m.subtype : ''}`;
    // stream_event is high-volume; collapse it but keep its EVENT type, which is
    // the thing #140's assembler is addressed by
    if (m.type === 'stream_event') {
      const t = m.event?.type;
      const last = perCommand[perCommand.length - 1];
      const tag = `stream_event:${t}`;
      if (last !== tag) perCommand.push(tag);
      continue;
    }
    perCommand.push(kind);

    if (m.type === 'assistant') {
      for (const c of m.message?.content ?? []) {
        if (c.type === 'text') {
          sawText = true;
          console.log('  [assistant text]', JSON.stringify(c.text.slice(0, 300)));
        } else {
          console.log('  [assistant block]', c.type, JSON.stringify(c).slice(0, 160));
        }
      }
    } else if (m.type === 'user') {
      console.log('  [user echo]', JSON.stringify(m.message?.content).slice(0, 200));
    } else if (m.type === 'result') {
      console.log('  [result]', m.subtype, 'is_error=' + m.is_error);
      console.log('  [result.result]', JSON.stringify(String(m.result ?? '')).slice(0, 300));
      console.log('  [sequence]', perCommand.join(' -> '));
      setTimeout(next, 1500);
    } else if (m.type === 'system' && m.subtype !== 'init') {
      console.log('  [system]', m.subtype, JSON.stringify(m).slice(0, 250));
    } else if (m.type !== 'system') {
      console.log('  [' + kind + ']', JSON.stringify(m).slice(0, 250));
    }
  }
});
proc.stderr.on('data', (d) => console.log('[stderr]', d.toString().trim().slice(0, 300)));

let done = false;
function finish() {
  if (done) return;
  done = true;
  console.log('\n=== SUMMARY (' + variant + ') ===');
  for (const r of results) {
    console.log(
      `${r.command.padEnd(34)} text=${r.renderedText ? 'YES' : 'no '}  ${r.messages.join(' -> ')}`
    );
  }
  const out = path.join(__dirname, `probe-140-${variant}.json`);
  fs.writeFileSync(out, JSON.stringify({ variant, args, results }, null, 2));
  console.log('wrote', out);
  proc.kill();
  setTimeout(() => process.exit(0), 400);
}

setTimeout(next, 2500);
setTimeout(() => {
  console.log('\n[TIMEOUT — a command never produced a result]');
  console.log('[partial]', COMMANDS[idx], perCommand.join(' -> '));
  finish();
}, 120_000);
