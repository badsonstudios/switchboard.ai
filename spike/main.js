// Spike 01 — S-01: PTY-host the real claude CLI under ConPTY.
// Throwaway harness. Findings: spike/findings/s-01-pty-host.md
const { app, BrowserWindow, ipcMain, Menu } = require('electron');
const pty = require('node-pty');
const path = require('path');
const fs = require('fs');

const SMOKE = process.argv.includes('--smoke');
const SMOKE_SECONDS = 20;

// cwd for the hosted session: SPIKE_CWD env wins, else a scratch test project.
function resolveSessionCwd() {
  if (process.env.SPIKE_CWD) return process.env.SPIKE_CWD;
  const dir = path.resolve(__dirname, '..', '.claude', 'work_files', 'test-project');
  fs.mkdirSync(dir, { recursive: true });
  const readme = path.join(dir, 'README.md');
  if (!fs.existsSync(readme)) {
    fs.writeFileSync(readme, '# spike test project\n\nScratch project for the S-01 PTY harness.\n');
  }
  return dir;
}

// Spawn strategy probe (a finding in itself): try the npm .cmd shim directly,
// fall back to cmd.exe /c. CLAUDE_CMD env overrides everything.
function spawnClaude(cols, rows, cwd) {
  const opts = {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env: process.env,
    useConpty: true,
  };
  const attempts = process.env.CLAUDE_CMD
    ? [{ label: 'CLAUDE_CMD override', file: process.env.CLAUDE_CMD, args: [] }]
    : [
        { label: 'direct claude.cmd', file: 'claude.cmd', args: [] },
        { label: 'cmd.exe /c claude', file: 'cmd.exe', args: ['/c', 'claude'] },
      ];
  for (const a of attempts) {
    try {
      const p = pty.spawn(a.file, a.args, opts);
      console.log(`[spike] spawn OK via: ${a.label} (pid ${p.pid})`);
      return p;
    } catch (err) {
      console.log(`[spike] spawn FAILED via: ${a.label} — ${err.message}`);
    }
  }
  throw new Error('all spawn strategies failed');
}

function runSmoke() {
  // No window: just prove ConPTY spawn + output flow, then exit.
  // A child that exits during the smoke window is a FAIL — e.g. the cmd.exe
  // fallback "spawns OK" and prints an error even when claude isn't on PATH.
  const cwd = resolveSessionCwd();
  console.log(`[smoke] cwd=${cwd}`);
  let bytes = 0;
  let chunks = 0;
  let firstByteMs = -1;
  let head = '';
  let exited = null;
  let done = false;
  const t0 = Date.now();
  let child;
  try {
    child = spawnClaude(120, 30, cwd);
  } catch (err) {
    console.error(`[smoke] FAIL: ${err.message}`);
    app.exit(1);
    return;
  }
  const finish = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    console.log(`[smoke] first output after ${firstByteMs} ms; ${bytes} bytes in ${chunks} chunks`);
    if (head) console.log(`[smoke] output head: ${JSON.stringify(head.slice(0, 200))}`);
    if (exited) console.log(`[smoke] child exited during smoke window (code ${exited.exitCode})`);
    const ok = firstByteMs >= 0 && bytes > 0 && !exited;
    console.log(ok ? '[smoke] PASS' : '[smoke] FAIL');
    try { child.kill(); } catch (_) {}
    app.exit(ok ? 0 : 1);
  };
  child.onData((d) => {
    if (firstByteMs < 0) firstByteMs = Date.now() - t0;
    bytes += Buffer.byteLength(d, 'utf8');
    chunks += 1;
    if (head.length < 200) head += d;
  });
  child.onExit(({ exitCode }) => { exited = { exitCode }; finish(); });
  const timer = setTimeout(finish, SMOKE_SECONDS * 1000);
}

function runWindow() {
  const cwd = resolveSessionCwd();
  // No menu: the default one ships Ctrl+R reload, which blanks the xterm and
  // desyncs it from the live PTY — indistinguishable from real TUI corruption.
  Menu.setApplicationMenu(null);
  const win = new BrowserWindow({
    width: 1100,
    height: 750,
    backgroundColor: '#1e1e1e',
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });

  let child = null;

  // Renderer announces its initial size; spawn then so cols/rows match.
  ipcMain.once('pty:ready', (_e, { cols, rows }) => {
    child = spawnClaude(cols, rows, cwd);
    child.onData((d) => {
      if (!win.isDestroyed()) win.webContents.send('pty:data', d);
    });
    child.onExit(({ exitCode }) => {
      child = null; // dead PTY: writes after exit would raise async socket errors
      if (!win.isDestroyed()) {
        win.webContents.send('pty:data', `\r\n[spike] claude exited (code ${exitCode})\r\n`);
      }
    });
  });

  ipcMain.on('pty:input', (_e, data) => {
    if (child) { try { child.write(data); } catch (_) {} }
  });
  ipcMain.on('pty:resize', (_e, { cols, rows }) => {
    if (child && cols > 0 && rows > 0) { try { child.resize(cols, rows); } catch (_) {} }
  });

  win.on('closed', () => { if (child) { try { child.kill(); } catch (_) {} } });

  // Surface renderer console on stdout (headless-ish debugging of the
  // harness). Electron ≥32 passes a details object; older passed positionals.
  win.webContents.on('console-message', (evt, level, message) => {
    const msg = message !== undefined ? message : evt.message;
    const lvl = message !== undefined ? level : evt.level;
    console.log(`[renderer:${lvl}] ${msg}`);
  });

  // SPIKE_AUTOCLOSE=<seconds>: self-close for scripted checks.
  const autoclose = Number(process.env.SPIKE_AUTOCLOSE);
  if (Number.isFinite(autoclose) && autoclose > 0) {
    setTimeout(() => { if (!win.isDestroyed()) win.close(); }, autoclose * 1000);
  }

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.on('did-finish-load', () => {
    win.setTitle(`spike S-01 — claude @ ${cwd}`);
  });
}

app.whenReady().then(() => (SMOKE ? runSmoke() : runWindow()));
app.on('window-all-closed', () => app.quit());
