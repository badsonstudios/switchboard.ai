// S-09 run B — THE QUESTION. Drive a REAL INTERACTIVE `claude` in a PTY (the
// way switchboard hosts it) with `--permission-prompt-tool` pointed at our MCP
// server, and see which of two things happens when it needs permission:
//
//   (1) our MCP tool is called  -> switchboard can own every permission prompt,
//       including the `.claude/**` writes hooks never see, WITHOUT giving up
//       the real terminal. This is the outcome that saves the architecture.
//   (2) the TUI prints its own "Do you want to create …?" prompt -> the flag is
//       print/stream-json only, and the only way to get extension-quality
//       prompts is the extension's own trade: no terminal.
//
// Run A (run-print.cjs) is the control and must pass first, otherwise a silent
// tool here means nothing.
const fs = require('fs');
const os = require('os');
const path = require('path');
const pty = require('node-pty');

const LOG = path.join(__dirname, 'perm-calls.log');
try { fs.unlinkSync(LOG); } catch { /* first run */ }

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-s09-tui-'));
fs.mkdirSync(path.join(work, '.claude', 'scripts'), { recursive: true });
fs.writeFileSync(path.join(work, '.claude', 'settings.json'), JSON.stringify({}, null, 2));

// Pre-accept the trust dialog exactly as switchboard's auto-trust does
// (sessions/trust.ts): a fresh temp folder is untrusted, so the CLI opens its
// trust dialog FIRST and swallows everything we type into it — which is what
// actually happened on runs 1-4 and looked like "the flag did nothing".
// Merge + atomic write + cleanup, because this is Dan's real config file.
const CLAUDE_JSON = path.join(os.homedir(), '.claude.json');
const projectKey = work.replace(/\\/g, '/').replace(/\/+$/, '');
function trustWorkFolder() {
  const cfg = JSON.parse(fs.readFileSync(CLAUDE_JSON, 'utf8'));
  cfg.projects = cfg.projects || {};
  cfg.projects[projectKey] = { ...(cfg.projects[projectKey] || {}), hasTrustDialogAccepted: true };
  const tmp = `${CLAUDE_JSON}.s09tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  fs.renameSync(tmp, CLAUDE_JSON);
}
function untrustWorkFolder() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CLAUDE_JSON, 'utf8'));
    if (cfg.projects) delete cfg.projects[projectKey];
    const tmp = `${CLAUDE_JSON}.s09tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
    fs.renameSync(tmp, CLAUDE_JSON);
  } catch { /* leaving one temp key behind is not worth failing the spike */ }
}
trustWorkFolder();

const server = path.join(__dirname, 'perm-mcp-server.cjs');
const mcpConfig = JSON.stringify({
  mcpServers: { sbperm: { command: process.execPath, args: [server] } },
});

const cli = process.env.SB_CLAUDE || 'claude.cmd';
const args = [
  '--mcp-config', mcpConfig,
  '--strict-mcp-config',
  '--permission-prompt-tool', 'mcp__sbperm__approve',
];

// The S-01 landmine set: Electron's own env vars leak into a hosted CLI and
// make it misbehave. Not strictly needed under plain node, but this is the
// same shape switchboard spawns with.
const env = { ...process.env, SB_PERM_LOG: LOG };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_NO_ATTACH_CONSOLE;
// This spike is itself run FROM a Claude Code session, and the CLI stamps its
// environment with markers a child CLI then inherits — the first run showed
// "Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker" and
// came up in manual mode, i.e. we were measuring a crippled session. Scrub
// every one of them (the S-01 env-landmine finding, in a new costume).
for (const k of Object.keys(env)) {
  if (/^CLAUDE(CODE|_)/i.test(k) || k === 'CLAUDECODE') delete env[k];
}

console.log('[s09-tui] cwd :', work);
console.log('[s09-tui] spawning INTERACTIVE claude (no -p) in a PTY…');

