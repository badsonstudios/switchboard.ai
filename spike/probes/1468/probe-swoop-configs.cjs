// #1468 probe: why does #756's swoop (minimize + restore) take the foreground
// for a lone window (3/3, #756) but not once the process has a second window
// (0/3 for main AND popout, `spike/probes/1379/probe-swoop.cjs`)?
//
// Independent variables, one at a time:
//   config     - single: the main window alone
//                plain:  main + a second BrowserWindow made by main
//                open:   main + a popout made by the page's window.open (the
//                        app's shape: dockview's popouts)
//                owned:  as `open`, but the popout is OWNED by main (parent)
//   target     - which window the raise is for
//   technique  - swoop: minimize()+restore(), what the app does today
//                swoop-all: minimize EVERY window of ours, restore the target,
//                        then the others without activating (showInactive)
//                hide-others: hide() the other windows, swoop the target,
//                        then showInactive() them
//                others-minimized: the other windows are ALREADY minimized
//                        (set up before the other app takes the foreground),
//                        then the plain swoop: is it "the process has another
//                        visible window" that loses?
//
// Each rep: the stand-in other app (#756's holder) takes the foreground, a
// Shift tap lands in it ("the user just typed there"), the technique runs,
// 700 ms later `GetForegroundWindow` is asked who is in front.
//
// Run (under the e2e lock — it opens windows and moves the foreground):
//   node_modules/electron/dist/electron.exe spike/probes/1468/probe-swoop-configs.cjs [--reps N] [--configs a,b] [--techniques a,b]
'use strict';
const { app, BrowserWindow, screen } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const arg = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : dflt;
};
const REPS = Number(arg('--reps', '3'));
const CONFIGS = arg('--configs', 'single,plain,open,owned').split(',');
// --under: both windows start UNDER the stand-in app (it covers 0..1100 x 0..800),
// so the probe can also ask what is stacked on top at each window's centre:
// does a technique leave our OTHER window covering the app the person is in?
const UNDER = process.argv.includes('--under');
// (the holder is DPI-aware, so its 1100 x 800 are PHYSICAL pixels: at 150 %
// that is 733 x 533 here, and both windows must fit inside it)
const POS = UNDER
  ? { mx: 40, my: 40, px: 380, py: 260, w: 300, h: 200 }
  : { mx: 1150, my: 80, px: 1150, py: 420, w: 420, h: 300 };
// --poison: before each raise, a refused focus() on the target, which leaves
// it Windows' thread-active window with an inactive caption — the state #1379
// measured on the real app's popouts (opened while another app was in front)
const POISON = process.argv.includes('--poison');
// --poison-swoop: before each raise, today's swoop with the other window
// visible (refused, 0/n above), then the other app back in front — the state
// every earlier failure of the hide variants followed
const POISON_SWOOP = process.argv.includes('--poison-swoop');
// --poison-wait MS: how long after that refused swoop the raise comes
const POISON_WAIT = Number(arg('--poison-wait', '0'));
// --others-maximized: the other window is maximized; does hide() + showInactive()
// bring it back maximized (or does it come back restored to normal size)?
const OTHERS_MAX = process.argv.includes('--others-maximized');
// --target-minimized: the target starts minimized, so the raise is restore()
// alone (the app's `restore` / `restore-aside`)
const TARGET_MIN = process.argv.includes('--target-minimized');
const TECHNIQUES = arg('--techniques', 'swoop,swoop-all,hide-others,others-minimized').split(',');

function startHelper() {
  const ps = spawn(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, '..', '1379', 'helper.ps1')],
    { stdio: ['pipe', 'pipe', 'inherit'] }
  );
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

const page = (t, bg) => `data:text/html,<title>${t}</title><body style="background:${bg}">${t}</body>`;

async function makeConfig(config) {
  const M = new BrowserWindow({ x: POS.mx, y: POS.my, width: POS.w, height: POS.h, title: 'probe-1468-main', show: true });
  M.on('page-title-updated', (e) => e.preventDefault());
  await M.loadURL(page('probe-1468-main', '%23336'));
  let P = null;
  if (config === 'plain') {
    P = new BrowserWindow({ x: POS.px, y: POS.py, width: POS.w, height: POS.h, title: 'probe-1468-popout', show: true });
    P.on('page-title-updated', (e) => e.preventDefault());
    await P.loadURL(page('probe-1468-popout', '%23633'));
  } else if (config === 'open' || config === 'owned') {
    M.webContents.setWindowOpenHandler(() => ({
      action: 'allow',
      overrideBrowserWindowOptions: {
        x: POS.px,
        y: POS.py,
        width: POS.w,
        height: POS.h,
        title: 'probe-1468-popout',
        ...(config === 'owned' ? { parent: M } : {}),
      },
    }));
    const created = new Promise((r) => M.webContents.once('did-create-window', r));
    await M.webContents.executeJavaScript("window.__pop = window.open('about:blank', '1-2', ''); true");
    P = await created;
    P.on('page-title-updated', (e) => e.preventDefault());
    P.setTitle('probe-1468-popout');
  }
  await sleep(1200);
  return { M, P };
}

async function settleAll(wins) {
  for (const w of wins) {
    if (w.isMinimized()) w.restore();
    if (!w.isVisible()) w.showInactive();
  }
  await sleep(300);
}

async function hideOthersSwoop(target, others) {
  for (const o of others) o.hide();
  target.minimize();
  target.restore();
  await sleep(150);
  for (const o of others) o.showInactive();
}

