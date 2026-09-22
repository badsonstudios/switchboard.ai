// #719 — does killing a stream session strand the CLI's MCP servers?
//
// Launches the REAL `claude` exactly the way StreamSession does on Windows
// (`cmd.exe /c claude.cmd <stream flags>`), with one stdio MCP server. Once the
// server's process tree is up, ends the session one of two ways and counts
// survivors among EVERY process that was below cmd.exe at the moment of the kill:
//
//   node probe.cjs launcher [server]  — `proc.kill()`, StreamSession.kill() today
//   node probe.cjs tree     [server]  — `taskkill /pid <cmd> /T /F`, kill-tree.ts
//   node probe.cjs eof      [server]  — close stdin only: does the CLI exit by itself, how fast?
//   node probe.cjs eof-midturn        — the same, but mid-answer (one small haiku turn)
//   node probe.cjs giveup   [server]  — MCP_TIMEOUT=3000 and NO kill for 20 s: does
//     the CLI's own give-up on a slow server orphan it while the session lives?
//     Then a tree kill, to show what a tree kill can and cannot still reach.
//
// server:
//   stand-in  (default) node wrapper → node server, an npx-shaped pair
//   npx       the real `npx -y @azure/mcp@latest server start`
//   slow      stand-in whose wrapper waits 10 s before starting the server,
//             i.e. a slow npx; pair it with `early`
//   slow-cmd  the same behind `cmd /c` — the cmd.exe layer real npx has on Windows
//   npx-fresh real npx against an EMPTY per-run npm cache, so it must download
//             before it can start anything — a genuinely slow npx; use `early`
//   azure-fresh the laptop's actual leaker, @azure/mcp, from an EMPTY cache
//   npx-cmd   the same behind `cmd /c`, the form Windows MCP docs recommend
//
// A third argument `early` kills mid-startup instead of once the server is up.
//
// Every survivor is killed before exit, so the probe leaves nothing behind.
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const mode = process.argv[2];
const server = process.argv[3] ?? 'stand-in';
// early: kill the moment npx's node exists, i.e. mid-startup, before the real
// server is spawned — the window the first run happened to land in.
const early = process.argv[4] === 'early';
if (!['launcher', 'tree', 'giveup', 'eof', 'eof-midturn'].includes(mode) || !['stand-in', 'slow', 'slow-cmd', 'npx', 'npx-fresh', 'azure-fresh', 'npx-cmd'].includes(server)) {
  console.error('usage: node probe.cjs launcher|tree [stand-in|npx|npx-cmd]');
  process.exit(2);
}

const out = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-719-kill-'));
const azure = ['-y', '@azure/mcp@latest', 'server', 'start'];
const serverSpec = {
  'stand-in': { command: process.execPath, args: [path.join(__dirname, 'npx-like-wrapper.cjs')], env: { PROBE_OUT: out } },
  slow: { command: process.execPath, args: [path.join(__dirname, 'npx-like-wrapper.cjs')], env: { PROBE_OUT: out, PROBE_DELAY_MS: '10000' } },
  'slow-cmd': { command: 'cmd', args: ['/c', process.execPath, path.join(__dirname, 'npx-like-wrapper.cjs')], env: { PROBE_OUT: out, PROBE_DELAY_MS: '10000' } },
  npx: { command: 'npx', args: azure },
  'azure-fresh': { command: 'npx', args: azure, env: { npm_config_cache: path.join(out, 'npm-cache') } },
  'npx-fresh': { command: 'npx', args: ['-y', '@modelcontextprotocol/server-everything'], env: { npm_config_cache: path.join(out, 'npm-cache') } },
  'npx-cmd': { command: 'cmd', args: ['/c', 'npx', ...azure] },
}[server];
const mcpConfig = path.join(out, 'mcp.json');
fs.writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { probe: serverSpec } }));

