// #909 probe: reproduces the lost-keyboard bug with REAL OS input (Windows only).
// Local-only: it moves the real mouse and types real keys, and osinput.ps1
// refuses to send anything unless an electron window is in the foreground.
// Run: copy into e2e/, `npm run build`, `npx playwright test e2e/repro-909.spec.ts`.
import { test, expect } from '@playwright/test';
import { execFileSync } from 'child_process';
import path from 'path';
import { launchApp, tempProjectFolder } from './fixtures/app';

// Copy this file into e2e/ to run it; osinput.ps1 is found beside the original.
const PS = path.join(__dirname, '..', 'spike', 'probes', '909', 'osinput.ps1');
const os = (...args: string[]): string => {
  try {
    return execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PS, ...args], {
      encoding: 'utf8',
    }).trim();
  } catch (e) {
    return 'ERR ' + String((e as { stdout?: string }).stdout ?? e);
  }
};

test('repro #909', async () => {
  test.setTimeout(120_000);
  const folder = tempProjectFolder();
  const a = await launchApp({ seedFolder: folder, env: { SWITCHBOARD_FAKE_PROVIDER: 'stream' } });
  try {
    const w = a.window;
    await expect(w.getByText(path.basename(folder)).first()).toBeVisible({ timeout: 25_000 });
    await a.app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      win.show();
      win.focus();
    });
    await w.waitForTimeout(800);
    const box = w.getByPlaceholder(/Prompt this session/);

    const screenPoint = async (): Promise<[number, number]> => {
      const bb = (await box.boundingBox())!;
      const { cb, sf } = await a.app.evaluate(({ BrowserWindow, screen }) => {
        const win = BrowserWindow.getAllWindows()[0];
        const cb = win.getContentBounds();
        return { cb, sf: screen.getDisplayMatching(cb).scaleFactor };
      });
      return [
        Math.round((cb.x + bb.x + bb.width / 2) * sf),
        Math.round((cb.y + bb.y + bb.height / 2) * sf),
      ];
    };
    const hasFocus = () => w.evaluate(() => document.hasFocus());

    // CONTROL: real click + real typing works
    console.log('fg before', os('fg'));
    let [x, y] = await screenPoint();
    console.log('click', os('click', '-x', String(x), '-y', String(y)));
    await w.waitForTimeout(300);
    console.log('type', os('type', '-text', 'ctl'));
    await w.waitForTimeout(500);
    console.log('control value=', await box.inputValue(), 'hasFocus=', await hasFocus());

    let sawDialog = false;
    w.on('dialog', () => {
      sawDialog = true;
    });
    for (const variant of ['tab-x', 'tab-x']) {
      await box.fill('');
      if (variant.startsWith('mainbox')) {
        void a.app.evaluate(({ BrowserWindow, dialog }) => {
          const win = BrowserWindow.getAllWindows()[0];
          void dialog.showMessageBox(win, { message: 'main box', buttons: ['OK', 'Cancel'], cancelId: 1 });
        });
      } else {
        const x = w.locator('.dv-tab button').first();
        console.log('x buttons', await w.locator('.dv-tab button').count(), await x.getAttribute('title'));
        void x.click().catch(() => {});
      }
      await w.waitForTimeout(1200);
      console.log(variant, 'dialog', sawDialog, 'esc', os('type', '-text', '{ESC}'));
      await w.waitForTimeout(800);
      console.log(variant, 'state', JSON.stringify(await a.app.evaluate(({ BrowserWindow }, v) => {
        const win = BrowserWindow.getAllWindows()[0];
        const st = { isFocused: win.isFocused(), wc: win.webContents.isFocused(), fw: BrowserWindow.getFocusedWindow() === win };
        if (v === 'guarded' && BrowserWindow.getFocusedWindow() === win) {
          win.blur();
          win.focus();
        }
        return st;
      }, variant)));
      await w.waitForTimeout(400);
      [x, y] = await screenPoint();
      os('click', '-x', String(x), '-y', String(y));
      await w.waitForTimeout(300);
      console.log(variant, 'type', os('type', '-text', 'XYZ'));
      await w.waitForTimeout(500);
      console.log(variant, '=> value=', JSON.stringify(await box.inputValue()), 'hasFocus', await hasFocus());
    }
  } finally {
    await a.cleanup();
  }
});
