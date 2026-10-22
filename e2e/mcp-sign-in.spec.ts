// MCP sign-in opens the browser FROM MAIN, at the address Claude Code hands
// back (#1420) — and a long server name no longer runs under its status word.
//
// THE BUG: in the transport we host, Claude Code does not open a browser for an
// MCP sign-in. Its `mcp_authenticate` answer carries `authUrl` and the HOST is
// expected to open it (the PATH CLI 2.1.288 handler and the VS Code extension
// 2.1.289 agree; quoted in `src/main/mcp/sign-in.ts`). #734 dropped that
// payload, so Dan's clicks on the Atlassian server were accepted and nothing
// opened.
//
// THE FAKE ANSWERS IN THE REAL SHAPES, opt-in through `SWITCHBOARD_FAKE_MCP`
// (see `FakeMcpScript`). `shell.openExternal` is REPLACED in main, as
// `feed.spec.ts` does for links: the real one would launch this machine's
// browser, and CI has no business doing that.
import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { launchApp, LaunchedApp, tempProjectFolder } from './fixtures/app';

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

// The name from Dan's screenshot, plus a tail so the row is long on every
// runner's font (Linux CI fonts run ~5% wider than Windows).
// Long enough to overflow the row on any window this suite opens, so the clip
// is really exercised (the assertion below checks that it was).
const LONG = 'plugin:atlassian:atlassian-workspace-connector-for-the-very-long-namespaced-plugin-server-name-case';
const AUTH_URL = 'https://auth.example.test/authorize?client_id=fake&state=fake-state';

function mcpScript(): Record<string, unknown> {
  return {
    status: [
      {
        name: LONG,
        status: 'needs-auth',
        scope: 'dynamic',
        config: { type: 'http', url: 'https://mcp.example.test/v1/mcp' },
      },
    ],
    authenticate: {
      [LONG]: {
        authUrl: AUTH_URL,
        requiresUserAction: true,
        callbackExpected: true,
        redirectScheme: 'localhost',
        state: 'fake-state',
        callbackPort: 53682,
      },
    },
  };
}

test.describe('MCP sign-in (#1420)', () => {
  let a: LaunchedApp;

  test.afterEach(async () => {
    await a?.close();
  });

  test('Sign in opens the browser at the address Claude Code answered, from main; the name never runs under the status word', async () => {
    const folder = tempProjectFolder();
    const mcpFile = path.join(folder, 'fake-mcp.json');
    fs.writeFileSync(mcpFile, JSON.stringify(mcpScript()), 'utf8');
    a = await launchApp({
      seedFolder: folder,
      env: { SWITCHBOARD_FAKE_PROVIDER: 'stream', SWITCHBOARD_FAKE_MCP: mcpFile },
    });
    const w = a.window;
    await expect(w.getByPlaceholder(/^Message .+…$/)).toBeVisible({ timeout: 25_000 });

    const opened = async (): Promise<string[]> =>
      a.app.evaluate(() => (globalThis as unknown as { __opened?: string[] }).__opened ?? []);
    await a.app.evaluate(({ shell }) => {
      const g = globalThis as unknown as { __opened: string[] };
      g.__opened = [];
      // `defineProperty`, not assignment: electron's module members are getters
      Object.defineProperty(shell, 'openExternal', {
        configurable: true,
        value: (url: string): Promise<void> => {
          g.__opened.push(url);
          return Promise.resolve();
        },
      });
    });

    await w.keyboard.press(`${MOD}+Shift+P`);
    await expect(w.getByRole('dialog', { name: 'Command palette' })).toBeVisible();
    await w.keyboard.type('MCP servers');
    await w.keyboard.press('Enter');
    const mcp = w.locator('[data-testid="mcp-manager"]');
    await expect(mcp).toBeVisible({ timeout: 15_000 });
    const row = mcp.locator(`[data-mcp-server="${LONG}"]`);
    await expect(row).toBeVisible({ timeout: 20_000 });
    await expect(row).toContainText('needs sign-in');

    // ── Part 2: the status word sits AFTER the name, never on top of it ──────
    const name = row.locator('[data-mcp-name]');
    await expect(name).toHaveAttribute('title', LONG);
    // The BOX's right edge alone proves nothing: the old layout's box stopped at
    // its cell too, and the TEXT ran out of it. So the claim is "the box stops
    // before the status word AND nothing paints past the box": either the text
    // fits, or the box clips it.
    const geometry = await row.evaluate((el) => {
      const n = el.querySelector<HTMLElement>('[data-mcp-name]')!;
      const status = n.parentElement!.nextElementSibling as HTMLElement;
      return {
        nameRight: n.getBoundingClientRect().right,
        statusLeft: status.getBoundingClientRect().left,
        overflows: n.scrollWidth > n.clientWidth,
        clips: getComputedStyle(n).overflowX === 'hidden',
      };
    });
    expect(geometry.nameRight).toBeLessThanOrEqual(geometry.statusLeft);
    expect(geometry.overflows).toBe(true);
    expect(geometry.clips).toBe(true);

    // ── Part 1: Sign in → main opens exactly the address the CLI answered ───
    await row.getByRole('button', { name: 'Sign in' }).click();
    await expect.poll(opened, { timeout: 10_000 }).toEqual([AUTH_URL]);
    await expect(mcp).toContainText('a browser window was opened');
    // the address stays in main: the pane never shows it
    await expect(mcp).not.toContainText('auth.example.test');
  });
});
