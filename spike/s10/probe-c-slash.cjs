// Probe 3: in duplex stream-json mode, do slash commands work as user text,
// and does the CLI advertise its command list (system:commands_changed)?
// Also: does interrupt work as a control_request?
const { spawn } = require('child_process');
const fs = require('fs'); const os = require('os'); const path = require('path');

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-probe-slash-'));
fs.mkdirSync(path.join(work, '.claude'), { recursive: true });
fs.writeFileSync(path.join(work, '.claude', 'settings.json'), '{}');

const cli = process.env.SB_CLAUDE || 'claude.cmd';
const args = ['--output-format','stream-json','--verbose','--input-format','stream-json'];
const isCmd = process.platform === 'win32';
const proc = spawn('cmd.exe', ['/c', cli, ...args], {
  cwd: work, stdio: ['pipe','pipe','pipe'], windowsHide: true, env: { ...process.env },
});
let buf = ''; const kinds = new Set(); let cmdCount = null;
function send(o){ proc.stdin.write(JSON.stringify(o)+'\n'); }
proc.stdout.on('data', (d) => {
  buf += d.toString('utf8'); let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0,i).trim(); buf = buf.slice(i+1);
    if (!line) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    kinds.add(`${m.type}${m.subtype?':'+m.subtype:''}`);
    if (m.type==='system' && Array.isArray(m.commands)) {
      cmdCount = m.commands.length;
      console.log('[commands]', m.subtype, cmdCount, 'entries; sample:',
        JSON.stringify(m.commands.slice(0,3)).slice(0,300));
    }
    if (m.type==='system' && m.subtype==='init') {
      console.log('[init] slash_commands field:', Array.isArray(m.slash_commands) ? m.slash_commands.length + ' entries: ' + m.slash_commands.slice(0,12).join(',') : '(absent)');
      console.log('[init] keys:', Object.keys(m).join(','));
    }
    if (m.type==='user') console.log('[user-echo]', JSON.stringify(m.message?.content).slice(0,300));
    if (m.type==='assistant') for (const c of m.message?.content ?? [])
      if (c.type==='text') console.log('[asst]', c.text.slice(0,300).replace(/\n/g,' | '));
    if (m.type==='result') { console.log('[result]', m.subtype, 'err=' + m.is_error, String(m.result||'').slice(0,300)); finish(); }
  }
});
proc.stderr.on('data', d => console.log('[err]', d.toString().trim().slice(0,300)));
let done=false;
function finish(){ if(done) return; done=true;
  console.log('\n[types seen]', [...kinds].join(', '));
  proc.kill(); setTimeout(()=>process.exit(0), 400);
}
setTimeout(() => {
  console.log('--> sending "/cost" as plain user text');
  send({ type:'user', message:{ role:'user', content:[{type:'text',text:'/cost'}] }, parent_tool_use_id:null, session_id:'' });
}, 1500);
setTimeout(()=>{ console.log('[timeout]'); finish(); }, 60_000);
