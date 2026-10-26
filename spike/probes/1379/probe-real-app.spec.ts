// PROBE (#1379), part 2: the issue's path, in the REAL app.
// Findings: `spike/findings/1379-isfocused-after-refused-raise.md`.
//
// A popped-out session under "always jump to it" (`focus`), another app in
// front (#756's holder.ps1), and the 🔔 master switch OFF, so main declines
// the first attention raise. Then the switch goes back on and the same session
// needs you again. Does main raise its window, or skip it as "already in
// front"? And what does each focus signal say, against the OS's own answer
// (#756's helper.ps1, GetForegroundWindow)?
//
// HOW TO RUN IT: copy this file into `e2e/`, `npm run build`, then
// `npx playwright test e2e/probe-real-app.spec.ts` under the e2e machine lock
// (it moves the desktop foreground on purpose). It PRINTS, it does not assert.
import { test, expect } from '@playwright/test';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import {
  answerHeldPermissions,
  E2E_NO_ACTIVATE_ENV,
  launchApp,
  LaunchedApp,
  permissionHolder,
  tempProjectFolder,
} from './fixtures/app';

const DIRECT = { SWITCHBOARD_FAKE_PROVIDER: 'stream', [E2E_NO_ACTIVATE_ENV]: '', SWITCHBOARD_DEBUG: 'focus' };
const P756 = path.join(process.cwd(), 'spike', 'probes', '756');
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function startHelper() {
  const ps = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(P756, 'helper.ps1')], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  let buf = '';
  const waiters: Array<(l: string) => void> = [];
  ps.stdout!.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      const w = waiters.shift();
      if (w) w(line);
    }
  });
  const next = () => new Promise<string>((r) => waiters.push(r));
  const ready = next();
  return {
    ready,
    ask: (cmd: string) => {
      const p = next();
      ps.stdin!.write(cmd + '\n');
      return p;
    },
    kill: () => ps.kill(),
  };
}

type Rec = { outcome: string; window: string; technique?: string };
const raises = (a: LaunchedApp): Promise<Rec[]> =>
  a.app.evaluate(() => {
    const g = globalThis as { __switchboardAttentionRaises?: Rec[] };
    return (g.__switchboardAttentionRaises ?? []).map((r) => ({ ...r }));
  });

