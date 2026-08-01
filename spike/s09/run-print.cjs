// S-09 run A — the CONTROL. Drive `claude -p` (print mode) with
// `--permission-prompt-tool` pointed at our MCP server. Print mode is where the
// flag is known to work, so if the tool does NOT fire here, the problem is our
// server or our wiring — not interactive mode. Establish that before drawing
// any conclusion from run B.
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const LOG = path.join(__dirname, 'perm-calls.log');
try { fs.unlinkSync(LOG); } catch { /* first run */ }

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-s09-print-'));
fs.mkdirSync(path.join(work, '.claude', 'scripts'), { recursive: true });
// A trusted folder, so the trust dialog never enters the picture.
fs.writeFileSync(path.join(work, '.claude', 'settings.json'), JSON.stringify({}, null, 2));

const server = path.join(__dirname, 'perm-mcp-server.cjs');
const mcpConfig = JSON.stringify({
  mcpServers: { sbperm: { command: process.execPath, args: [server] } },
});

const cli = process.env.SB_CLAUDE || 'claude';
const isCmd = process.platform === 'win32' && cli.toLowerCase().endsWith('.cmd');

const args = [
  '-p',
  'Create a file .claude/scripts/coverage.sh containing exactly: echo hi',
  '--mcp-config', mcpConfig,
  '--strict-mcp-config',
  '--permission-prompt-tool', 'mcp__sbperm__approve',
];

console.log('[s09-print] cwd     :', work);
console.log('[s09-print] flag    : --permission-prompt-tool mcp__sbperm__approve');

let out = '';
let failed = null;
try {
  out = execFileSync(isCmd ? 'cmd.exe' : cli, [...(isCmd ? ['/c', cli] : []), ...args], {
    cwd: work,
    encoding: 'utf8',
    timeout: 180_000,
    env: { ...process.env, SB_PERM_LOG: LOG },
  });
} catch (err) {
  failed = err;
  out = `${err.stdout || ''}${err.stderr || ''}`;
}

console.log('[s09-print] CLI said:', out.trim().slice(0, 600) || '(nothing)');
if (failed) console.log('[s09-print] exit    :', failed.status, failed.message.slice(0, 200));

const calls = fs.existsSync(LOG)
  ? fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  : [];
const perms = calls.filter((c) => c.kind === 'PERMISSION_REQUEST');
console.log('[s09-print] server saw', calls.length, 'messages,', perms.length, 'permission request(s)');
for (const p of perms) console.log('  →', JSON.stringify(p.payload).slice(0, 700));

const wrote = fs.existsSync(path.join(work, '.claude', 'scripts', 'coverage.sh'));
console.log('[s09-print] .claude/scripts/coverage.sh created:', wrote);
console.log(
  perms.length > 0
    ? '[s09-print] CONTROL PASSES — the wiring works; run B is a fair test'
    : '[s09-print] CONTROL FAILS — fix the server/wiring before trusting run B'
);
