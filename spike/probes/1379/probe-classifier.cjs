// #1379 probe, part 3: does a classifier built on the raw Win32 activation
// messages agree with the OS's own answer (GetForegroundWindow) where every
// Electron signal lies?
//
// Run (under the e2e lock — it moves the foreground AND clicks the mouse):
//   node_modules/electron/dist/electron.exe spike/probes/1379/probe-classifier.cjs [--reps N]
//
// The classifier here is the rule `src/main/foreground.ts` ships, restated in
// plain JS (spike/** is outside every tsconfig). Part 1 (`probe-signals.cjs`)
// is where the rule came from:
//   - an HONEST activation arrives as WM_NCACTIVATE(TRUE) then WM_ACTIVATE(on):
//     the caption is drawn active because the window really is in front;
//   - a REFUSED one (focus() from the background) arrives as
//     WM_NCACTIVATE(FALSE) then WM_ACTIVATE(on): Windows makes the window its
//     thread's active window but draws it inactive. Electron reports it
//     focused from here on;
//   - when the person then really brings that window forward there is no
//     WM_ACTIVATE at all (it is already the thread's active window), only
//     WM_NCACTIVATE(TRUE);
//   - flashFrame blinks the caption with alternating WM_NCACTIVATE FALSE/TRUE
//     and no WM_ACTIVATE, so a lone TRUE is not proof while the window flashes;
//   - leaving is always WM_ACTIVATE(off).
'use strict';
const { app, BrowserWindow, screen } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const repsAt = process.argv.indexOf('--reps');
const REPS = repsAt > 0 ? Number(process.argv[repsAt + 1]) : 3;

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

// ---- the classifier (mirrors src/main/foreground.ts) ----
const WM_ACTIVATE = 0x0006;
const WM_NCACTIVATE = 0x0086;
const RAW = [];
const WM_ACTIVATEAPP = 0x001c;
// app level: set by any window coming to the front, cleared by
// WM_ACTIVATEAPP(FALSE); seeds a window that was activated before it was
// tracked (a popout: did-create-window comes after its first activation)
const appState = { front: false };
function track(w, name) {
  const active = w.isFocused();
  const s = { active, front: active && appState.front, lastNc: null, burstNc: null, settling: false };
  w.hookWindowMessage(WM_NCACTIVATE, (wParam) => {
    const on = wParam.readUInt32LE(0) !== 0;
    RAW.push(`${name}:NC${on ? 1 : 0}@${Date.now() % 100000}`);
    // a second active caption in a row: a blink never sends that
    if (on && s.active && !s.front && s.lastNc === true) s.front = true;
    s.lastNc = on;
    // the burst: an activation's caption message and the activation itself
    // arrive before the event loop turns; a blink's caption message does not
    s.burstNc = on;
    if (!s.settling) {
      s.settling = true;
      setImmediate(() => {
        s.settling = false;
        s.burstNc = null;
      });
    }
    if (s.front) appState.front = true;
  });
  w.hookWindowMessage(WM_ACTIVATE, (wParam) => {
    const on = (wParam.readUInt32LE(0) & 0xffff) !== 0;
    RAW.push(`${name}:ACT${on ? 1 : 0}@${Date.now() % 100000}`);
    s.active = on;
    if (!on) s.front = false;
    else if (s.burstNc !== null) s.front = s.burstNc;
    s.burstNc = null;
    if (s.front) appState.front = true;
  });
  w.hookWindowMessage(WM_ACTIVATEAPP, (wParam) => {
    if (wParam.readUInt32LE(0) === 0) appState.front = false;
  });
  return {
    s,
    flash(on) {
      w.flashFrame(on);
    },
  };
}

