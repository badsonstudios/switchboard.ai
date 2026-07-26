// P2-E9-03: the attention queue and its jump hotkey, driven through the REAL
// hook listener — the test plays the CLI's part (Notification / Stop POSTs
// with each session's own token), exactly as approval.spec.ts does for holds.
// No mock sits between the state machine and the queue.
import { test, expect, Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { launchApp, LaunchedApp, showTerminal, tempProjectFolder } from './fixtures/app';

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';
const activeTab = (w: Page) => w.locator('.dv-active-tab');
const eventRows = (w: Page) => w.locator('aside [data-event-kind]');

function findFile(root: string, name: string, depth = 6): string | null {
  if (depth < 0) return null;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    const full = path.join(root, e.name);
    if (e.isFile() && e.name === name) return full;
    if (e.isDirectory()) {
      const hit = findFile(full, name, depth - 1);
      if (hit) return hit;
    }
  }
  return null;
}

/** every session's token file, keyed by the session id its directory is named for */
function findTokens(root: string, depth = 6): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string, left: number): void => {
    if (left < 0) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isFile() && e.name === 'hook-token') {
        out.set(path.basename(dir), fs.readFileSync(full, 'utf8').trim());
      } else if (e.isDirectory()) {
        walk(full, left - 1);
      }
    }
  };
  walk(root, depth);
  return out;
}

async function poll<T>(fn: () => T | null, timeoutMs = 25_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error('poll timed out');
    await new Promise((r) => setTimeout(r, 250));
  }
}

