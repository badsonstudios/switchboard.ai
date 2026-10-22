// Which AI a session is on, at a glance (E40 item 10, #1293) — in the real app.
//
// A MIXED workspace: one card on the fake ACP agent, one on the fake Claude
// stream, side by side. `SWITCHBOARD_FAKE_PROVIDER=acp` registers the fake ACP
// agent FIRST, so the seeded card is on it (the default AI is the first
// registered); the default is then set to `claude-code` and a second session
// added, which is on the Claude fake.
//
// What only the real app can show:
//   - the rail card, the tab and the header each draw the RIGHT AI's icon, by
//     name, for both sessions at once;
//   - the ring follows the session's status through the real status machine
//     (working → needs you → back), and the state word stays beside it;
//   - the status bar names both AIs with their versions, on one line, at the
//     narrowest width CI runs (1280px).
import { test, expect, Page, Locator } from '@playwright/test';
import path from 'path';
import { launchApp, LaunchedApp } from './fixtures/app';
import { tempProjectFolder, teardown } from './fixtures/stream-session';

test.afterAll(async () => teardown());

const row = (w: Page, title: string): Locator =>
  w.locator('nav .rail-row').filter({ has: w.locator('[data-rail-title]', { hasText: title }) });
const tab = (w: Page, title: string): Locator =>
  w.locator('.dv-tab .identity-tab').filter({ hasText: title });
/** the header of the card whose tab is the open one in its group */
const header = (w: Page, title: string): Locator =>
  w
    .locator('.dv-groupview')
    .filter({ has: w.locator('.dv-tab.dv-active-tab', { hasText: title }) })
    .locator('[data-testid="card-header"]');

async function send(w: Page, text: string): Promise<void> {
  const box = w.getByPlaceholder(/^Message .+…$/);
  await box.click();
  await box.fill(text);
  await box.press('Enter');
}