async function main() {
  await app.whenReady();
  const holder = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, '..', '756', 'holder.ps1')], { stdio: 'ignore' });
  const helper = startHelper();
  await helper.ready;

  // both windows OUTSIDE the holder (0,0 1100x800), so a click can reach them
  const M = new BrowserWindow({ x: 1150, y: 80, width: 420, height: 300, title: 'probe-1379-main', show: false });
  const tM = track(M, 'M');
  M.on('page-title-updated', (e) => e.preventDefault());
  M.show();
  M.loadURL('data:text/html,<title>probe-1379-main</title><body style="background:%23336;color:white">main</body>');
  await sleep(1000);
  let P = null;
  let tP = null;
  M.webContents.setWindowOpenHandler(() => ({
    action: 'allow',
    overrideBrowserWindowOptions: { x: 1150, y: 420, width: 420, height: 300, title: 'probe-1379-popout' },
  }));
  M.webContents.on('did-create-window', (w) => {
    P = w;
    tP = track(w, 'P');
    w.on('page-title-updated', (e) => e.preventDefault());
    w.setTitle('probe-1379-popout');
  });
  await M.webContents.executeJavaScript("window.__pop = window.open('about:blank', '1-2', ''); true");
  await sleep(1500);
  if (!P) throw new Error('no popout');

  const centre = (w) => {
    const b = w.getBounds();
    const p = screen.dipToScreenPoint({ x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) });
    return `${p.x} ${p.y}`;
  };
  const me = String(process.pid);
  const rows = [];
  let agree = 0;
  let disagree = 0;
  let electronLies = 0;
  const snap = async (step) => {
    const fg = await helper.ask('fg');
    const truth = fg.startsWith(me + '|') ? fg.split('|')[2].replace('probe-1379-', '') : 'other';
    const cls = tP.s.front ? 'popout' : tM.s.front ? 'main' : 'other';
    const fw = BrowserWindow.getFocusedWindow();
    const electron = fw === P ? 'popout' : fw === M ? 'main' : 'other';
    const ok = cls === truth;
    if (ok) agree++;
    else disagree++;
    if (electron !== truth) electronLies++;
    const row = { step, truth, classifier: cls, electron, ok, raw: RAW.splice(0).join(' ') };
    rows.push(row);
    console.log(JSON.stringify(row));
  };
  const otherAppInFront = async () => {
    await helper.ask('grab');
    await sleep(300);
    await helper.ask('shift');
    await sleep(500);
  };

  await snap('start');
  for (let rep = 0; rep < REPS; rep++) {
    await otherAppInFront();
    await snap(`${rep} S0 other app in front`);
    P.focus();
    await sleep(700);
    await snap(`${rep} S1 refused P.focus()`);
    await helper.ask(`click ${centre(P)}`);
    await sleep(700);
    await snap(`${rep} S2 person CLICKS the poisoned popout`);
    await otherAppInFront();
    await snap(`${rep} S3 back to the other app`);
    P.focus();
    await sleep(300);
    tP.flash(true);
    await sleep(1600);
    await snap(`${rep} S4 refused P.focus() + flashing 1.6 s`);
    await sleep(1300);
    await snap(`${rep} S4b still flashing, 2.9 s`);
    await helper.ask(`click ${centre(P)}`);
    await sleep(700);
    await snap(`${rep} S5 person clicks the poisoned, flashing popout`);
    tP.flash(false);
    await otherAppInFront();
    tM.flash(true);
    await sleep(1700);
    await snap(`${rep} S6 main flashing (not poisoned)`);
    await helper.ask(`click ${centre(M)}`);
    await sleep(700);
    await snap(`${rep} S7 person clicks main`);
    tM.flash(false);
    await otherAppInFront();
    await M.webContents.executeJavaScript('window.__pop.focus(); true');
    await sleep(700);
    await snap(`${rep} S8 opener's DOM popout.focus()`);
    P.focus();
    await sleep(500);
    await helper.ask('grab probe-1379-popout');
    await sleep(700);
    await snap(`${rep} S9 poisoned popout brought forward by SetForegroundWindow (alt-tab-like)`);
    M.focus();
    await sleep(700);
    await snap(`${rep} S10 M.focus() while our popout is in front (between our own windows)`);
    P.focus();
    await sleep(700);
    await snap(`${rep} S11 P.focus() while main is in front`);
    // #756's swoop on a window a refused focus() left "active", with and
    // without the refused raise's flash running (the real app's sequence)
    await otherAppInFront();
    P.focus();
    await sleep(500);
    P.minimize();
    P.restore();
    await sleep(700);
    await snap(`${rep} S12 swoop on the poisoned popout`);
    await otherAppInFront();
    await snap(`${rep} S12b other app in front again`);
    P.focus();
    await sleep(300);
    tP.flash(true);
    await sleep(1300);
    P.minimize();
    P.restore();
    await sleep(700);
    await snap(`${rep} S13 swoop on the poisoned, FLASHING popout`);
    tP.flash(false);
    await otherAppInFront();
    await snap(`${rep} S13b other app in front again`);
  }
  await otherAppInFront();
  await snap('end other app in front');
  console.log(`SUMMARY classifier agrees ${agree}/${agree + disagree}; Electron getFocusedWindow wrong ${electronLies}/${agree + disagree}`);
  const out = path.join(__dirname, 'results', `classifier-${Date.now()}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ electron: process.versions.electron, os: process.getSystemVersion(), rows, agree, disagree, electronLies }, null, 2));
  console.log('WROTE ' + out);
  helper.kill();
  holder.kill();
  app.exit(0);
}

main().catch((e) => {
  console.error(e);
  app.exit(1);
});