test.describe('attention queue (E9-03)', () => {
  let a: LaunchedApp;
  test.afterEach(async () => a?.cleanup());

  /**
   * Three sessions in three different folders (so none auto-group and rail
   * order is plain creation order), each driven into a DIFFERENT attention
   * state. Creation order is deliberately not priority order — that is what
   * makes the ordering assertions mean something.
   */
  async function threeWaitingSessions(): Promise<{
    w: Page;
    post: (title: string, body: Record<string, unknown>) => Promise<string>;
    titles: { done: string; permission: string; input: string };
  }> {
    const folders = [tempProjectFolder(), tempProjectFolder(), tempProjectFolder()];
    a = await launchApp({ seedFolder: folders[0] });
    const w = a.window;
    const names = folders.map((f) => path.basename(f));
    await expect(w.getByText(names[0]).first()).toBeVisible({ timeout: 25_000 });

    for (const folder of folders.slice(1)) {
      await a.app.evaluate(({ dialog }, dir) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] });
      }, folder);
      await w.getByRole('button', { name: '+ session' }).click();
      await expect(w.getByText(path.basename(folder)).first()).toBeVisible({ timeout: 25_000 });
    }

    const logFile = await poll(() => {
      const f = findFile(a.home, 'switchboard.log');
      return f && fs.readFileSync(f, 'utf8').includes('hook listener up') ? f : null;
    });
    const port = Number(
      /"msg":"hook listener up".*?"port":(\d+)/.exec(fs.readFileSync(logFile, 'utf8'))![1],
    );
    // wait until all three sessions have registered a token
    const tokens = await poll(() => {
      const t = findTokens(a.home);
      return t.size >= 3 ? t : null;
    });

    // live session id -> card title, straight from the app (the same mapping
    // the Events panel uses to name a row)
    const cards = (await w.evaluate(() => window.switchboard.sessions.cards())) as Array<{
      title: string;
      liveId?: string;
    }>;
    const titleFor = new Map<string, string>();
    for (const c of cards) if (c.liveId) titleFor.set(c.liveId, c.title);

    const post = async (title: string, body: Record<string, unknown>): Promise<string> => {
      const sid = [...tokens.keys()].find((k) => titleFor.get(k) === title);
      if (!sid) throw new Error(`no live session for card "${title}"`);
      const r = await fetch(`http://127.0.0.1:${port}/hook`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-switchboard-token': tokens.get(sid)! },
        body: JSON.stringify(body),
      });
      return r.text();
    };

    // creation order 0,1,2 -> priority order 1,2,0. If the queue ever falls
    // back to rail order or arrival order, these assertions break.
    const titles = { done: names[0], permission: names[1], input: names[2] };
    await post(titles.done, { hook_event_name: 'Stop' });
    await post(titles.permission, {
      hook_event_name: 'Notification',
      message: 'Claude needs your permission to use Bash',
    });
    await post(titles.input, {
      hook_event_name: 'Notification',
      message: 'Claude needs input to continue',
    });
    await expect(eventRows(w)).toHaveCount(3, { timeout: 15_000 });
    return { w, post, titles };
  }

  test('the panel lists the queue in priority order, not arrival order', async () => {
    const { w } = await threeWaitingSessions();
    await expect
      .poll(() => eventRows(w).evaluateAll((els) => els.map((e) => e.getAttribute('data-event-kind'))))
      .toEqual(['needs-permission', 'needs-input', 'done']);
    // the head is marked as where the hotkey goes
    await expect(w.locator('aside [data-next="true"]')).toHaveCount(1);
    await expect(w.locator('aside [data-next="true"]')).toHaveAttribute(
      'data-event-kind',
      'needs-permission',
    );
  });

  test('three sessions in different states clear in priority order under repeated Ctrl+Space', async () => {
    const { w, titles } = await threeWaitingSessions();
    // focus something that is NOT first in the queue, so the first press has
    // to actually move
    await w.keyboard.press(`${MOD}+1`);
    await expect(activeTab(w)).toContainText(titles.done);

    const marked = w.locator('aside [data-next="true"]');
    await w.keyboard.press(`${MOD}+Space`);
    await expect(activeTab(w)).toContainText(titles.permission);
    // the panel's marker MOVES with the walk — from press 2 on, a marker that
    // stayed on the head would be pointing at a row the hotkey has left behind
    await expect(marked).toHaveAttribute('data-event-kind', 'needs-input');

    await w.keyboard.press(`${MOD}+Space`);
    await expect(activeTab(w)).toContainText(titles.input);
    await expect(marked).toHaveAttribute('data-event-kind', 'done');

    await w.keyboard.press(`${MOD}+Space`);
    await expect(activeTab(w)).toContainText(titles.done);
    // ...and the walk wraps rather than dead-ending
    await w.keyboard.press(`${MOD}+Space`);
    await expect(activeTab(w)).toContainText(titles.permission);
  });

  test('an answered item leaves the queue', async () => {
    const { w, post, titles } = await threeWaitingSessions();
    // the human answers the permission: the session goes back to work, which
    // is not an attention state, so the feed drops its item
    await post(titles.permission, { hook_event_name: 'UserPromptSubmit' });
    await expect(eventRows(w)).toHaveCount(2, { timeout: 15_000 });
    await expect
      .poll(() => eventRows(w).evaluateAll((els) => els.map((e) => e.getAttribute('data-event-kind'))))
      .toEqual(['needs-input', 'done']);

    // and the hotkey now goes to what is actually still waiting
    await w.keyboard.press(`${MOD}+1`);
    await expect(activeTab(w)).toContainText(titles.done);
    await w.keyboard.press(`${MOD}+Space`);
    await expect(activeTab(w)).toContainText(titles.input);
  });

  test('Ctrl+Space is a no-op when nothing is waiting', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    const title = path.basename(folder);
    await expect(w.getByText(title).first()).toBeVisible({ timeout: 25_000 });
    await expect(eventRows(w)).toHaveCount(0);

    await w.keyboard.press(`${MOD}+Space`);
    // nothing moved, nothing broke, and no page error was thrown
    await expect(activeTab(w)).toContainText(title);
    await expect(eventRows(w)).toHaveCount(0);
  });

  test('the TERMINAL owns Ctrl+Space — it is a real keystroke there (the hard rule)', async () => {
    // the terminal branch of classifyTarget is the one NO scope can override,
    // and it is a different code path from the text-input branch below
    const { w, titles } = await threeWaitingSessions();
    await w.keyboard.press(`${MOD}+1`);
    await expect(activeTab(w)).toContainText(titles.done);

    await showTerminal(w);
    await w.locator('.xterm-screen').first().click();
    await w.keyboard.press(`${MOD}+Space`);
    await expect(activeTab(w)).toContainText(titles.done); // never jumped
  });

  test('the composer owns Ctrl+Space too — a text input keeps its keys', async () => {
    const { w, titles } = await threeWaitingSessions();
    await w.keyboard.press(`${MOD}+1`);
    await expect(activeTab(w)).toContainText(titles.done);

    const composer = w.getByPlaceholder(/Prompt this session/);
    await composer.click();
    await w.keyboard.press(`${MOD}+Space`);
    await expect(activeTab(w)).toContainText(titles.done); // did not jump
    expect(await w.evaluate(() => document.activeElement?.tagName)).toBe('TEXTAREA');
  });
});