// Spawn the CLI DIRECTLY with ConPTY, exactly as PtyService does — not via
// `cmd.exe /c`. The cmd wrapper starts the TUI fine but swallows the keystrokes
// we write back, which is why the first three runs looked like "the flag did
// nothing" when in fact the prompt never arrived.
const p = pty.spawn(cli, args, {
  name: 'xterm-256color',
  cols: 120,
  rows: 34,
  cwd: work,
  env,
  useConpty: process.platform === 'win32',
});

// The TUI is 120x34 of redraws; dumping it to stdout buries our own findings.
// Keep it all, on disk, and print only what we learn.
const TUI_LOG = path.join(__dirname, 'tui-output.log');
let out = '';
p.onData((d) => {
  out += d;
  fs.appendFileSync(TUI_LOG, d);
});
try { fs.unlinkSync(TUI_LOG); } catch { /* first run */ }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // Wait for the composer to actually exist rather than guessing at a delay —
  // the first run typed into a TUI that was still drawing its welcome box, so
  // the prompt went nowhere and the run measured nothing.
  const ready = async () => {
    for (let i = 0; i < 60; i++) {
      if (/Try "|for shortcuts|❯/.test(out)) return true;
      await sleep(500);
    }
    return false;
  };
  if (!(await ready())) console.log('[s09-tui] WARNING: composer never appeared');
  await sleep(3_000); // let the first paint settle

  // Exactly what switchboard's composer does (renderer/lib/composer.ts): a
  // SINGLE-LINE prompt goes as plain text — bracketed paste is only for
  // multiline — and the Enter is a SEPARATE, delayed write, because text+CR in
  // one chunk registers as a paste and never submits (the S-03 finding). My
  // first two runs pasted a single line and it went nowhere.
  const prompt = 'Create a file .claude/scripts/coverage.sh containing exactly: echo hi';
  const before = out.length;
  p.write(prompt);
  await sleep(1_500);
  // Confirm the text actually reached the composer before pressing Enter —
  // otherwise a silent result is indistinguishable from a silent flag.
  const echoed = /coverage\.sh/.test(out.slice(before));
  console.log('[s09-tui] prompt reached the composer:', echoed);
  p.write('\r');

  // give it time to think, call the tool, and either ask us or ask the TUI
  await sleep(60_000);

  const calls = fs.existsSync(LOG)
    ? fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : [];
  const perms = calls.filter((c) => c.kind === 'PERMISSION_REQUEST');
  const started = calls.filter((c) => c.kind === 'server-start');
  const listed = calls.filter((c) => c.kind === 'rpc' && c.payload?.method === 'tools/list');

  // Did the CLI put its OWN prompt on screen? That is the negative signal.
  const tuiAsked = /Do you want to (create|make|write)|❯\s*1\.\s*Yes/i.test(out);
  const wrote = fs.existsSync(path.join(work, '.claude', 'scripts', 'coverage.sh'));

  console.log('\n\n================ S-09 RESULT ================');
  console.log('MCP server started              :', started.length > 0);
  console.log('CLI listed our tools            :', listed.length > 0);
  console.log('PERMISSION REQUESTS to our tool :', perms.length);
  for (const x of perms) console.log('   →', JSON.stringify(x.payload).slice(0, 700));
  console.log('TUI showed its OWN prompt       :', tuiAsked);
  console.log('.claude/scripts/coverage.sh made:', wrote);
  console.log('---------------------------------------------');
  if (perms.length > 0) {
    console.log('VERDICT: YES — --permission-prompt-tool FIRES IN INTERACTIVE MODE.');
    console.log('switchboard can own every permission prompt and KEEP the terminal.');
  } else if (tuiAsked) {
    console.log('VERDICT: NO — the flag was ignored; the TUI asked instead.');
    console.log('Extension-quality prompts would require the extension trade (no terminal).');
  } else {
    console.log('VERDICT: INCONCLUSIVE — no tool call and no visible TUI prompt.');
    console.log('Check the transcript above: it may not have needed permission at all.');
  }
  console.log('=============================================');
  console.log('work dir kept for inspection:', work);

  try { p.kill(); } catch { /* already gone */ }
  untrustWorkFolder(); // never leave temp-folder keys in Dan's real config
  process.exit(0);
})();