test.describe('the AI icon with a status ring (#1293)', () => {
  let a: LaunchedApp | undefined;
  test.afterEach(async () => {
    const launched = a;
    a = undefined; // cleared BEFORE the close — see `teardown`
    await teardown(launched);
  });

  test('a mixed Claude + ACP workspace: right icon everywhere, ring follows status, both AIs on the bar', async () => {
    test.setTimeout(150_000);
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder, env: { SWITCHBOARD_FAKE_PROVIDER: 'acp' } });
    const w = a.window;
    const acp = path.basename(folder);
    await expect(row(w, acp)).toBeVisible({ timeout: 25_000 });

    // ── 1. The seeded card is on the fake ACP agent, on all three surfaces ──
    const acpRowBadge = row(w, acp).locator('.ai-badge');
    await expect(acpRowBadge).toHaveAttribute('data-ai-badge', 'fake-acp', { timeout: 25_000 });
    await expect(acpRowBadge).toHaveAttribute('aria-label', /^Fake ACP, /);
    await expect(tab(w, acp).locator('.ai-badge')).toHaveAttribute('data-ai-name', 'Fake ACP');
    await expect(header(w, acp).locator('.ai-badge')).toHaveAttribute('aria-label', /^Fake ACP, /);
    // no catalog icon for a test fake: the neutral glyph with its initial
    await expect(acpRowBadge.locator('[data-ai-icon="initial"]')).toHaveAttribute('data-initial', 'F');

    // ── 2. The ring follows the status machine ─────────────────────────────
    // working: the rail's ring spins (as its mark always did), and so does the
    // tab's since #1351 (it stood still until then); the state word says it
    await send(w, '!cancel-slow');
    await expect(w.getByText(/tick 3/)).toBeVisible({ timeout: 30_000 });
    await expect(acpRowBadge).toHaveAttribute('data-ring', 'working', { timeout: 15_000 });
    await expect(acpRowBadge).toHaveAttribute('data-ring-spin', 'true');
    await expect(acpRowBadge).toHaveAttribute('aria-label', 'Fake ACP, working');
    await expect(row(w, acp).locator('[data-rail-state]')).toHaveText('working');
    const acpTabBadge = tab(w, acp).locator('.ai-badge');
    await expect(acpTabBadge).toHaveAttribute('data-ring', 'working');
    await expect(acpTabBadge).toHaveAttribute('data-ring-spin', 'true');
    await w
      .getByTitle(/interrupts the current turn/i)
      .first()
      .click();
    await expect(acpRowBadge).not.toHaveAttribute('data-ring', 'working', { timeout: 30_000 });

    // needs you: the fake's `!ask` raises a permission request
    await send(w, '!ask');
    await expect(w.locator('[data-approval-bar]')).toBeVisible({ timeout: 30_000 });
    await expect(acpRowBadge).toHaveAttribute('data-ring', 'needs-permission', { timeout: 15_000 });
    await expect(acpRowBadge).toHaveAttribute('aria-label', 'Fake ACP, approval');
    await expect(row(w, acp).locator('[data-rail-state]')).toHaveText(/^approval( · <\d+[ms])?$/);
    await expect(acpTabBadge).toHaveAttribute('data-ring', 'needs-permission');
    await expect(header(w, acp).locator('.ai-badge')).toHaveAttribute('data-ring', 'needs-permission');
    // the header still says it in a word, too
    await expect(header(w, acp).locator('.status-pill')).toHaveText('approval');
    await w.getByRole('button', { name: 'Allow', exact: true }).click();
    await expect(w.getByText('ASK ALLOWED')).toBeVisible({ timeout: 30_000 });
    await expect(acpRowBadge).not.toHaveAttribute('data-ring', 'needs-permission', { timeout: 15_000 });

    // ── 3. A second session, on Claude (the fake stream) ───────────────────
    const set = await w.evaluate(() =>
      (
        window as unknown as {
          switchboard: { ais: { setDefault: (id: string) => Promise<{ ok: boolean }> } };
        }
      ).switchboard.ais.setDefault('claude-code')
    );
    expect(set.ok).toBe(true);
    const dir = tempProjectFolder();
    await a.app.evaluate(({ dialog }, d) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [d] });
    }, dir);
    await w.getByRole('button', { name: '+ session' }).click();
    const claude = path.basename(dir);
    await expect(row(w, claude)).toBeVisible({ timeout: 25_000 });

    const claudeRowBadge = row(w, claude).locator('.ai-badge');
    await expect(claudeRowBadge).toHaveAttribute('data-ai-badge', 'claude-code', { timeout: 25_000 });
    await expect(claudeRowBadge).toHaveAttribute('aria-label', /^Claude Code, /);
    // the catalog's own icon, from the renderer's origin, and it LOADED — as a
    // mask now (#1326), so it is checked by loading the same URL beside it
    const icon = claudeRowBadge.locator('[data-ai-icon="mask"]');
    await expect(icon).toHaveAttribute('data-ai-icon-src', /ai-icons\/claude-code\.svg$/);
    const loaded = await icon.evaluate(
      (el) =>
        new Promise<boolean>((resolve) => {
          const probe = new Image();
          probe.onload = () => resolve(probe.naturalWidth > 0);
          probe.onerror = () => resolve(false);
          probe.src = el.getAttribute('data-ai-icon-src') ?? '';
        })
    );
    expect(loaded, 'the icon file is served').toBe(true);

    // ── 3b. ...and it is painted in CLAUDE'S colour, not black (#1326) ──────
    // The browser's answer for the colour, then the screen's: pixels of the
    // icon as Chromium drew them, read from a capture of the window. A mask
    // whose image failed would paint nothing; an <img> of the file painted
    // black. Either fails here.
    const paint = await icon.evaluate((el) => ({
      bg: getComputedStyle(el).backgroundColor,
      mask: getComputedStyle(el).maskImage,
      ink: getComputedStyle(document.documentElement).getPropertyValue('--ai-claude-code-ink').trim(),
    }));
    expect(paint.mask).toContain('ai-icons/claude-code.svg');
    const inkRgb = [1, 3, 5].map((i) => parseInt(paint.ink.slice(i, i + 2), 16));
    expect(paint.bg).toBe(`rgb(${inkRgb.join(', ')})`);
    const box = (await icon.boundingBox())!;
    const pixels = await a.app.evaluate(async ({ BrowserWindow }, r) => {
      const win = BrowserWindow.getAllWindows()[0];
      const shot = await win.webContents.capturePage({
        x: Math.floor(r.x),
        y: Math.floor(r.y),
        width: Math.ceil(r.width),
        height: Math.ceil(r.height),
      });
      const bmp = shot.toBitmap(); // BGRA
      const out: number[][] = [];
      for (let i = 0; i + 3 < bmp.length; i += 4) out.push([bmp[i + 2], bmp[i + 1], bmp[i]]);
      return out;
    }, box);
    const near = pixels.filter((p) => p.every((v, i) => Math.abs(v - inkRgb[i]) <= 24)).length;
    expect(near, `pixels of the icon in Claude's ink ${paint.ink}, of ${pixels.length}`).toBeGreaterThan(3);
    await expect(tab(w, claude).locator('.ai-badge')).toHaveAttribute('data-ai-name', 'Claude Code');
    await w.locator('.dv-tab', { hasText: claude }).first().click();
    await expect(header(w, claude).locator('.ai-badge')).toHaveAttribute('aria-label', /^Claude Code, /);
    // ...and the first card is still on its own AI
    await expect(acpRowBadge).toHaveAttribute('aria-label', /^Fake ACP, /);
    await expect(tab(w, acp).locator('.ai-badge')).toHaveAttribute('data-ai-name', 'Fake ACP');

    // ── 4. The status bar names both AIs, Claude first, on one line ────────
    const readout = w.getByTestId('status-ais');
    await expect(readout).toContainText('Claude Code 0.0.0', { timeout: 25_000 });
    await expect(readout).toContainText('Fake ACP 0.0.0');
    const order = await readout.locator('[data-status-ai]').evaluateAll((els) =>
      els.map((e) => e.getAttribute('data-status-ai'))
    );
    // Claude first, and the fake ACP agent listed. NOT an exact list: a catalog
    // AI with no provider here is found by its program on PATH (#1291), so
    // what else appears depends on the machine (Codex's is `npx`).
    expect(order[0]).toBe('claude-code');
    expect(order).toContain('fake-acp');

    // at 1280px (CI's narrowest): the bar is one row and nothing spills. A flex
    // row's scrollWidth hides its headroom, so the CHILDREN are summed.
    await a.app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      win.unmaximize();
      win.setContentSize(1280, win.getContentSize()[1]);
    });
    await expect.poll(() => w.evaluate(() => window.innerWidth), { timeout: 10_000 }).toBeLessThanOrEqual(1288);
    const fit = await readout.evaluate((el) => {
      const bar = el.closest('footer')!;
      // every child but the bar's own `flex: 1` spacer, which soaks up the
      // slack and would make the sum equal the width by construction
      const kids = ([...bar.children] as HTMLElement[]).filter((k) => k.style.flexGrow !== '1');
      const box = bar.getBoundingClientRect();
      return {
        sum: kids.reduce((n, k) => n + k.getBoundingClientRect().width, 0),
        width: bar.clientWidth,
        // every item inside the bar's own height: nothing wrapped below it
        inside: kids.every((k) => {
          const r = k.getBoundingClientRect();
          return r.top >= box.top - 1 && r.bottom <= box.bottom + 1;
        }),
        clipped: el.scrollWidth > el.clientWidth + 1,
      };
    });
    expect(fit.inside).toBe(true);
    expect(fit.sum).toBeLessThanOrEqual(fit.width + 1);
    expect(fit.clipped, 'both AIs fit at 1280px without the ellipsis').toBe(false);
    await expect(readout).toHaveAttribute('title', /^AIs on this computer: Claude Code 0\.0\.0, .*Fake ACP 0\.0\.0/);
  });
});
