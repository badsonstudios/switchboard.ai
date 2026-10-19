// #756 probe: which Electron calls can take the Windows foreground from
// ANOTHER process that holds it, and which only flash the taskbar?
//
// Run (under the e2e lock — it takes the foreground by design):
//   node_modules/electron/dist/electron.exe spike/probes/756/probe.cjs [--idle]
//
// A bare BrowserWindow — no app, no CLI, no fake provider needed. A separate
// PowerShell process (holder.ps1) stands in for "the app you are typing in":
// before every attempt it is handed the foreground and given one Shift tap
// (so it, not us, received the last input), and covers our window. Then one
// technique runs, and 700 ms later the OS is asked who holds the foreground
// and whose window is on top at our window's centre.
//
// --idle adds one run per technique family after 205 s of no probe input, to
// see Windows' ForegroundLockTimeout (default 200 000 ms) release the lock.
'use strict';
const { app, BrowserWindow, screen } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const IDLE = process.argv.includes('--idle');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startHelper() {
  const ps = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'helper.ps1')], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  let buf = '';
  const waiters = [];
  ps.stdout.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      const w = waiters.shift();
      if (w) w(line);
    }
  });
  const next = () => new Promise((r) => waiters.push(r));
  const ready = next();
  return {
    ready,
    ask: (cmd) => {
      const p = next();
      ps.stdin.write(cmd + '\n');
      return p;
    },
    kill: () => ps.kill(),
  };
}

const TECHNIQUES = [
  // [name, start state, fn]
  ['focus()', 'behind', (w) => w.focus()],
  ['show()+focus()  (raiseWindow, normal path)', 'behind', (w) => { w.show(); w.focus(); }],
  ['restore()+show()+focus()  (raiseWindow on a minimized window)', 'minimized', (w) => { w.restore(); w.show(); w.focus(); }],
  ['focus() on a minimized window', 'minimized', (w) => w.focus()],
  ['app.focus({ steal: true })', 'behind', () => app.focus({ steal: true })],
  ['moveTop()+focus()', 'behind', (w) => { w.moveTop(); w.focus(); }],
  ['setAlwaysOnTop(true)+show()+focus()+setAlwaysOnTop(false)', 'behind', (w) => { w.setAlwaysOnTop(true); w.show(); w.focus(); w.setAlwaysOnTop(false); }],
  ['minimize()+restore()', 'behind', (w) => { w.minimize(); w.restore(); }],
  ['webContents.focus()', 'behind', (w) => w.webContents.focus()],
  ['minimize(), 400 ms, restore()', 'behind', async (w) => { w.minimize(); await sleep(400); w.restore(); }],
  ['hide()+show()', 'behind', (w) => { w.hide(); w.show(); }],
  ['restore() alone on a minimized window', 'minimized', (w) => w.restore()],
  ['showInactive()  (the quiet e2e path)', 'minimized', (w) => w.showInactive()],
  // added after review: a MAXIMIZED window's swoop (does it come back maximized?)
  ['minimize()+restore() on a maximized window', 'maximized-behind', (w) => { w.minimize(); w.restore(); }],
  // ...and our OWN app in front (a sibling window of ours holds the foreground):
  // may the plain raise move between our windows?
  ['show()+focus() while a sibling window of OURS is in front', 'sibling-front', (w) => { w.show(); w.focus(); }],
];

async function main() {
  await app.whenReady();
  const holder = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'holder.ps1')], { stdio: 'ignore' });
  const helper = startHelper();
  await helper.ready;
  const win = new BrowserWindow({ x: 120, y: 120, width: 420, height: 300, title: 'probe-756-target', show: true });
  win.loadURL('data:text/html,<title>probe-756-target</title><body style="background:%23c33;color:white;font:20px sans-serif">probe 756 target</body>');
  await sleep(2500); // holder up, window painted
  const b = win.getBounds();
  const centre = screen.dipToScreenPoint({ x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) });
  const me = String(process.pid);
  const rows = [];
  // the TARGET by title: a sibling window shares our pid
  const isTarget = (fg) => fg.startsWith(me + '|') && fg.endsWith('|probe-756-target');
  let sibling = null;

  const attempt = async (name, state, fn, idleMs) => {
    // the holder takes the foreground FIRST, then our window is put in the
    // start state, so a minimize never happens while we are in front
    if (win.isMinimized()) win.restore();
    if (state === 'maximized-behind') win.maximize();
    if (state === 'sibling-front' && !sibling) {
      sibling = new BrowserWindow({ x: 60, y: 60, width: 700, height: 500, title: 'probe-756-sibling', show: true });
      sibling.loadURL('data:text/html,<title>probe-756-sibling</title><body style="background:%23336">sibling</body>');
      await sleep(1500);
    }
    await sleep(300);
    const grab = await helper.ask(state === 'sibling-front' ? 'grab probe-756-sibling' : 'grab');
    await sleep(300);
    if (state === 'minimized') win.minimize();
    await sleep(400);
    await helper.ask('shift');
    await sleep(idleMs || 300);
    const before = await helper.ask('fg');
    const beforeOk =
      state === 'sibling-front' ? before.endsWith('|probe-756-sibling') : !before.startsWith(me + '|');
    const errors = [];
    const isFocusedBefore = win.isFocused();
    try { await fn(win); } catch (e) { errors.push(String(e)); }
    const samples = {};
    let waited = 0;
    for (const at of [150, 700, 2000]) {
      await sleep(at - waited);
      waited = at;
      samples[at] = isTarget(await helper.ask('fg'));
    }
    const after = await helper.ask('fg');
    const top = await helper.ask(`at ${centre.x} ${centre.y}`);
    const row = {
      technique: name,
      start: state,
      idleMs: idleMs || 0,
      grab,
      foregroundBefore: before,
      validStart: beforeOk,
      foregroundAfter: after,
      tookForeground: samples[700],
      foregroundAt: samples,
      onTopAtCentre: isTarget(top),
      isFocusedBefore,
      isFocused: win.isFocused(),
      isMinimized: win.isMinimized(),
      isMaximized: win.isMaximized(),
      errors,
    };
    rows.push(row);
    console.log(JSON.stringify(row));
  };

  // --only N runs technique N (index into TECHNIQUES) --reps times in this
  // process; without it, every technique once. Fresh processes per technique
  // are what the findings table is built from: one technique's after-effects
  // (a window left topmost, a restored placement) must not leak into the next.
  const onlyAt = process.argv.indexOf('--only');
  const repsAt = process.argv.indexOf('--reps');
  const reps = repsAt > 0 ? Number(process.argv[repsAt + 1]) : 1;
  const list = onlyAt > 0 ? [TECHNIQUES[Number(process.argv[onlyAt + 1])]] : TECHNIQUES;
  for (const [name, state, fn] of list) for (let i = 0; i < reps; i++) await attempt(name, state, fn);
  if (IDLE) {
    await attempt('show()+focus() after 205 s idle', 'behind', (w) => { w.show(); w.focus(); }, 205000);
  }
  const out = path.join(__dirname, 'results', `result-${Date.now()}.json`);
  fs.writeFileSync(out, JSON.stringify({ electron: process.versions.electron, os: process.getSystemVersion(), pid: process.pid, rows }, null, 2));
  console.log('WROTE ' + out);
  // `quit` has no reply line — awaiting it would hang the probe
  helper.kill();
  holder.kill();
  app.exit(0);
}

main().catch((e) => {
  console.error(e);
  app.exit(1);
});
