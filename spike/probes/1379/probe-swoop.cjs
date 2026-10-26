// #1379 probe, part 4: #756's swoop (minimize + restore) took the foreground
// 3/3 from a window that was honestly behind. Does it still work on a window a
// refused focus() left "active" (Windows' thread-active window, caption drawn
// inactive)? The real-app run after the fix said no. Which variant does?
//
// Run (under the e2e lock):
//   node_modules/electron/dist/electron.exe spike/probes/1379/probe-swoop.cjs [--reps N]
'use strict';
const { app, BrowserWindow } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const repsAt = process.argv.indexOf('--reps');
const REPS = repsAt > 0 ? Number(process.argv[repsAt + 1]) : 3;
const UNDER = process.argv.includes('--under-holder');
const XPOS_M = UNDER ? 120 : 1150;
const XPOS_P = UNDER ? 300 : 1150;

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
  ['minimize()+restore()', (w) => { w.minimize(); w.restore(); }],
  ['minimize(), 400 ms, restore()', async (w) => { w.minimize(); await sleep(400); w.restore(); }],
  ['blur()+minimize()+restore()', (w) => { w.blur(); w.minimize(); w.restore(); }],
  ['hide()+minimize()+restore()', (w) => { w.hide(); w.minimize(); w.restore(); }],
  ['minimize(), 400 ms, restore()+focus()', async (w) => { w.minimize(); await sleep(400); w.restore(); w.focus(); }],
];

async function main() {
  await app.whenReady();
  const holder = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, '..', '756', 'holder.ps1')], { stdio: 'ignore' });
  const helper = startHelper();
  await helper.ready;
  const M = new BrowserWindow({ x: XPOS_M, y: 80, width: 420, height: 300, title: 'probe-1379-main', show: true });
  M.on('page-title-updated', (e) => e.preventDefault());
  M.loadURL('data:text/html,<title>probe-1379-main</title><body style="background:%23336">main</body>');
  await sleep(1000);
  let P = null;
  M.webContents.setWindowOpenHandler(() => ({
    action: 'allow',
    overrideBrowserWindowOptions: { x: XPOS_P, y: 420, width: 420, height: 300, title: 'probe-1379-popout' },
  }));
  M.webContents.on('did-create-window', (w) => {
    P = w;
    w.on('page-title-updated', (e) => e.preventDefault());
    w.setTitle('probe-1379-popout');
  });
  await M.webContents.executeJavaScript("window.__pop = window.open('about:blank', '1-2', ''); true");
  await sleep(1500);
  const me = String(process.pid);
  const isTitled = (fg, t) => fg.startsWith(me + '|') && fg.endsWith('|' + t);
  const rows = [];
  const ONLY_FIRST = process.argv.includes('--first-only');
  for (const [target, poisoned] of [['main', false], ['popout', false], ['popout', true], ['main', true]]) {
    const W = target === 'main' ? M : P;
    const title = target === 'main' ? 'probe-1379-main' : 'probe-1379-popout';
    for (const [name, fn] of ONLY_FIRST ? TECHNIQUES.slice(0, 1) : TECHNIQUES) {
      for (let i = 0; i < REPS; i++) {
        await helper.ask('grab');
        await sleep(300);
        await helper.ask('shift');
        await sleep(500);
        if (poisoned) {
          W.focus();
          await sleep(500);
        }
        const before = await helper.ask('fg');
        const validStart = !before.startsWith(me + '|') && (!poisoned || W.isFocused());
        await fn(W);
        await sleep(700);
        const after = await helper.ask('fg');
        const took = isTitled(after, title);
        const row = { target, technique: name, poisoned, validStart, took, before, after };
        rows.push(row);
        console.log(JSON.stringify(row));
      }
    }
  }
  const agg = {};
  for (const r of rows) {
    if (!r.validStart) continue;
    const k = `${r.target} ${r.poisoned ? 'POISONED' : 'honest  '} ${r.technique}`;
    agg[k] = agg[k] || [0, 0];
    agg[k][1]++;
    if (r.took) agg[k][0]++;
  }
  for (const [k, [t, n]] of Object.entries(agg)) console.log(`SUMMARY ${k}: took the foreground ${t}/${n}`);
  const out = path.join(__dirname, 'results', `swoop-${Date.now()}.json`);
  fs.writeFileSync(out, JSON.stringify({ electron: process.versions.electron, os: process.getSystemVersion(), rows }, null, 2));
  console.log('WROTE ' + out);
  helper.kill();
  holder.kill();
  app.exit(0);
}

main().catch((e) => {
  console.error(e);
  app.exit(1);
});
