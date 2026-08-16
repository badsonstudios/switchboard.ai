// P2-E14-05b — quiet hours, end to end, in a real window.
//
// The unit tests own the matrix (clock × action audience × per-rule override,
// in `src/main/events/rules.quiet.test.ts`). What only a real app can show is
// the DECISION this item was asked to make, joined all the way up:
//
//   inside a quiet window, one person-facing channel is held and one
//   machine-facing channel is delivered — from the same event, in the same
//   millisecond, under the same rule engine.
//
// The toast is asserted through the app LOG (the house pattern — `rules.spec`,
// `approval.spec`), because the line is written by the action handler itself,
// so its ABSENCE means the handler was never reached rather than that a popup
// happened to be off-screen. The webhook is asserted on the WIRE, against a
// loopback stub, which is `push.spec.ts`'s shape: nothing here reaches the
// internet.
//
// **No audio is played by anything in this file** — `launchApp` sets
// SWITCHBOARD_MUTE_AUDIO=1 and nothing here undoes it. Per-session cues are
// left off anyway; the channels under test are the toast and the webhook.
import { test, expect, Page } from '@playwright/test';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { AddressInfo } from 'net';
import {
  findFile,
  hookPoster,
  launchApp,
  LaunchedApp,
  poll,
  tempProjectFolder,
  workspaceJsonPath,
} from './fixtures/app';

/** Whatever the app POSTed at us, in arrival order. */
class StubHook {
  private server: http.Server | null = null;
  url = '';
  received: Array<Record<string, unknown>> = [];

  async start(): Promise<void> {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += String(c)));
      req.on('end', () => {
        try {
          this.received.push(JSON.parse(body) as Record<string, unknown>);
        } catch {
          this.received.push({ unparseable: body });
        }
        res.writeHead(204).end();
      });
    });
    this.server = server;
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
  }

  async stop(): Promise<void> {
    const s = this.server;
    this.server = null;
    if (s) await new Promise<void>((r) => s.close(() => r()));
  }
}

interface RulesLine {
  kind: string;
  quiet: boolean;
  held: string;
  ran: number;
  rules: string;
}

/** every "notification rules fired" line so far — the engine's own verdict */
function firings(home: string): RulesLine[] {
  const f = findFile(home, 'switchboard.log');
  if (!f) return [];
  return fs
    .readFileSync(f, 'utf8')
    .split('\n')
    .filter((l) => l.includes('"notification rules fired"'))
    .map((l) => JSON.parse(l) as RulesLine);
}

/** …and every line the toast handler itself wrote. Absence is the assertion. */
function toastLines(home: string): number {
  const f = findFile(home, 'switchboard.log');
  if (!f) return 0;
  return fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.includes('"os toast rule fired"'))
    .length;
}

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';
const quietDialog = (w: Page) => w.getByRole('dialog', { name: 'Quiet hours' });
const quietField = (w: Page, name: string) => w.locator(`[data-quiet-field="${name}"]`);

/** Open a palette-only dialog the way a user with no chord for it would. */
async function openFromPalette(w: Page, filter: string, commandId: string): Promise<void> {
  await w.keyboard.press(`${MOD}+Shift+P`);
  await w.getByPlaceholder('Type a command or a session name…').fill(filter);
  await w.locator(`[id="palette-row-${commandId}"]`).click();
}

/**
 * A window that is open RIGHT NOW, computed from the app's own local clock.
 *
 * Two hours wide and centred on the present, rather than `00:00`–`23:59`:
 * that pair leaves a one-minute hole at 23:59 and would make this spec fail
 * once a day for reasons nobody would ever reproduce. Read from the RENDERER's
 * Date so it is the same machine clock main will evaluate against — computing
 * it in the Playwright process would be a second clock, which is exactly the
 * mistake this item spent its design budget avoiding.
 */
