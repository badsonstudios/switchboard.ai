// S-07: concurrency & perf probe. Spawns SPIKE_N concurrent claude PTY
// sessions (same trusted fixture cwd) + a transcript tailer per session.
// Session 0 renders in a real xterm pane (scrollback capped); sessions 1..N-1
// are "hidden panes" — bytes counted, not rendered (the S6/S7 question is
// whether hidden panes even need data, so measure ingest-only cost).
//
// Phases (auto): spawn -> settle 20s -> IDLE sample 30s -> session 0 streams
// (long counting prompt) -> STREAM sample 45s -> report -> exit.
// Metrics: whole-process-tree CPU%/WorkingSet via PowerShell every 2s,
// renderer event-loop jank via IPC, per-session PTY byte counts.
const { app, BrowserWindow, ipcMain, Menu } = require('electron');
const pty = require('node-pty');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const N = Number(process.env.SPIKE_N || 8);
const CWD = process.env.SPIKE_CWD || 'C:/tmp/s03-project';
const OUT = process.env.SPIKE_OUT || path.resolve(__dirname, '..', '..', '.claude', 'work_files', 's07');
fs.mkdirSync(OUT, { recursive: true });
const log = (s) => {
  fs.appendFileSync(path.join(OUT, `run-n${N}.log`), `${new Date().toISOString()} ${s}\n`);
  console.log(s);
};

const sessions = []; // {p, bytes, exited}
const samples = [];
let jank = { maxDelayMs: 0, samples: 0 };
let phase = 'spawn';

// --- transcript tailers (S-04 pattern, one watcher covering all N) ----------
const projectsRoot = path.join(os.homedir(), '.claude', 'projects');
const tailStats = { files: 0, lines: 0, malformed: 0 };
const knownJsonl = new Set();
function scanJsonl(root, depth = 0, acc = []) {
  if (depth > 4) return acc;
  let names; try { names = fs.readdirSync(root); } catch (_) { return acc; }
  for (const name of names) {
    const full = path.join(root, name);
    let st; try { st = fs.statSync(full); } catch (_) { continue; }
    if (st.isDirectory()) scanJsonl(full, depth + 1, acc);
    else if (name.endsWith('.jsonl')) acc.push(full);
  }
  return acc;
}
for (const f of scanJsonl(projectsRoot)) knownJsonl.add(f);
const tailers = new Map(); // file -> {offset, buf}
setInterval(() => {
  for (const full of scanJsonl(projectsRoot)) {
    if (knownJsonl.has(full) && !tailers.has(full)) continue;
    if (!tailers.has(full)) { tailers.set(full, { offset: 0, buf: '' }); tailStats.files++; }
    const t = tailers.get(full);
    let st; try { st = fs.statSync(full); } catch (_) { continue; }
    if (st.size <= t.offset) continue;
    const fd = fs.openSync(full, 'r');
    const chunk = Buffer.alloc(st.size - t.offset);
    fs.readSync(fd, chunk, 0, chunk.length, t.offset);
    fs.closeSync(fd);
    t.offset = st.size; t.buf += chunk.toString('utf8');
    let nl;
    while ((nl = t.buf.indexOf('\n')) >= 0) {
      const line = t.buf.slice(0, nl); t.buf = t.buf.slice(nl + 1);
      if (!line.trim()) continue;
      tailStats.lines++;
      try { JSON.parse(line); } catch (_) { tailStats.malformed++; }
    }
  }
}, 100);

// --- process-tree sampler (PowerShell) --------------------------------------
function sampleTree(cb) {
  const ps = `
$root=${process.pid}
$all=Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,WorkingSetSize
$tree=@($root); $added=$true
while($added){ $added=$false
  foreach($p in $all){ if($tree -contains $p.ParentProcessId -and -not ($tree -contains $p.ProcessId)){ $tree+=$p.ProcessId; $added=$true } } }
$procs=Get-Process -Id $tree -ErrorAction SilentlyContinue | Select-Object Id,ProcessName,CPU,WorkingSet64
$procs | ConvertTo-Json -Compress`;
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { maxBuffer: 10e6 }, (err, stdout) => {
    if (err) return cb(null);
    try { const j = JSON.parse(stdout); cb(Array.isArray(j) ? j : [j]); } catch (_) { cb(null); }
  });
}