test('probe 1379', async () => {
  test.setTimeout(300_000);
  const folder = tempProjectFolder();
  const name = path.basename(folder);
  const a = await launchApp({ seedFolder: folder, env: DIRECT });
  const holder = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(P756, 'holder.ps1')], { stdio: 'ignore' });
  const helper = startHelper();
  try {
    await helper.ready;
    const w = a.window;
    await expect(w.locator('.dv-tabs-container .dv-tab')).toHaveCount(1, { timeout: 25_000 });
    await w.keyboard.press(`${MOD}+Shift+P`);
    await w.getByPlaceholder('Type a command or a session name…').fill('When any session needs you: always jump to it');
    await w.keyboard.press('Enter');
    await w.getByTitle('Pop out into its own window').click();
    await expect.poll(() => a.app.windows().filter((p) => p.url().includes('popout.html')).length, { timeout: 20_000 }).toBe(1);
    await sleep(1500);
    // every focus / blur Electron emits, from here on
    await a.app.evaluate(({ BrowserWindow }) => {
      const g = globalThis as { __probeEv?: string[] };
      g.__probeEv = [];
      for (const x of BrowserWindow.getAllWindows()) {
        const n = x.webContents.getURL().includes('popout.html') ? 'P' : 'M';
        x.on('focus', () => g.__probeEv!.push(`${n}:focus`));
        x.on('blur', () => g.__probeEv!.push(`${n}:blur`));
      }
    });
    const pid = String(a.app.process().pid);
    const snap = async (step: string) => {
      const fg = await helper.ask('fg');
      const s = await a.app.evaluate(({ BrowserWindow }) => {
        const g = globalThis as { __probeEv?: string[] };
        const out: Record<string, unknown> = {};
        for (const x of BrowserWindow.getAllWindows()) {
          const n = x.webContents.getURL().includes('popout.html') ? 'P' : 'M';
          out[`${n}_isFocused`] = x.isFocused();
        }
        const f = BrowserWindow.getFocusedWindow();
        out.focusedWindow = f ? (f.webContents.getURL().includes('popout.html') ? 'P' : 'M') : null;
        out.events = (g.__probeEv ?? []).splice(0);
        return out;
      });
      // the app's windows are owned by its main process pid
      const truth = fg.startsWith(pid + '|') ? 'APP:' + fg.split('|')[2] : 'OTHER:' + fg.split('|')[1];
      console.log('PROBE', JSON.stringify({ step, truth, ...s, raises: await raises(a) }));
    };

    await helper.ask('grab');
    await sleep(300);
    await helper.ask('shift');
    await sleep(800);
    await snap('0 other app in front');

    // 1. 🔔 off: the raise is declined, the in-app jump still happens
    await w.evaluate(() => window.switchboard.notifications.setPrefs({ enabled: false }));
    await permissionHolder(a)(name);
    await expect.poll(async () => (await raises(a)).length, { timeout: 20_000 }).toBe(1);
    await sleep(1500);
    await snap('1 first event, raise declined (notifications off)');
    expect(await answerHeldPermissions(a)).toBe(1);
    await sleep(4000); // the answered turn finishes: a `done`, declined too
    await snap('2 after answering');

    // 2. 🔔 back on; the person is still typing in the other app
    await w.evaluate(() => window.switchboard.notifications.setPrefs({ enabled: true }));
    await helper.ask('shift');
    await sleep(500);
    const before = (await raises(a)).length;
    await permissionHolder(a)(name);
    await expect.poll(async () => (await raises(a)).length, { timeout: 20_000 }).toBeGreaterThan(before);
    await sleep(1500);
    await snap('3 second event, raise allowed');
    await answerHeldPermissions(a);
    await sleep(3000);
    // 3. two more, each with the other app put back in front first
    for (const k of [4, 5]) {
      await helper.ask('grab');
      await sleep(300);
      await helper.ask('shift');
      await sleep(800);
      const n = (await raises(a)).length;
      await permissionHolder(a)(name);
      await expect.poll(async () => (await raises(a)).length, { timeout: 20_000 }).toBeGreaterThan(n);
      await sleep(1500);
      await snap(`${k} another event, other app put back in front first`);
      await answerHeldPermissions(a);
      await sleep(3000);
    }
    // the tracker's own account (SWITCHBOARD_DEBUG=focus), when the build has it
    const dir = await a.app.evaluate(({ app }) => app.getPath('logs'));
    for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
      for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split(String.fromCharCode(10))) {
        if (line.includes('foreground') || line.includes('attention raise')) console.log('LOG', line.slice(0, 400));
      }
    }
  } finally {
    helper.kill();
    holder.kill();
    await a.cleanup();
  }
});

// Out of the issue's path, measured because part 4 (`probe-swoop.cjs`) saw
// #756's swoop refused in a two-window process: does the MAIN window's
// attention raise take the foreground in the real app?
test('probe 1379: the main window raise, another app in front', async () => {
  test.setTimeout(180_000);
  const folder = tempProjectFolder();
  const name = path.basename(folder);
  const a = await launchApp({ seedFolder: folder, env: DIRECT });
  const holder = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(P756, 'holder.ps1')], { stdio: 'ignore' });
  const helper = startHelper();
  try {
    await helper.ready;
    const w = a.window;
    await expect(w.locator('.dv-tabs-container .dv-tab')).toHaveCount(1, { timeout: 25_000 });
    await w.keyboard.press(`${MOD}+Shift+P`);
    await w.getByPlaceholder('Type a command or a session name…').fill('When any session needs you: always jump to it');
    await w.keyboard.press('Enter');
    await sleep(1000);
    const pid = String(a.app.process().pid);
    for (let i = 0; i < 3; i++) {
      await helper.ask('grab');
      await sleep(300);
      await helper.ask('shift');
      await sleep(800);
      const before = await helper.ask('fg');
      const n = (await raises(a)).length;
      await permissionHolder(a)(name);
      await expect.poll(async () => (await raises(a)).length, { timeout: 20_000 }).toBeGreaterThan(n);
      await sleep(1200);
      const fg = await helper.ask('fg');
      console.log('PROBE', JSON.stringify({ i, before, after: fg, appInFront: fg.startsWith(pid + '|'), raise: (await raises(a)).at(-1) }));
      await answerHeldPermissions(a);
      await sleep(3000);
    }
  } finally {
    helper.kill();
    holder.kill();
    await a.cleanup();
  }
});