const claudeCmd = execFileSync('where', ['claude.cmd'], { encoding: 'utf8' }).split(/\r?\n/)[0].trim();
const proc = spawn(
  'cmd.exe',
  [
    '/c', claudeCmd,
    '--output-format', 'stream-json', '--verbose',
    '--input-format', 'stream-json',
    '--permission-prompt-tool', 'stdio',
    '--mcp-config', mcpConfig, '--strict-mcp-config',
    ...(mode === 'eof-midturn' ? ['--model', 'haiku', '--include-partial-messages'] : []),
  ],
  { cwd: out, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PROBE_OUT: out, ...(mode === 'giveup' ? { MCP_TIMEOUT: '3000' } : {}) }, windowsHide: true }
);
proc.stdout.resume();
proc.stderr.on('data', (d) => process.stderr.write(`[claude stderr] ${d}`));

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
/** Every process below `root`, from one Win32_Process snapshot. */
const descendants = (root) => {
  const txt = execFileSync(
    'powershell.exe',
    ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)|$($_.ParentProcessId)|$($_.Name)|$($_.CommandLine)" }'],
    { encoding: 'utf8', maxBuffer: 64 << 20 }
  );
  const rows = txt.split(/\r?\n/).filter(Boolean).map((l) => {
    const [pid, ppid, name, ...cmd] = l.split('|');
    return { pid: Number(pid), ppid: Number(ppid), name, cmd: cmd.join('|') };
  });
  const found = [];
  const walk = (p, depth) => {
    for (const r of rows.filter((x) => x.ppid === p)) {
      found.push({ ...r, depth });
      walk(r.pid, depth + 1);
    }
  };
  walk(root, 1);
  return found;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // Up = at least two processes below claude.exe (wrapper + server). Poll the
  // tree rather than trusting a timer: npx resolution time varies wildly.
  const t0 = Date.now();
  let tree = [];
  for (;;) {
    tree = descendants(proc.pid);
    const cli = tree.find((t) => /^claude\.exe$/i.test(t.name));
    const below = cli ? tree.filter((t) => t.depth > cli.depth && !/^conhost\.exe$/i.test(t.name)) : [];
    if (early ? below.some((t) => /npx-cli|npx-like-wrapper/.test(t.cmd)) : below.length >= 2) break;
    if (Date.now() - t0 > 90_000) {
      console.log('MCP server tree never appeared within 90 s — probe inconclusive');
      for (const t of tree) console.log(`  ${'  '.repeat(t.depth)}${t.name} ${t.pid}`);
      execFileSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
      process.exit(3);
    }
    await sleep(1000);
  }
  if (!early) await sleep(3000); // let the handshake settle
  tree = descendants(proc.pid);
  console.log(`server=${server} mode=${mode}; tree at the moment of the kill:`);
  console.log(`  cmd.exe ${proc.pid}`);
  for (const t of tree) console.log(`  ${'  '.repeat(t.depth)}${t.name} ${t.pid}  ${t.cmd.slice(0, 90)}`);

  if (mode === 'giveup') {
    await sleep(20000);
    const cliAlive = tree.filter((t) => /^claude.exe$/i.test(t.name)).every((t) => alive(t.pid));
    const now = descendants(proc.pid).map((t) => t.pid);
    console.log(`after 20 s, session still alive: ${cliAlive}`);
    for (const f of fs.readdirSync(out).filter((n) => /^(wrapper|server)-/.test(n))) {
      const pid = Number(fs.readFileSync(path.join(out, f), 'utf8'));
      console.log(`  ${f}: alive=${alive(pid)} stillInSessionTree=${now.includes(pid)}`);
    }
  }
  if (mode === 'eof-midturn') {
    let text = 0;
    proc.stdout.on('data', (d) => (text += (String(d).match(/text_delta/g) ?? []).length));
    proc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: 'Count from 1 to 400 in words, one per line. No tools.' } }) + String.fromCharCode(10));
    while (text < 5) await sleep(50);
    const tEof = Date.now();
    const atEof = text;
    proc.on('exit', (c) => console.log(`mid-turn: cmd.exe exited ${Date.now() - tEof} ms after stdin closed, code ${c}; text deltas after EOF: ${text - atEof}`));
    proc.stdin.end();
  }
  if (mode === 'eof') {
    const tEof = Date.now();
    proc.on('exit', (c) => console.log(`cmd.exe exited ${Date.now() - tEof} ms after stdin closed, code ${c}`));
    proc.stdin.end();
  }
  if (mode === 'launcher') proc.kill();
  else execFileSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });

  // 15 s: past the slow wrapper's 10 s delay, so a stranded wrapper has had
  // time to start the server it was always going to start.
  await sleep(15000);
  // Plus any server that came up AFTER the kill — its pid file is the only
  // record, since it was not in the tree when it was snapshotted.
  for (const f of fs.readdirSync(out).filter((n) => n.startsWith('server-'))) {
    const pid = Number(fs.readFileSync(path.join(out, f), 'utf8'));
    if (!tree.some((t) => t.pid === pid)) tree.push({ pid, name: 'mcp server (started after the kill)', cmd: '' });
  }
  const survivors = tree.filter((t) => alive(t.pid));
  console.log(`RESULT server=${server} mode=${mode}: ${survivors.length}/${tree.length} survived 15 s after the kill`);
  for (const s of survivors) console.log(`  SURVIVOR ${s.name} ${s.pid}  ${s.cmd.slice(0, 90)}`);
  for (const s of survivors) {
    try {
      process.kill(s.pid);
    } catch {
      /* gone */
    }
  }
  process.exit(0);
})();
