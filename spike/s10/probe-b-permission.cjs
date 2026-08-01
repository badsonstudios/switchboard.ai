// Probe 2: in duplex stream-json mode, does `--permission-prompt-tool stdio`
// deliver a can_use_tool control_request for the EXACT case that defeated our
// PreToolUse hooks — a write inside .claude/ ? Also records whether the CLI
// still writes a JSONL transcript on disk in this mode.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-probe-perm-'));
fs.mkdirSync(path.join(work, '.claude', 'scripts'), { recursive: true });
// Mirror ClaudeMon: project settings that ALREADY allow bare Write/Edit.
fs.writeFileSync(
  path.join(work, '.claude', 'settings.json'),
  JSON.stringify({ permissions: { allow: ['Write', 'Edit'] } }, null, 2)
);

const cli = process.env.SB_CLAUDE || 'claude.cmd';
const args = [
  '--output-format', 'stream-json',
  '--verbose',
  '--input-format', 'stream-json',
  '--permission-prompt-tool', 'stdio',
];
const isCmd = process.platform === 'win32' && cli.toLowerCase().endsWith('.cmd');
const proc = spawn(isCmd ? 'cmd.exe' : cli, isCmd ? ['/c', cli, ...args] : args, {
  cwd: work, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env },
});

let buf = '';
let sawPerm = false;
let sessionId = null;

function send(o) { proc.stdin.write(JSON.stringify(o) + '\n'); }

proc.stdout.on('data', (d) => {
  buf += d.toString('utf8');
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    if (m.session_id) sessionId = m.session_id;

    if (m.type === 'control_request') {
      console.log('\n=== CONTROL_REQUEST ===');
      console.log(JSON.stringify(m, null, 2).slice(0, 2400));
      const req = m.request || {};
      if (req.subtype === 'can_use_tool') {
        sawPerm = true;
        // Approve it, so we can also confirm the write actually lands.
        send({
          type: 'control_response',
          response: {
            subtype: 'success',
            request_id: m.request_id,
            response: { behavior: 'allow', updatedInput: req.input },
          },
        });
        console.log('--> replied allow');
      } else {
        send({
          type: 'control_response',
          response: { subtype: 'success', request_id: m.request_id, response: {} },
        });
      }
      continue;
    }
    if (m.type === 'assistant') {
      for (const c of m.message?.content ?? []) {
        if (c.type === 'text') console.log('[asst]', c.text.slice(0, 200));
        if (c.type === 'tool_use') console.log('[tool]', c.name, JSON.stringify(c.input).slice(0, 160));
      }
      continue;
    }
    if (m.type === 'transcript_mirror') { console.log('[mirror]', (m.filePath||'').slice(-70), (m.entries||[]).length, 'entries'); continue; }
    if (m.type === 'result') {
      console.log('\n[result]', m.subtype, 'is_error=' + m.is_error);
      finish();
      continue;
    }
    if (m.type === 'system') console.log('[sys]', m.subtype);
  }
});
proc.stderr.on('data', (d) => console.log('[err]', d.toString().trim().slice(0, 300)));

let done = false;
function finish() {
  if (done) return; done = true;
  const target = path.join(work, '.claude', 'scripts', 'coverage.sh');
  console.log('\n--- VERDICT ---');
  console.log('can_use_tool control_request received :', sawPerm);
  console.log('.claude/scripts/coverage.sh written   :', fs.existsSync(target));
  // did the CLI still write a normal JSONL transcript?
  const slug = work.replace(/[:\\/.]/g, '-');
  const projDir = path.join(os.homedir(), '.claude', 'projects');
  let found = [];
  try {
    for (const d of fs.readdirSync(projDir)) {
      if (d.toLowerCase().includes('sb-probe-perm')) {
        for (const f of fs.readdirSync(path.join(projDir, d))) found.push(path.join(d, f));
      }
    }
  } catch {}
  console.log('JSONL transcript on disk             :', found.length ? found.join(', ') : 'NONE');
  console.log('cwd slug guess:', slug.slice(-50));
  proc.kill();
  setTimeout(() => process.exit(0), 500);
}

setTimeout(() => {
  send({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: 'Create the file .claude/scripts/coverage.sh containing exactly: echo hi' }] },
    parent_tool_use_id: null,
    session_id: '',
  });
}, 1500);

setTimeout(() => { console.log('[probe] timeout'); finish(); }, 120_000);
