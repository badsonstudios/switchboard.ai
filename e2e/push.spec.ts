// P2-E14-06 — the webhook, end to end, against a LOOPBACK stub.
//
// Nothing in this file reaches the internet. The "third-party service" is an
// http server on 127.0.0.1 that this spec starts and reads, which is the shape
// `service-health.spec.ts` settled on — and it lets the whole chain be asserted
// for real rather than mocked at the seam: a credential typed into the dialog
// goes into the OS credential store, a hook event from the CLI reaches the
// rules engine, the engine dispatches the `webhook` action, and the documented
// JSON body arrives on the wire.
//
// The phone half (ntfy / Pushover) cannot be tested this way without either a
// third party's server or a fake one that proves nothing about them, so it is
// unit-tested against an injected `fetch` (`src/main/events/push.test.ts`) and
// hand-tested by Dan with a real topic. What IS shared, and is covered here, is
// everything between the dialog and the request: the credential store, the
// switches, the rules and the dispatch.
import { test, expect, Page } from '@playwright/test';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { AddressInfo } from 'net';
import {
  hookPoster,
  launchApp,
  LaunchedApp,
  poll,
  tempProjectFolder,
  workspaceJsonPath,
} from './fixtures/app';

const TOPIC = 'topic-e2e-9f3a-SECRET';

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

const dialog = (w: Page) => w.getByRole('dialog', { name: 'Phone push & webhooks' });
const field = (w: Page, name: string) => w.locator(`[data-push-field="${name}"]`);
const statusOf = (w: Page, key: string) => w.locator(`[data-push-status="${key}"]`);
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

/** Open the setup dialog the way a user with no chord for it would. */
async function openSetup(w: Page): Promise<void> {
  await w.keyboard.press(`${MOD}+Shift+P`);
  await w.getByPlaceholder('Type a command or a session name…').fill('phone push');
  await w.locator('[id="palette-row-attention.pushSetup"]').click();
  await expect(dialog(w)).toBeVisible();
}

/** The credential file, beside the workspace file in the isolated home. */
const secretsPath = (home: string): string =>
  path.join(path.dirname(workspaceJsonPath(home)), 'secrets.json');

