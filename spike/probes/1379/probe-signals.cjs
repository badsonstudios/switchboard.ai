// #1379 probe, part 1: after a REFUSED focus() on a popped-out window, which of
// Electron's focus signals lie, and which (if any) stay truthful?
//
// Run (under the e2e lock — it moves the foreground around by design):
//   node_modules/electron/dist/electron.exe spike/probes/1379/probe-signals.cjs
//
// A bare main window M opens a child window P with window.open, the way
// dockview opens a popout, and the opener's renderer calls P's DOM
// `window.focus()` — exactly dockview's `onDidActiveChange` call. #756's
// stand-in "other app" (holder.ps1) holds the OS foreground, and #756's
// helper.ps1 answers who REALLY holds it (GetForegroundWindow).
//
// At each step it records: P.isFocused(), M.isFocused(), getFocusedWindow(),
// P.webContents.isFocused(), P's document.hasFocus(), every 'focus' / 'blur'
// event Electron emitted on either window since the last step, and the truth.
'use strict';
const { app, BrowserWindow } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const P756 = path.join(__dirname, '..', '756');

function startHelper() {
  const ps = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(P756, 'helper.ps1')], {
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


// The raw Win32 activation messages the OS sends each window, beside
// Electron's events: WM_ACTIVATEAPP (0x1C) is sent only when the foreground
// moves between PROCESSES, so it cannot be produced by a refused focus().
const MSGS = { 0x0006: 'WM_ACTIVATE', 0x0086: 'WM_NCACTIVATE', 0x001c: 'WM_ACTIVATEAPP', 0x0007: 'WM_SETFOCUS', 0x0008: 'WM_KILLFOCUS' };
function hookAll(name, w, events) {
  for (const [msg, label] of Object.entries(MSGS)) {
    w.hookWindowMessage(Number(msg), (wParam) => {
      const v = wParam.length >= 4 ? wParam.readUInt32LE(0) : -1;
      events.push(`${name}:${label}(${label === 'WM_ACTIVATE' ? v & 0xffff : v})`);
    });
  }
}

async function main() {
  await app.whenReady();
  const holder = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(P756, 'holder.ps1')], { stdio: 'ignore' });
  const helper = startHelper();
  await helper.ready;

  const events = [];
  const appEvents = [];
  const M = new BrowserWindow({ x: 100, y: 100, width: 500, height: 350, title: 'probe-1379-main', show: true });
  M.on('page-title-updated', (e) => e.preventDefault());
  hookAll('M', M, events);
  M.loadURL('data:text/html,<title>probe-1379-main</title><body style="background:%23336;color:white">main</body>');
  await sleep(1000);
  let P = null;
  M.webContents.setWindowOpenHandler(() => ({
    action: 'allow',
    overrideBrowserWindowOptions: { x: 300, y: 200, width: 420, height: 300, title: 'probe-1379-popout' },
  }));
  M.on('focus', () => events.push('M:focus'));
  M.on('blur', () => events.push('M:blur'));
  M.webContents.on('did-create-window', (w) => {
    P = w;
    w.on('focus', () => events.push('P:focus'));
    w.on('blur', () => events.push('P:blur'));
    w.on('page-title-updated', (e) => e.preventDefault());
    hookAll('P', w, events);
    w.setTitle('probe-1379-popout');
  });
  app.on('browser-window-focus', (_e, w) => appEvents.push(`app-focus:${w === M ? 'M' : w === P ? 'P' : '?'}`));
  app.on('browser-window-blur', (_e, w) => appEvents.push(`app-blur:${w === M ? 'M' : w === P ? 'P' : '?'}`));
  await M.webContents.executeJavaScript(
    "window.__pop = window.open('about:blank', '1-2', 'width=420,height=300'); window.__pop.document.title='probe-1379-popout'; true"
  );
  await sleep(1500);
  if (!P) throw new Error('no popout');

  const me = String(process.pid);
  const rows = [];
  const snap = async (step) => {
    const fg = await helper.ask('fg');
    const fw = BrowserWindow.getFocusedWindow();
    let hasFocus = null;
    try { hasFocus = await P.webContents.executeJavaScript('document.hasFocus()'); } catch (e) { hasFocus = String(e); }
    const row = {
      step,
      truth: fg.startsWith(me + '|') ? fg.split('|')[2] : 'OTHER:' + fg.split('|')[1],
      P_isFocused: P.isFocused(),
      M_isFocused: M.isFocused(),
      focusedWindow: fw === M ? 'M' : fw === P ? 'P' : fw ? '?' : null,
      P_wc_isFocused: P.webContents.isFocused(),
      P_hasFocus: hasFocus,
      events: events.splice(0),
      appEvents: appEvents.splice(0),
    };
    rows.push(row);
    console.log(JSON.stringify(row));
  };

  const otherAppInFront = async () => {
    await helper.ask('grab');
    await sleep(300);
    await helper.ask('shift');
    await sleep(500);
  };

  await snap('0 just after window.open (nothing done yet)');
  // A: the other app takes the foreground (as a person clicking it would)
  await otherAppInFront();
  await snap('A other app in front');
  // B: the opener's DOM window.focus() on the popout (dockview's call)
  await M.webContents.executeJavaScript('window.__pop.focus(); true');
  await sleep(700);
  await snap('B after DOM popout.focus()');
  // F/G: the person goes to the main window and back: a clean, honest start
  await helper.ask('grab probe-1379-main');
  await sleep(700);
  await snap('F person brings M to front');
  await otherAppInFront();
  await snap('G back to the other app (honest blur)');
  for (const [name, fn] of [
    ['DOM popout.focus()', () => M.webContents.executeJavaScript('window.__pop.focus(); true')],
    ['P.focus()', () => P.focus()],
    ['P.show()+P.focus()', () => { P.show(); P.focus(); }],
    ['P.webContents.focus()', () => P.webContents.focus()],
    ['M.focus()', () => M.focus()],
    ['M.show()+M.focus()', () => { M.show(); M.focus(); }],
  ]) {
    await otherAppInFront();
    const before = { P: P.isFocused(), M: M.isFocused() };
    await fn();
    await sleep(700);
    await snap(`R ${name} from an honest blur (before: P=${before.P} M=${before.M})`);
    await sleep(2000);
    await snap(`R ${name} +2 s`);
    // reset: the person visits P then returns to the other app
    await helper.ask('grab probe-1379-popout');
    await sleep(500);
    await otherAppInFront();
    await snap(`R ${name} reset`);
  }

  // FLASH: does flashFrame's caption blink arrive as WM_NCACTIVATE toggles?
  await otherAppInFront();
  await snap('X0 honest blur before the flash');
  P.flashFrame(true);
  await sleep(3000);
  await snap('X1 P.flashFrame(true) for 3 s, never focused');
  // poison P while it flashes, then let the person really arrive
  P.focus();
  await sleep(2500);
  await snap('X2 refused P.focus() while flashing, +2.5 s');
  await helper.ask('grab probe-1379-popout');
  await sleep(1500);
  await snap('X3 person brings P to front (poisoned + flashing before)');
  P.flashFrame(false);
  await otherAppInFront();
  await snap('X4 back to the other app');

  // POISONED, THEN FLASHED: the attention raise's refused path flashes a
  // window that may already be lying
  await otherAppInFront();
  P.focus();
  await sleep(1000);
  await snap('Y0 refused P.focus() (poisoned)');
  P.flashFrame(true);
  await sleep(3000);
  await snap('Y1 poisoned P flashFrame(true) for 3 s');
  M.flashFrame(true);
  await sleep(3000);
  await snap('Y2 M flashFrame(true) for 3 s, P still poisoned');
  await helper.ask('grab probe-1379-main');
  await sleep(1000);
  await snap('Y3 person brings M to front');
  P.flashFrame(false);
  M.flashFrame(false);
  await otherAppInFront();
  await snap('Y4 back to the other app');

  const out = path.join(__dirname, 'results', `signals-${Date.now()}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ electron: process.versions.electron, os: process.getSystemVersion(), pid: process.pid, rows }, null, 2));
  console.log('WROTE ' + out);
  helper.kill();
  holder.kill();
  app.exit(0);
}

main().catch((e) => {
  console.error(e);
  app.exit(1);
});