async function windowAroundNow(w: Page): Promise<{ start: string; end: string }> {
  return w.evaluate(() => {
    const hhmm = (d: Date): string =>
      `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const now = Date.now();
    return { start: hhmm(new Date(now - 3600_000)), end: hhmm(new Date(now + 3600_000)) };
  });
}

test.describe('quiet hours (P2-E14-05b)', () => {
  let a: LaunchedApp;
  const stub = new StubHook();
  test.beforeAll(async () => stub.start());
  test.afterAll(async () => stub.stop());
  test.afterEach(async () => a?.cleanup());

  test('inside the window a toast is held and the webhook still goes out', async () => {
    const folder = tempProjectFolder();
    const name = path.basename(folder);
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    await expect(w.getByText(name).first()).toBeVisible({ timeout: 25_000 });

    // ── the webhook half: point it at the loopback stub ──────────────────────
    await openFromPalette(w, 'phone push', 'attention.pushSetup');
    await expect(w.getByRole('dialog', { name: 'Phone push & webhooks' })).toBeVisible();
    const url = w.locator('[data-push-field="webhook.url"]');
    // Whether this machine can keep a secret is an ENVIRONMENT fact (#421's
    // `shown` lesson). Windows always has DPAPI, so there the skip below is not
    // allowed to be the branch that runs — otherwise this spec could go green
    // by skipping its own point.
    const canStoreSecrets = await url.isEnabled();
    if (process.platform === 'win32') expect(canStoreSecrets).toBe(true);
    if (!canStoreSecrets) {
      test.info().annotations.push({ type: 'note', description: 'no OS credential store here' });
      test.skip();
      return;
    }
    await url.fill(stub.url);
    await url.press('Enter');
    await expect(w.locator('[data-push-status="webhook.url"]')).toHaveText('· saved');
    await w.locator('[data-push-field="enable-webhook"]').click();
    await expect(w.locator('[data-push-field="enable-webhook"]')).toBeChecked();
    await w.keyboard.press('Escape');

    // ── the toast half: switch OS toasts on ─────────────────────────────────
    await w.evaluate(() =>
      window.switchboard.notifications.setPrefs({ enabled: true, osToasts: true })
    );

    // ── the window: two hours wide, centred on right now ────────────────────
    const win = await windowAroundNow(w);
    await openFromPalette(w, 'quiet hours', 'attention.quietHours');
    await expect(quietDialog(w)).toBeVisible();
    await quietField(w, 'start').fill(win.start);
    await quietField(w, 'end').fill(win.end);
    await quietField(w, 'enabled').click();
    await expect(quietField(w, 'enabled')).toBeChecked();
    // Main's own answer that the window is open — asserted rather than assumed,
    // because every assertion below is about what happens INSIDE it. A spec
    // that silenced nothing because its window was misread would still "pass"
    // its absence checks.
    await expect(w.locator('[data-quiet-status]')).toContainText('on right now', {
      timeout: 10_000,
    });
    await w.keyboard.press('Escape');
    await expect(quietDialog(w)).toHaveCount(0);

    // The user looks away, so the toast rule's visibility condition is met and
    // the ONLY thing left that could hold it is quiet hours.
    await a.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].blur());
    await expect
      .poll(
        () => a.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFocused()),
        { timeout: 15_000 }
      )
      .toBe(false);

    const toastsBefore = toastLines(a.home);
    const post = await hookPoster(a);
    await post(name, {
      hook_event_name: 'Notification',
      message: 'Claude needs your permission to use Bash',
    });

    // ── the webhook ARRIVED ─────────────────────────────────────────────────
    const delivered = await poll(
      () => stub.received.find((r) => r.event === 'needs-permission') ?? null,
      20_000
    );
    expect(delivered).toMatchObject({ source: 'switchboard.ai', version: 1 });

    // ── and the engine says it held the toast ───────────────────────────────
    const fired = await poll(() => {
      const lines = firings(a.home).filter((l) => l.kind === 'needs-permission');
      return lines.length > 0 ? lines[lines.length - 1] : null;
    }, 20_000);
    expect(fired.quiet).toBe(true);
    expect(fired.held.split(',')).toContain('os-toast');
    expect(fired.held.split(',')).not.toContain('webhook');
    expect(fired.rules).toContain('webhook');

    // ── the toast handler was never reached ─────────────────────────────────
    // Not "no popup appeared" — the handler writes its line unconditionally, so
    // an unchanged count means the action never ran at all. Checked AFTER the
    // webhook arrived, so the engine has demonstrably finished with this event.
    expect(toastLines(a.home)).toBe(toastsBefore);

    // ── the held event is written down for the digest (#483) ────────────────
    await w.waitForTimeout(900); // the store's debounced save
    const saved = JSON.parse(fs.readFileSync(workspaceJsonPath(a.home), 'utf8')) as {
      suppressed?: Array<{ kind: string; actions: string[]; reason: string; cardId: string }>;
    };
    const held = (saved.suppressed ?? []).filter((s) => s.kind === 'needs-permission');
    expect(held).toHaveLength(1);
    expect(held[0].reason).toBe('quiet-hours');
    expect(held[0].actions).toContain('os-toast');
    expect(held[0].actions).not.toContain('webhook');
    const cards = await w.evaluate(() => window.switchboard.sessions.cards());
    expect(held[0].cardId).toBe(cards.find((c) => c.title === name)!.cardId);

    // …and the dialog can say so, which is the only way a user can tell a
    // feature whose entire job is to do nothing is working at all.
    await openFromPalette(w, 'quiet hours', 'attention.quietHours');
    await expect(w.locator('[data-quiet-status]')).toContainText('1 notification held', {
      timeout: 10_000,
    });
  });

  test('outside the window the toast fires normally', async () => {
    // The control. Without it, every absence above would also be satisfied by a
    // build where the toast rule simply never fires — which is the failure mode
    // a suppression test is most likely to have.
    const folder = tempProjectFolder();
    const name = path.basename(folder);
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    await expect(w.getByText(name).first()).toBeVisible({ timeout: 25_000 });

    await w.evaluate(() =>
      window.switchboard.notifications.setPrefs({ enabled: true, osToasts: true })
    );
    // A window that is definitively NOT now: the two hours on the far side of
    // the clock from the present.
    const away = await w.evaluate(() => {
      const hhmm = (d: Date): string =>
        `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      const now = Date.now();
      return { start: hhmm(new Date(now + 4 * 3600_000)), end: hhmm(new Date(now + 6 * 3600_000)) };
    });
    await openFromPalette(w, 'quiet hours', 'attention.quietHours');
    await quietField(w, 'start').fill(away.start);
    await quietField(w, 'end').fill(away.end);
    await quietField(w, 'enabled').click();
    await expect(w.locator('[data-quiet-status]')).toContainText('Not quiet at the moment', {
      timeout: 10_000,
    });
    await w.keyboard.press('Escape');

    await a.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].blur());
    await expect
      .poll(
        () => a.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFocused()),
        { timeout: 15_000 }
      )
      .toBe(false);

    const post = await hookPoster(a);
    await post(name, {
      hook_event_name: 'Notification',
      message: 'Claude needs your permission to use Bash',
    });

    const fired = await poll(() => {
      const lines = firings(a.home).filter((l) => l.kind === 'needs-permission');
      return lines.length > 0 ? lines[lines.length - 1] : null;
    }, 20_000);
    expect(fired.quiet).toBe(false);
    expect(fired.held).toBe('');
    expect(toastLines(a.home)).toBeGreaterThan(0);
  });
});
