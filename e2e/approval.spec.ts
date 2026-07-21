// P2-E10-04: inline approval bar — the full loop against the REAL hook
// listener: the test plays the CLI's part (PreToolUse POST with the real
// per-session token), the UI answers, the verdict comes back in the hook
// response. No mocks between the bar and the wire.
import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { launchApp, LaunchedApp, tempProjectFolder } from './fixtures/app';

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

test.describe('inline approval bar (E10-04)', () => {
  let a: LaunchedApp;
  test.afterEach(async () => a?.cleanup());

  test('held Edit -> Allow / Allow-all round-trips real hook verdicts', async () => {
    const folder = tempProjectFolder();
    const title = folder.split(/[\\/]/).pop()!;
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    await expect(w.getByText(title).first()).toBeVisible({ timeout: 25_000 });

    // the CLI's view of the world: listener port from the app log, the
    // per-session token from the state dir (both created by the real spawn)
    const logFile = await poll(() => {
      const f = findFile(a.home, 'switchboard.log');
      return f && fs.readFileSync(f, 'utf8').includes('hook listener up') ? f : null;
    });
    const port = Number(/"msg":"hook listener up".*?"port":(\d+)/.exec(fs.readFileSync(logFile, 'utf8'))![1]);
    const tokenFile = await poll(() => findFile(a.home, 'hook-token'));
    const token = fs.readFileSync(tokenFile, 'utf8').trim();

    const preToolUse = (marker: string) =>
      fetch(`http://127.0.0.1:${port}/hook`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-switchboard-token': token },
        body: JSON.stringify({
          hook_event_name: 'PreToolUse',
          tool_name: 'Edit',
          tool_input: { file_path: 'C:/proj/x.ts', old_string: `old-${marker}`, new_string: `new-${marker}` },
        }),
      }).then((r) => r.text());

    // 1. held request -> bar appears with the edit preview -> Allow
    const p1 = preToolUse('one');
    await expect(w.getByText('Allow Edit?')).toBeVisible({ timeout: 10_000 });
    await expect(w.getByText('new-one')).toBeVisible(); // new_string pane
    await w.getByRole('button', { name: 'Allow', exact: true }).click();
    expect(JSON.parse(await p1).hookSpecificOutput.permissionDecision).toBe('allow');
    await expect(w.getByText('Allow Edit?')).toHaveCount(0);

    // 2. next request -> "Allow all (this session)"
    const p2 = preToolUse('two');
    await expect(w.getByText('Allow Edit?')).toBeVisible({ timeout: 10_000 });
    await w.getByRole('button', { name: 'Allow all (this session)' }).click();
    expect(JSON.parse(await p2).hookSpecificOutput.permissionDecision).toBe('allow');

    // 3. third request auto-allows WITHOUT the bar ever appearing
    const p3 = preToolUse('three');
    expect(JSON.parse(await p3).hookSpecificOutput.permissionDecision).toBe('allow');
    await expect(w.getByText('Allow Edit?')).toHaveCount(0);
  });

  test('Deny returns a deny verdict', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    await expect(w.getByText(folder.split(/[\\/]/).pop()!).first()).toBeVisible({ timeout: 25_000 });
    const logFile = await poll(() => {
      const f = findFile(a.home, 'switchboard.log');
      return f && fs.readFileSync(f, 'utf8').includes('hook listener up') ? f : null;
    });
    const port = Number(/"msg":"hook listener up".*?"port":(\d+)/.exec(fs.readFileSync(logFile, 'utf8'))![1]);
    const tokenFile = await poll(() => findFile(a.home, 'hook-token'));
    const token = fs.readFileSync(tokenFile, 'utf8').trim();

    const pending = fetch(`http://127.0.0.1:${port}/hook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-switchboard-token': token },
      body: JSON.stringify({
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'rm -rf /' },
      }),
    }).then((r) => r.text());
    await expect(w.getByText('Allow Bash?')).toBeVisible({ timeout: 10_000 });
    await expect(w.getByText('rm -rf /').first()).toBeVisible(); // command preview
    await w.getByRole('button', { name: 'Deny' }).click();
    expect(JSON.parse(await pending).hookSpecificOutput.permissionDecision).toBe('deny');
  });
});