async function runTechnique(name, target, others, isFrontNow) {
  switch (name) {
    case 'hide-others-retry': {
      // once more if the first did not land: after a refused swoop, the first
      // attempt of ANY variant was refused and the second was not (run 1)
      await hideOthersSwoop(target, others);
      await sleep(400);
      if (await isFrontNow()) return 'first';
      await hideOthersSwoop(target, others);
      return 'second';
    }
    case 'swoop':
    case 'others-minimized':
      target.minimize();
      target.restore();
      return;
    case 'swoop-all':
      for (const o of others) o.minimize();
      target.minimize();
      target.restore();
      await sleep(150);
      for (const o of others) o.showInactive();
      return;
    case 'blur-hide-others':
      // deactivate the target first: a window that is already "active" gets a
      // bare WM_ACTIVATE from the restore and no foreground (#1379)
      target.blur();
      for (const o of others) o.hide();
      target.minimize();
      target.restore();
      await sleep(150);
      for (const o of others) o.showInactive();
      return;
    case 'hide-all':
      for (const o of others) o.hide();
      target.hide();
      target.minimize();
      target.restore();
      await sleep(150);
      for (const o of others) o.showInactive();
      return;
    case 'hide-others':
      for (const o of others) o.hide();
      target.minimize();
      target.restore();
      await sleep(150);
      for (const o of others) o.showInactive();
      return;
    default:
      throw new Error('unknown technique ' + name);
  }
}

// configs are torn down between runs: closing the last window must not quit
app.on('window-all-closed', () => {});

async function main() {
  await app.whenReady();
  const holder = spawn(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, '..', '756', 'holder.ps1')],
    { stdio: 'ignore' }
  );
  const helper = startHelper();
  await helper.ready;
  await sleep(1500);
  const me = String(process.pid);
  const rows = [];
  for (const config of CONFIGS) {
    const { M, P } = await makeConfig(config);
    const all = P ? [M, P] : [M];
    const targets = P ? [['main', M], ['popout', P]] : [['main', M]];
    for (const [tname, target] of targets) {
      const others = all.filter((w) => w !== target);
      for (const technique of TECHNIQUES) {
        if (others.length === 0 && technique !== 'swoop') continue; // same as swoop alone
        const title = tname === 'main' ? 'probe-1468-main' : 'probe-1468-popout';
        for (let i = 0; i < REPS; i++) {
          await settleAll(all);
          if (technique === 'others-minimized') for (const o of others) o.minimize();
          if (OTHERS_MAX) for (const o of others) if (!o.isMaximized()) o.maximize();
          if (TARGET_MIN) target.minimize();
          await sleep(200);
          await helper.ask('grab');
          await sleep(300);
          await helper.ask('shift');
          await sleep(500);
          if (POISON) {
            target.focus();
            await sleep(500);
          }
          if (POISON_SWOOP) {
            target.minimize();
            target.restore();
            await sleep(700);
            await sleep(POISON_WAIT);
            await helper.ask('grab');
            await sleep(300);
            await helper.ask('shift');
            await sleep(500);
          }
          const before = await helper.ask('fg');
          const validStart = !before.startsWith(me + '|') && (!POISON || target.isFocused());
          const electronBefore = target.isFocused();
          const attempt = await runTechnique(technique, target, others, async () => {
            const fg = await helper.ask('fg');
            return fg.startsWith(me + '|') && fg.endsWith('|' + title);
          });
          await sleep(700);
          const after = await helper.ask('fg');
          const took = after.startsWith(me + '|') && after.endsWith('|' + title);
          const ours = after.startsWith(me + '|');
          // what is on top at each window's centre (physical pixels)
          const atCentre = async (w) => {
            const b = w.getBounds();
            const sf = screen.getDisplayMatching(b).scaleFactor;
            return helper.ask(`at ${Math.round((b.x + b.width / 2) * sf)} ${Math.round((b.y + b.height / 2) * sf)}`);
          };
          const topAtTarget = await atCentre(target);
          const topAtOthers = [];
          for (const o of others) topAtOthers.push(await atCentre(o));
          const row = {
            config,
            under: UNDER,
            poisoned: POISON,
            poisonedBySwoop: POISON_SWOOP,
            poisonWait: POISON_WAIT,
            attempt: attempt ?? null,
            targetMinimized: TARGET_MIN,
            othersMaximizedAfter: others.map((o) => o.isMaximized()),
            othersVisibleAfter: others.map((o) => o.isVisible() && !o.isMinimized()),
            topAtTarget,
            topAtOthers,
            target: tname,
            technique,
            rep: i,
            validStart,
            electronBefore,
            took,
            oursButOther: ours && !took,
            electronAfter: target.isFocused(),
            before,
            after,
          };
          rows.push(row);
          console.log(JSON.stringify(row));
        }
      }
    }
    for (const w of all) if (!w.isDestroyed()) w.destroy();
    await sleep(500);
  }
  const agg = {};
  for (const r of rows) {
    if (!r.validStart) continue;
    const k = `${r.config.padEnd(6)} ${r.target.padEnd(6)} ${r.technique}`;
    agg[k] = agg[k] || [0, 0];
    agg[k][1]++;
    if (r.took) agg[k][0]++;
  }
  for (const [k, [t, n]] of Object.entries(agg)) console.log(`SUMMARY ${k}: took the foreground ${t}/${n}`);
  const out = path.join(__dirname, 'results', `configs-${Date.now()}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(
    out,
    JSON.stringify({ electron: process.versions.electron, os: process.getSystemVersion(), argv: process.argv.slice(2), rows }, null, 2)
  );
  console.log('WROTE ' + out);
  helper.kill();
  holder.kill();
  app.exit(0);
}

main().catch((e) => {
  console.error(e);
  app.exit(1);
});
