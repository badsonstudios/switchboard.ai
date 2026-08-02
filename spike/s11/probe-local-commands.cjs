// S-11, UNPLANNED PROBE (opened by an owner bug report 2026-08-02).
// WHAT DOES A "LOCAL" SLASH COMMAND EMIT OVER STREAM-JSON?
//
// Symptom: in Direct mode `/usage` produced NOTHING in the session window,
// though the turn plainly completed (the done-sound played). `/startup` (a
// skill) and `/clear` both work, and so do ordinary prompts.
//
// Hypothesis to test, not to assume: `/usage` is drawn by the TUI itself and
// has no conversational output, so over stream-json there is nothing for a host
// to render. If so the fix is never "render it anyway" — under amended P7 a
// decision (or a display) the CLI KEEPS is not ours to fake. The fix is to say
// so honestly.
//
// Prints EVERY message verbatim per command, so the answer is the transcript of
// the run rather than a summary somebody wrote afterwards.
//
// Usage: node spike/s11/probe-local-commands.cjs [cmd ...]
// Default set is the interesting one: a local display, a local display we have
// seen work, a skill, and a plain prompt as the control.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const COMMANDS = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['/usage', '/cost', '/context', 'say the single word OK'];

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-probe-local-'));
fs.mkdirSync(path.join(work, '.claude'), { recursive: true });
fs.writeFileSync(path.join(work, '.claude', 'settings.json'), '{}');

const cli = process.env.SB_CLAUDE || 'claude.cmd';
const args = ['--output-format', 'stream-json', '--verbose', '--input-format', 'stream-json'];
const proc = spawn('cmd.exe', ['/c', cli, ...args], {
  cwd: work,
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true, // every spawn on Windows (S-11 run 1 flashed 96 consoles)
  env: { ...process.env },
});

let buf = '';
let idx = -1;
let perCommand = [];
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
  if (idx >= 0) results.push({ command: COMMANDS[idx], messages: perCommand });
  idx += 1;
  if (idx >= COMMANDS.length) return finish();
  perCommand = [];
  console.log(`\n=== ${JSON.stringify(COMMANDS[idx])} ===`);
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
    perCommand.push(kind);

    // the whole question is "is there anything to render", so print what a host
    // would have to render, and nothing else
    if (m.type === 'assistant') {
      for (const c of m.message?.content ?? []) {
        if (c.type === 'text') console.log('  [assistant text]', JSON.stringify(c.text.slice(0, 400)));
        else console.log('  [assistant block]', c.type, JSON.stringify(c).slice(0, 200));
      }
    } else if (m.type === 'user') {
      console.log('  [user echo]', JSON.stringify(m.message?.content).slice(0, 300));
    } else if (m.type === 'result') {
      console.log('  [result]', m.subtype, 'is_error=' + m.is_error, 'result=' + JSON.stringify(String(m.result ?? '')).slice(0, 400));
      console.log('  [messages this turn]', perCommand.join(' -> '));
      setTimeout(next, 1200);
    } else if (m.type === 'system' && m.subtype !== 'init') {
      console.log('  [system]', m.subtype, JSON.stringify(m).slice(0, 300));
    } else if (m.type !== 'stream_event' && m.type !== 'system') {
      console.log('  [' + kind + ']', JSON.stringify(m).slice(0, 300));
    }
  }
});
proc.stderr.on('data', (d) => console.log('[stderr]', d.toString().trim().slice(0, 400)));

let done = false;
function finish() {
  if (done) return;
  done = true;
  console.log('\n\n=== SUMMARY ===');
  for (const r of results) {
    console.log(`${r.command.padEnd(40)} ${r.messages.join(' -> ')}`);
  }
  const out = path.join(__dirname, 'probe-local-commands.json');
  fs.writeFileSync(out, JSON.stringify(results, null, 2));
  console.log('\nwrote', out);
  proc.kill();
  setTimeout(() => process.exit(0), 500);
}

setTimeout(next, 2000);
setTimeout(() => {
  console.log('\n[TIMEOUT — a command never produced a result]');
  console.log('[partial]', COMMANDS[idx], perCommand.join(' -> '));
  finish();
}, 180_000);
