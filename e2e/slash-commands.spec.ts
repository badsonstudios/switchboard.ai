// P2-E10-07: composer slash-command autocomplete + ⋯ session controls.
// The popup data comes from the REAL scanner (this test seeds command/skill
// files into the session folder) and selection/submission go through the real
// PTY — the fake provider's shell echoes what the composer typed.
import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { launchApp, LaunchedApp, showTerminal, tempProjectFolder } from './fixtures/app';

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

async function poll<T>(fn: () => T | null, timeoutMs = 20_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error('poll timed out');
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** Play the CLI's part: POST a hook event to the app's real listener. */
async function postHook(home: string, body: Record<string, unknown>): Promise<string> {
  const logFile = await poll(() => {
    const f = findFile(home, 'switchboard.log');
    return f && fs.readFileSync(f, 'utf8').includes('hook listener up') ? f : null;
  });
  const port = Number(/"msg":"hook listener up".*?"port":(\d+)/.exec(fs.readFileSync(logFile, 'utf8'))![1]);
  const tokenFile = await poll(() => findFile(home, 'hook-token'));
  const token = fs.readFileSync(tokenFile, 'utf8').trim();
  const r = await fetch(`http://127.0.0.1:${port}/hook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-switchboard-token': token },
    body: JSON.stringify(body),
  });
  return r.text();
}

function seedProjectCommands(folder: string): void {
  fs.mkdirSync(path.join(folder, '.claude', 'commands'), { recursive: true });
  fs.writeFileSync(
    path.join(folder, '.claude', 'commands', 'hello.md'),
    '---\ndescription: Say hello nicely\n---\nSay hello.\n'
  );
  fs.mkdirSync(path.join(folder, '.claude', 'skills', 'demo'), { recursive: true });
  fs.writeFileSync(
    path.join(folder, '.claude', 'skills', 'demo', 'SKILL.md'),
    '---\nname: demo\ndescription: Demo skill\n---\nDo the demo.\n'
  );
}

test.describe('composer slash commands (E10-07)', () => {
  let a: LaunchedApp;
  test.afterEach(async () => a?.cleanup());

  test('/ pops builtins + scanned project commands; arrows+Enter insert; submit reaches the PTY', async () => {
    const folder = tempProjectFolder();
    seedProjectCommands(folder);
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    await expect(w.getByText(folder.split(/[\\/]/).pop()!).first()).toBeVisible({ timeout: 25_000 });

    const box = w.getByPlaceholder(/Prompt this session/);
    await box.click();
    await box.pressSequentially('/');
    // builtin + project command + project skill, with descriptions and badges
    await expect(w.getByText('/clear', { exact: true })).toBeVisible();
    await expect(w.getByText('/hello', { exact: true })).toBeVisible();
    await expect(w.getByText('/demo', { exact: true })).toBeVisible();
    await expect(w.getByText('Say hello nicely')).toBeVisible();

    // arrow keys move the highlight (list is clear · compact · demo · hello),
    // and Enter picks the highlighted command — it INSERTS, never submits
    await box.press('ArrowDown');
    await box.press('Enter');
    await expect(box).toHaveValue('/compact ');
    await expect(w.getByText('Say hello nicely')).toHaveCount(0); // popup closed

    // typing filters the list down (prefix match on the new token)
    await box.fill('');
    await box.pressSequentially('/he');
    await expect(w.getByText('/clear', { exact: true })).toHaveCount(0);
    await expect(w.getByText('/hello', { exact: true })).toBeVisible();
    await box.press('Enter');
    await expect(box).toHaveValue('/hello ');

    // a second Enter submits to the real PTY — the shell echoes the text
    await box.press('Enter');
    await expect(box).toHaveValue('');
    await showTerminal(w);
    await expect(w.getByText(/\/hello/).first()).toBeVisible({ timeout: 15_000 });
  });

  test('no popup when the slash is mid-sentence; Escape dismisses', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    await expect(w.getByText(folder.split(/[\\/]/).pop()!).first()).toBeVisible({ timeout: 25_000 });

    const box = w.getByPlaceholder(/Prompt this session/);
    await box.click();
    await box.pressSequentially('look in c:/');
    await expect(w.getByText('/clear', { exact: true })).toHaveCount(0);

    await box.fill('');
    await box.pressSequentially('/');
    await expect(w.getByText('/clear', { exact: true })).toBeVisible();
    await box.press('Escape');
    await expect(w.getByText('/clear', { exact: true })).toHaveCount(0);
    await expect(box).toHaveValue('/'); // the draft survives the dismiss
  });

  test('⋯ menu: Clear conversation confirms, then types /clear into the PTY', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    await expect(w.getByText(folder.split(/[\\/]/).pop()!).first()).toBeVisible({ timeout: 25_000 });

    // controls are LOCKED while 'starting' (§5.10 startup-dialog rule)
    await w.getByTitle('Session menu').click();
    const clear = w.getByRole('button', { name: 'Clear conversation' });
    await expect(clear).toBeDisabled();

    // the session reports ready — play the CLI: SessionStart over real hooks.
    // The menu stays open and unlocks live on the status change.
    await postHook(a.home, { hook_event_name: 'SessionStart', source: 'startup' });
    await expect(clear).toBeEnabled({ timeout: 10_000 });
    await clear.click();
    await expect(w.getByText(/Clear this conversation\?/)).toBeVisible();
    await w.getByRole('button', { name: 'Clear', exact: true }).click();

    await showTerminal(w);
    await expect(w.getByText(/\/clear/).first()).toBeVisible({ timeout: 15_000 });
  });
});