let lastSample = null;
function takeSample(tag) {
  sampleTree((procs) => {
    if (!procs) return;
    const now = Date.now();
    const totCpu = procs.reduce((a, p) => a + (p.CPU || 0), 0);
    const totWs = procs.reduce((a, p) => a + (p.WorkingSet64 || 0), 0);
    const claudeProcs = procs.filter((p) => /node|claude/i.test(p.ProcessName));
    const s = {
      at: new Date().toISOString(), tag, phase, nProcs: procs.length,
      totalCpuSeconds: totCpu, totalWorkingSetMB: Math.round(totWs / 1048576),
      claudeCount: claudeProcs.length,
      cpuPctSinceLast: lastSample ? Math.round(((totCpu - lastSample.cpu) / ((now - lastSample.at) / 1000)) * 1000) / 10 : null,
      bytesTotal: sessions.reduce((a, x) => a + x.bytes, 0),
    };
    lastSample = { at: now, cpu: totCpu };
    samples.push(s);
    log(`SAMPLE ${JSON.stringify(s)}`);
  });
}

// --- spawn sessions ----------------------------------------------------------
function spawnSession(i, win) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const p = pty.spawn('claude.cmd', [], {
    name: 'xterm-256color', cols: 120, rows: 30, cwd: CWD, env, useConpty: true,
  });
  const s = { p, bytes: 0, exited: null };
  p.onData((d) => {
    s.bytes += Buffer.byteLength(d, 'utf8');
    if (i === 0 && win && !win.isDestroyed()) win.webContents.send('pty:data', d);
  });
  p.onExit(({ exitCode }) => { s.exited = exitCode; log(`session ${i} exited code=${exitCode}`); });
  sessions.push(s);
  log(`session ${i} spawned pid=${p.pid}`);
  return s;
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  const win = new BrowserWindow({
    width: 1100, height: 700, backgroundColor: '#1e1e1e', show: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  win.loadFile(path.join(__dirname, 'renderer.html'));
  ipcMain.on('jank', (_e, j) => { jank = j; });
  ipcMain.on('pty:input', (_e, data) => { try { sessions[0] && sessions[0].p.write(data); } catch (_) {} });

  win.webContents.on('did-finish-load', () => {
    win.setTitle(`S-07 probe N=${N}`);
    // staggered spawn: 400ms apart to avoid a thundering herd at startup
    for (let i = 0; i < N; i++) setTimeout(() => spawnSession(i, win), i * 400);

    const spawnDoneMs = N * 400 + 1000;
    setTimeout(() => { phase = 'settle'; log('PHASE settle'); }, spawnDoneMs);
    setTimeout(() => { phase = 'idle'; log('PHASE idle'); takeSample('idle-start'); }, spawnDoneMs + 20000);
    const idleEnd = spawnDoneMs + 20000 + 30000;
    const sampler = setInterval(() => takeSample('tick'), 2000);
    setTimeout(() => {
      phase = 'stream'; log('PHASE stream');
      // session 0 does real streaming work
      try {
        sessions[0].p.write('Count from 1 to 400, one number per line, no commentary.');
        setTimeout(() => sessions[0].p.write('\r'), 900);
      } catch (_) {}
    }, idleEnd);
    setTimeout(() => {
      clearInterval(sampler);
      phase = 'report';
      const idle = samples.filter((s) => s.phase === 'idle' && s.cpuPctSinceLast != null);
      const stream = samples.filter((s) => s.phase === 'stream' && s.cpuPctSinceLast != null);
      const avg = (a, f) => (a.length ? Math.round((a.reduce((x, y) => x + f(y), 0) / a.length) * 10) / 10 : null);
      const report = {
        n: N, cwd: CWD, machine: { cpus: os.cpus().length, totalMemMB: Math.round(os.totalmem() / 1048576) },
        idle: { avgCpuPct: avg(idle, (s) => s.cpuPctSinceLast), avgWorkingSetMB: avg(idle, (s) => s.totalWorkingSetMB), samples: idle.length },
        stream: { avgCpuPct: avg(stream, (s) => s.cpuPctSinceLast), maxCpuPct: Math.max(...stream.map((s) => s.cpuPctSinceLast), 0), avgWorkingSetMB: avg(stream, (s) => s.totalWorkingSetMB), samples: stream.length },
        perSessionIdleMB: idle.length ? Math.round((avg(idle, (s) => s.totalWorkingSetMB) / N) * 10) / 10 : null,
        rendererJank: jank,
        tailers: tailStats,
        sessions: sessions.map((s, i) => ({ i, bytes: s.bytes, exited: s.exited })),
        samples,
      };
      fs.writeFileSync(path.join(OUT, `report-n${N}.json`), JSON.stringify(report, null, 2));
      log(`REPORT written report-n${N}.json`);
      for (const s of sessions) { try { s.p.kill(); } catch (_) {} }
      setTimeout(() => app.exit(0), 2000);
    }, idleEnd + 45000);
  });
});
app.on('window-all-closed', () => app.quit());