test.describe('phone push & webhooks (P2-E14-06)', () => {
  let a: LaunchedApp;
  const stub = new StubHook();
  test.beforeAll(async () => stub.start());
  test.afterAll(async () => stub.stop());
  test.afterEach(async () => a?.cleanup());

  test('a credential typed here never lands in the workspace file, and the webhook POSTs the documented payload', async () => {
    const folder = tempProjectFolder();
    const name = path.basename(folder);
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    await expect(w.getByText(name).first()).toBeVisible({ timeout: 25_000 });

    await openSetup(w);

    // Whether this machine can keep a secret at all is an ENVIRONMENT fact, not
    // a decision the feature made — the `shown` lesson from the toast spec
    // (#421). A CI container with no keyring must show the honest refusal, and
    // that path is worth asserting rather than skipping past.
    const available = await field(w, 'ntfy.topic').isEnabled();
    // …but Windows always has DPAPI, so there the branch below is not allowed
    // to be the one that runs — otherwise this whole spec could go green by
    // skipping itself and nobody would notice (the `shown === true` lesson).
    if (process.platform === 'win32') expect(available).toBe(true);
    if (!available) {
      await expect(w.locator('[data-push-field="unavailable"]')).toBeVisible();
      await expect(field(w, 'enable-push')).toBeDisabled();
      test.info().annotations.push({ type: 'note', description: 'no OS credential store here' });
      return;
    }

    // ── the phone half: a topic goes in, and is never readable again ────────
    await field(w, 'ntfy.topic').fill(TOPIC);
    await field(w, 'ntfy.topic').press('Enter');
    await expect(statusOf(w, 'ntfy.topic')).toHaveText('· saved');
    // …and the box it was typed into is empty, so it is not on screen either
    await expect(field(w, 'ntfy.topic')).toHaveValue('');

    // ── the webhook half: point it at the loopback stub ─────────────────────
    await field(w, 'webhook.url').fill(stub.url);
    await field(w, 'webhook.url').press('Enter');
    await expect(statusOf(w, 'webhook.url')).toHaveText('· saved');
    // `.click()` + `toBeChecked`, deliberately not `.check()`: this box is not
    // optimistic. It renders what MAIN says it stored, so the DOM briefly
    // reverts between the click and the IPC answer — and `check()` asserts the
    // state synchronously after clicking, which is a race against a boundary we
    // want to keep authoritative (a refused write must leave the box telling
    // the truth, `rules-ipc.ts`'s rule).
    await field(w, 'enable-webhook').click();
    await expect(field(w, 'enable-webhook')).toBeChecked();

    // Send test — an explicit gesture, so it goes out with the switch state
    // irrelevant, and it is what Dan will click when he sets up his phone.
    await w.getByRole('button', { name: 'Send test' }).nth(1).click();
    await expect(w.locator('[data-push-result="webhook"]')).toHaveText('Sent.');
    const test1 = await poll(() => stub.received.find((r) => r.sessionId === 'test') ?? null, 15_000);
    expect(test1).toMatchObject({ source: 'switchboard.ai', version: 1, event: 'done' });

    await w.keyboard.press('Escape');
    await expect(dialog(w)).toHaveCount(0);

    // ── the real chain: a hook event → the rules engine → the wire ──────────
    const post = await hookPoster(a);
    await post(name, { hook_event_name: 'Stop' });
    const delivered = await poll(
      () => stub.received.find((r) => r.sessionId !== 'test') ?? null,
      20_000
    );
    // The contract a consumer writes against — including the field that lets
    // one endpoint tell the event types apart.
    expect(delivered).toMatchObject({
      source: 'switchboard.ai',
      version: 1,
      event: 'done',
      visibility: expect.any(String),
      ruleId: 'default:webhook:done',
    });
    expect(typeof delivered.at).toBe('string');
    const cards = await w.evaluate(() => window.switchboard.sessions.cards());
    expect(delivered.cardId).toBe(cards.find((c) => c.title === name)!.cardId);

    // ── §5.29, asserted against the bytes on disk ───────────────────────────
    await w.waitForTimeout(900); // the store's debounced save
    const workspace = fs.readFileSync(workspaceJsonPath(a.home), 'utf8');
    expect(workspace).toContain('"webhook": true'); // the switch IS persisted…
    expect(workspace).not.toContain(TOPIC); // …and the credentials are not
    expect(workspace).not.toContain(stub.url);
    const secrets = fs.readFileSync(secretsPath(a.home), 'utf8');
    expect(secrets).toContain('ntfy.topic'); // the slot name is not a secret
    expect(secrets).not.toContain(TOPIC); // the value is stored encrypted
    expect(secrets).not.toContain(stub.url);

    // Nothing the app logged carries either credential, on any path.
    const logs = fs
      .readdirSync(path.dirname(workspaceJsonPath(a.home)), { recursive: true } as {
        recursive: true;
      })
      .filter((f) => String(f).endsWith('.log'))
      .map((f) => fs.readFileSync(path.join(path.dirname(workspaceJsonPath(a.home)), String(f)), 'utf8'))
      .join('\n');
    expect(logs).not.toContain(TOPIC);
    expect(logs).not.toContain(stub.url);
  });

  test('the dialog is reachable from About, and a fresh app is configured with nothing', async () => {
    a = await launchApp();
    const w = a.window;
    await expect(
      w.getByRole('button', { name: 'Version and build — click for details' })
    ).toBeVisible({ timeout: 25_000 });
    await w.getByRole('button', { name: 'Version and build — click for details' }).click();
    await w.getByRole('button', { name: 'Phone push & webhooks…' }).click();
    await expect(dialog(w)).toBeVisible();

    // The resting state: both switches off, no credential set, and no file
    // written for a feature nobody has touched.
    await expect(field(w, 'enable-push')).not.toBeChecked();
    await expect(field(w, 'enable-webhook')).not.toBeChecked();
    await expect(statusOf(w, 'ntfy.topic')).toHaveText('· not set');
    expect(fs.existsSync(secretsPath(a.home))).toBe(false);
  });
});
