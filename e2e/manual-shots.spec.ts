// The manual's pictures (#1082).
//
// NOT A TEST. It asserts nothing about the app; it launches the real one with
// made-up but believable data, points at things, and writes PNGs into
// `docs/manual/img/`. It lives here because everything it needs is here — the
// isolated launch, the stream fake, the fixtures that raise a real permission —
// and it is SKIPPED unless `SWITCHBOARD_MANUAL_SHOTS` is set, so `npm run e2e`
// and CI never run it and never rewrite a picture.
//
//   npm run manual:shots
//
// Regenerate after the interface changes. Never edit a picture by hand: the
// next run overwrites it. The annotations are DOM drawn over the live window
// (`annotate` below) and removed again after each shot, so what is in the
// picture is the app plus arrows — nothing is painted in afterwards.
import { test, expect, Locator, Page } from '@playwright/test';
import { execFileSync } from 'child_process';
import fs from 'fs';
import http from 'http';
import type { AddressInfo } from 'net';
import os from 'os';
import path from 'path';
import {
  closeSettings,
  launchApp,
  LaunchedApp,
  onTestDisplay,
  openEventsDrawer,
  openSettings,
  registerTempDir,
  setTheme,
  streamPrompter,
} from './fixtures/app';

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

const OUT = process.env.SWITCHBOARD_MANUAL_SHOTS_DIR ?? path.join(__dirname, '..', 'docs', 'manual', 'img');

/** The window every picture is taken in — small enough to read in a column. */
const WINDOW = { width: 1360, height: 860 };

// ── the made-up world ────────────────────────────────────────────────────────

const PROMPT_FEATURE = 'Add a dark mode toggle to the settings page';
const PROMPT_FOLLOW_UP = 'Yes — remember it between visits';
const PROMPT_BUILD = 'Run the production build and fix whatever breaks';

const SETTINGS_BEFORE = `import { Toggle } from '../components/Toggle';
import { useSettings } from '../hooks/useSettings';

export function SettingsPage() {
  const { settings, update } = useSettings();
  return (
    <section className="settings">
      <h1>Settings</h1>
      <Toggle
        label="Email me when an order ships"
        checked={settings.shippingEmails}
        onChange={(v) => update({ shippingEmails: v })}
      />
    </section>
  );
}
`;

const SETTINGS_AFTER = SETTINGS_BEFORE.replace(
  `    </section>`,
  `      <Toggle
        label="Dark mode"
        checked={settings.theme === 'dark'}
        onChange={(v) => update({ theme: v ? 'dark' : 'light' })}
      />
    </section>`
);

function git(dir: string, args: string[]): void {
  execFileSync('git', args, { cwd: dir, stdio: 'ignore', windowsHide: true });
}

/** A project that looks like somebody's: history, and work in progress. */
function storefront(parent: string, opts: { tooling?: boolean } = {}): string {
  const dir = path.join(parent, 'acme-storefront');
  const write = (rel: string, text: string): void => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text, 'utf8');
  };
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-b', 'main']);
  git(dir, ['config', 'user.email', 'maya@acme.example']);
  git(dir, ['config', 'user.name', 'Maya Okafor']);
  write('README.md', '# Acme Storefront\n\nThe customer-facing shop.\n\n## Develop\n\n```\nnpm install\nnpm run dev\n```\n');
  write('package.json', '{\n  "name": "acme-storefront",\n  "version": "2.4.0",\n  "scripts": { "dev": "vite", "build": "vite build", "test": "vitest run" }\n}\n');
  write('src/pages/SettingsPage.tsx', SETTINGS_BEFORE);
  write('src/hooks/useSettings.ts', "export function useSettings() {\n  return { settings: { shippingEmails: true, theme: 'light' }, update: () => {} };\n}\n");
  write('src/components/Toggle.tsx', 'export function Toggle() {\n  return null;\n}\n');
  write('src/styles/theme.css', ':root {\n  --bg: #ffffff;\n  --ink: #1b1f24;\n}\n');
  // The project's own MCP servers, for the one picture that is about them.
  // Committed with the skeleton so they are not "changed files" anywhere else,
  // and opt-in so the core pictures' file list stays what a first project has.
  if (opts.tooling) {
    write(
      '.mcp.json',
      JSON.stringify(
        {
          mcpServers: {
            'orders-db': { command: 'npx', args: ['-y', '@acme/orders-mcp'] },
            'design-tokens': { type: 'http', url: 'https://mcp.acme.example/tokens' },
          },
        },
        null,
        2
      ) + '\n'
    );
  }
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'Storefront skeleton']);
  write('src/pages/CartPage.tsx', 'export function CartPage() {\n  return null;\n}\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'Add the cart page']);
  write('src/pages/CheckoutPage.tsx', 'export function CheckoutPage() {\n  return null;\n}\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'Checkout: address form and order summary']);
  git(dir, ['checkout', '-b', 'feature/dark-mode']);
  // the work in progress the Changes tab shows
  write('src/pages/SettingsPage.tsx', SETTINGS_AFTER);
  write('src/styles/theme.css', ':root {\n  --bg: #ffffff;\n  --ink: #1b1f24;\n}\n\n[data-theme=\'dark\'] {\n  --bg: #14171c;\n  --ink: #e6e9ee;\n}\n');
  write('src/hooks/useTheme.ts', "export function useTheme() {\n  return document.documentElement.dataset.theme ?? 'light';\n}\n");
  return dir;
}

function plainProject(parent: string, name: string, readme: string): string {
  const dir = path.join(parent, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'README.md'), readme, 'utf8');
  git(dir, ['init', '-b', 'main']);
  git(dir, ['config', 'user.email', 'maya@acme.example']);
  git(dir, ['config', 'user.name', 'Maya Okafor']);
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'First commit']);
  return dir;
}

/** What the stand-in for Claude says to each prompt — see `FakeScriptedTurn`. */
function script(billing: string): Record<string, unknown> {
  // What the feed PRINTS. A tidy made-up path, not the temp folder the run
  // really used — that one has the machine's user name in it.
  const settings = 'C:\\Projects\\acme-storefront\\src\\pages\\SettingsPage.tsx';
  return {
    [PROMPT_FEATURE]: {
      say: "I'll add the toggle next to the existing email setting and wire it to the theme the stylesheet already reads.",
      tools: [
        { id: 'toolu_shot_read', name: 'Read', input: { file_path: settings } },
        {
          id: 'toolu_shot_edit',
          name: 'Edit',
          input: {
            file_path: settings,
            old_string: '    </section>',
            new_string:
              '      <Toggle\n        label="Dark mode"\n        checked={settings.theme === \'dark\'}\n        onChange={(v) => update({ theme: v ? \'dark\' : \'light\' })}\n      />\n    </section>',
          },
        },
        {
          id: 'toolu_shot_test',
          name: 'Bash',
          input: { command: 'npm test -- settings', description: 'Run the settings tests' },
          result:
            ' ✓ src/pages/SettingsPage.test.tsx (4 tests) 38ms\n\n Test Files  1 passed (1)\n      Tests  4 passed (4)\n   Duration  1.12s',
        },
        {
          id: 'toolu_shot_todo',
          name: 'TodoWrite',
          input: {
            todos: [
              { content: 'Add the Dark mode toggle to the settings page', status: 'completed' },
              { content: 'Add dark colours to theme.css', status: 'completed' },
              { content: 'Remember the choice between visits', status: 'pending' },
            ],
          },
        },
      ],
      then:
        'The **Dark mode** toggle is on the settings page and the tests pass.\n\n' +
        '- `SettingsPage.tsx` — the new toggle, under the email setting\n' +
        '- `theme.css` — dark colours under `[data-theme=\'dark\']`\n' +
        '- `useTheme.ts` — reads the current theme\n\n' +
        'One thing left: the choice is not remembered after a reload yet. Want me to store it?',
    },
    [PROMPT_BUILD]: {
      say: 'The build has not been run on this branch yet, so I will start there.',
      permission: {
        tool: 'Edit',
        input: {
          // A REAL path inside the run's own temp folder: if the request is ever
          // allowed, the stand-in writes the file, and it must land somewhere the
          // sweep will take it. `tidy` shows the temp parent as a projects folder.
          file_path: path.join(billing, '.env.production'),
          old_string: 'PAYMENTS_TIMEOUT_MS=3000',
          new_string: 'PAYMENTS_TIMEOUT_MS=8000',
        },
      },
    },
  };
}

// ── drawing on the window ────────────────────────────────────────────────────

interface Callout {
  /** what to point at — several things are ringed as one */
  target: Locator | Locator[];
  /** put the label at the far end of the target rather than the near one */
  alignEnd?: boolean;
  /** the words */
  label: string;
  /** which side of the target the label sits on */
  side?: 'top' | 'bottom' | 'left' | 'right';
}

/**
 * Draw a ring around each target and a numbered label beside it.
 *
 * Plain DOM in a fixed, click-through layer, removed by `clearAnnotations`.
 * The colours are the picture's own, not the app's: an annotation has to stand
 * out from EVERY theme, which is the opposite of what a token is for.
 */
async function annotate(w: Page, callouts: Callout[]): Promise<void> {
  const boxes: Array<{ x: number; y: number; width: number; height: number } | null> = [];
  for (const c of callouts) {
    // A target that is not on screen FAILS the run rather than quietly shipping
    // a picture with a label missing — the interface moved, and the shot list
    // has to move with it.
    let x1 = Infinity;
    let y1 = Infinity;
    let x2 = -Infinity;
    let y2 = -Infinity;
    for (const t of Array.isArray(c.target) ? c.target : [c.target]) {
      const b = await t.first().boundingBox({ timeout: 5_000 });
      if (!b) throw new Error(`manual shot: nothing on screen for "${c.label}"`);
      x1 = Math.min(x1, b.x);
      y1 = Math.min(y1, b.y);
      x2 = Math.max(x2, b.x + b.width);
      y2 = Math.max(y2, b.y + b.height);
    }
    boxes.push({ x: x1, y: y1, width: x2 - x1, height: y2 - y1 });
  }
  await w.evaluate(
    ({ items }) => {
      const layer = document.createElement('div');
      layer.id = 'manual-shot-annotations';
      layer.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
      items.forEach((it, i) => {
        if (!it.box) return;
        const pad = 5;
        const ring = document.createElement('div');
        ring.style.cssText =
          `position:absolute;left:${it.box.x - pad}px;top:${it.box.y - pad}px;` +
          `width:${it.box.width + pad * 2}px;height:${it.box.height + pad * 2}px;` +
          'border:3px solid #ff3d7f;border-radius:9px;box-shadow:0 0 0 3px rgba(255,61,127,.28);';
        const tag = document.createElement('div');
        // numbered only when there is more than one thing to tell apart
        tag.textContent = items.length > 1 ? `${i + 1}  ${it.label}` : it.label;
        tag.style.cssText =
          'position:absolute;background:#ff3d7f;color:#fff;font:600 14px/1.25 system-ui,sans-serif;' +
          'padding:5px 10px;border-radius:7px;white-space:nowrap;box-shadow:0 3px 10px rgba(0,0,0,.45);';
        layer.append(ring, tag);
        document.body.append(layer);
        const t = tag.getBoundingClientRect();
        const gap = 12;
        let left = it.alignEnd ? it.box.x + it.box.width - t.width : it.box.x;
        let top = it.box.y - t.height - gap;
        if (it.side === 'bottom') top = it.box.y + it.box.height + gap;
        if (it.side === 'right') {
          left = it.box.x + it.box.width + gap + pad;
          top = it.box.y + it.box.height / 2 - t.height / 2;
        }
        if (it.side === 'left') {
          left = it.box.x - t.width - gap - pad;
          top = it.box.y + it.box.height / 2 - t.height / 2;
        }
        left = Math.max(8, Math.min(left, window.innerWidth - t.width - 8));
        top = Math.max(8, Math.min(top, window.innerHeight - t.height - 8));
        // Two labels must never sit on each other: slide this one along until
        // it is clear of every label already placed.
        const placed = [...layer.querySelectorAll<HTMLElement>('[data-placed]')].map((p) =>
          p.getBoundingClientRect()
        );
        for (let tries = 0; tries < 12; tries += 1) {
          const hit = placed.find(
            (r) => left < r.right + 8 && left + t.width + 8 > r.left && top < r.bottom + 6 && top + t.height + 6 > r.top
          );
          if (!hit) break;
          if (hit.right + 8 + t.width < window.innerWidth - 8) left = hit.right + 8;
          else top = hit.bottom + 6;
        }
        tag.setAttribute('data-placed', '');
        tag.style.left = `${left}px`;
        tag.style.top = `${top}px`;
      });
    },
    {
      items: callouts.map((c, i) => ({
        label: c.label,
        side: c.side ?? 'top',
        alignEnd: c.alignEnd ?? false,
        box: boxes[i],
      })),
    }
  );
}

async function clearAnnotations(w: Page): Promise<void> {
  await w.evaluate(() => document.getElementById('manual-shot-annotations')?.remove());
}

/** One picture: annotate, shoot (the whole window, or a region), clean up. */
async function shot(
  w: Page,
  name: string,
  callouts: Callout[] = [],
  clip?: { x: number; y: number; width: number; height: number },
  /** run after the callouts are drawn — for a surface that redraws itself after `tidy` */
  lastMoment?: () => Promise<void>
): Promise<void> {
  await annotate(w, callouts);
  await lastMoment?.();
  fs.mkdirSync(OUT, { recursive: true });
  await w.screenshot({ path: path.join(OUT, `${name}.png`), clip, animations: 'disabled' });
  await clearAnnotations(w);
}

// ── the pictures ─────────────────────────────────────────────────────────────

type Clip = { x: number; y: number; width: number; height: number };

/** The rectangle that holds all of `targets`, with room around it. */
async function around(w: Page, targets: Locator[], pad = 28): Promise<Clip> {
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (const t of targets) {
    const b = await t.first().boundingBox();
    if (!b) continue;
    x1 = Math.min(x1, b.x);
    y1 = Math.min(y1, b.y);
    x2 = Math.max(x2, b.x + b.width);
    y2 = Math.max(y2, b.y + b.height);
  }
  if (!Number.isFinite(x1)) throw new Error('manual shot: nothing on screen to frame');
  const size = w.viewportSize() ?? WINDOW;
  const x = Math.max(0, x1 - pad);
  const y = Math.max(0, y1 - pad);
  return {
    x,
    y,
    width: Math.min(size.width, x2 + pad) - x,
    height: Math.min(size.height, y2 + pad) - y,
  };
}

/**
 * Swap the two strings that only a fake produces for what a reader would see.
 *
 * The stand-in reports its model as `claude-fake-1`. Everything else in these
 * pictures is the app drawing data it was given; this is the one place the
 * picture is edited, and it is edited to say what the real thing says.
 */
async function tidy(w: Page, tempParent: string, also: Record<string, string> = {}): Promise<void> {
  await w.evaluate(({ parent, swaps }) => {
    // A streamed reply arrives in pieces, and a word can be split across text
    // nodes — so a swap is tried on whole leaf elements first, then node by node.
    for (const el of document.body.querySelectorAll<HTMLElement>('*')) {
      if (el.childElementCount > 0 || el.childNodes.length < 2) continue;
      const whole = el.textContent ?? '';
      for (const [from, to] of Object.entries(swaps)) {
        if (whole.includes(from)) el.textContent = whole.split(from).join(to);
      }
    }
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      let text = n.nodeValue ?? '';
      // `=…` swaps a text node only when it is EXACTLY that — for words too
      // ordinary to replace wherever they appear
      const exact = swaps[`=${text}`];
      if (exact !== undefined) {
        n.nodeValue = exact;
        continue;
      }
      // a verb only the stand-in understands, shown as the prompt it stands for
      for (const [from, to] of Object.entries(swaps)) {
        if (text.includes(from)) {
          text = text.split(from).join(to);
          n.nodeValue = text;
        }
      }
      if (text.includes('claude-fake-1')) n.nodeValue = text.replace('claude-fake-1', 'opus');
      // the build stamp beside the version — a commit hash that dates the
      // picture to one developer's working tree and says nothing to a reader
      else if (/^[0-9a-f]{7,10}\*?$/.test(text.trim())) n.nodeValue = '';
      // …and the temp folder the run really used, which has the user name of
      // whoever generated the pictures in it
      else if (text.includes(parent)) n.nodeValue = text.split(parent).join('C:\\Projects');
    }
  }, { parent: tempParent, swaps: also });
}

/** The window every picture is taken in, at its size and in its theme. */
async function staged(a: LaunchedApp, title: string): Promise<Page> {
  const w = a.window;
  await a.app.evaluate(
    ({ BrowserWindow }, box) => BrowserWindow.getAllWindows()[0]?.setBounds(box),
    onTestDisplay(a, { x: 20, y: 20, ...WINDOW })
  );
  await expect(w.getByText(title).first()).toBeVisible({ timeout: 25_000 });
  // The dark theme a fresh install shows on a dark-mode machine (owner's pick).
  await setTheme(w, 'nordic');
  return w;
}

/** Run a command by its name, the way a user would: the palette, a few words, Enter. */
async function runCommand(w: Page, title: string): Promise<void> {
  await w.keyboard.press(`${MOD}+Shift+P`);
  await expect(w.getByRole('dialog', { name: 'Command palette' })).toBeVisible();
  await w.keyboard.type(title);
  await w.keyboard.press('Enter');
}

/** A loopback server that answers every request with `body(url)` as JSON. */
async function serveJson(body: (url: string) => unknown): Promise<{ url: string; stop: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'max-age=10, public' });
    res.end(JSON.stringify(body(req.url ?? '')));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    stop: () => new Promise<void>((r) => server.close(() => r())),
  };
}

test.describe('manual screenshots (#1082)', () => {
  test.skip(!process.env.SWITCHBOARD_MANUAL_SHOTS, 'set SWITCHBOARD_MANUAL_SHOTS=1 — npm run manual:shots');
  let a: LaunchedApp;
  test.afterEach(async () => a?.cleanup());

  test('the core pages', async () => {
    test.setTimeout(300_000);
    const parent = registerTempDir(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-e2e-shots-')));
    const shop = storefront(parent);
    const billing = plainProject(parent, 'billing-api', '# Billing API\n\nInvoices and payments.\n');
    const scriptFile = path.join(parent, 'script.json');
    fs.writeFileSync(scriptFile, JSON.stringify(script(billing)), 'utf8');

    a = await launchApp({
      seedFolder: shop,
      env: { SWITCHBOARD_FAKE_PROVIDER: 'stream', SWITCHBOARD_FAKE_SCRIPT: scriptFile },
    });
    const w = a.window;
    await a.app.evaluate(
      ({ BrowserWindow }, box) => BrowserWindow.getAllWindows()[0]?.setBounds(box),
      onTestDisplay(a, { x: 20, y: 20, ...WINDOW })
    );
    await expect(w.getByText('acme-storefront').first()).toBeVisible({ timeout: 25_000 });
    // The dark theme a fresh install shows on a dark-mode machine (owner's pick).
    await setTheme(w, 'nordic');

    const newSession = w.getByRole('button', { name: '+ session' });
    const composer = w.getByPlaceholder(/Prompt this session/);
    const tabs = w.locator('[data-testid="view-tabs"]');
    const autonomy = w.locator('[data-testid="composer-autonomy"]');

    // ── one session, before anything has been asked of it ────────────────────
    await tidy(w, parent);
    await shot(
      w,
      'new-session-button',
      // The button moved into the Sessions list, beside "+ group" (#1163), so
      // the picture is framed from the list's own left edge and the label sits
      // BELOW the button: to its right is the workspace, which it would cover.
      [{ target: newSession, label: 'Start a session here', side: 'bottom' }],
      { x: 0, y: Math.max(0, (await around(w, [newSession], 22)).y - 6), width: 640, height: 190 }
    );

    // ── a session that has done some work ────────────────────────────────────
    await composer.click();
    await composer.fill(PROMPT_FEATURE);
    await composer.press('Enter');
    await expect(w.getByText('Want me to store it?')).toBeVisible({ timeout: 30_000 });
    await tidy(w, parent);
    await shot(w, 'session-view', [
      { target: tabs, label: 'Conversation, changed files, all files, commits', side: 'right' },
      { target: w.getByText('Update Todos'), label: 'What Claude did, step by step', side: 'right' },
      { target: w.getByText('normal', { exact: true }), label: 'How much detail to show', side: 'left' },
      { target: composer, label: 'Your next message', side: 'top', alignEnd: true },
    ]);

    await composer.click();
    await composer.fill(PROMPT_FOLLOW_UP);
    await tidy(w, parent);
    await shot(
      w,
      'prompt-box',
      [
        { target: composer, label: 'Type what you want, then press Enter', side: 'top' },
        { target: autonomy, label: 'How much it may do without asking', side: 'bottom' },
      ],
      await around(w, [composer, autonomy], 64)
    );
    await composer.fill('');

    // ── the Changes tab, and one file's diff ─────────────────────────────────
    await tabs.getByText(/^Changes/).click();
    await expect(w.getByText('SettingsPage.tsx').first()).toBeVisible({ timeout: 15_000 });
    await tidy(w, parent);
    await shot(w, 'changes-tab', [
      { target: tabs.getByText(/^Changes/), label: 'Changes — the number is how many files', side: 'top' },
      { target: w.getByText('SettingsPage.tsx').first(), label: 'Click a file to see what changed', side: 'right' },
      { target: w.locator('[data-testid="scm-commit"]'), label: 'Commit when you are happy', side: 'right' },
    ]);
    await w.getByText('SettingsPage.tsx').first().click();
    await expect(w.locator('.monaco-diff-editor').first()).toBeVisible({ timeout: 20_000 });
    await w.waitForTimeout(1200);
    await tidy(w, parent);
    await shot(w, 'changes-diff', [
      { target: w.locator('.monaco-diff-editor').first(), label: 'Before on the left, after on the right', side: 'bottom' },
    ]);

    // ── reading a file in the app ────────────────────────────────────────────
    await tabs.getByText(/^Files/).click();
    const tree = w.locator('[data-testid="file-tree"]');
    await expect(tree.getByText('README.md')).toBeVisible({ timeout: 15_000 });
    await tree.getByText('README.md').click();
    const viewer = w.locator('[data-testid="document-viewer"]');
    await expect(viewer).toBeVisible({ timeout: 15_000 });
    await expect(w.locator('[data-testid="doc-rendered"] h1')).toHaveText('Acme Storefront');
    await tidy(w, parent);
    await shot(w, 'document-viewer', [
      { target: tree.getByText('README.md'), label: 'Click a file in the Files tab…', side: 'bottom' },
      { target: viewer, label: '…and it opens here, rendered', side: 'top' },
    ]);
    // close the document again, so what follows has the whole window
    await w.getByRole('tab', { name: /README\.md/ }).getByRole('button').click();
    await expect(viewer).toHaveCount(0);
    await tabs.getByText(/^Session/).click();

    // ── a second session, waiting on you ─────────────────────────────────────
    await a.app.evaluate(({ dialog }, d) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [d] });
    }, billing);
    await newSession.click();
    await expect(w.getByText('billing-api').first()).toBeVisible({ timeout: 25_000 });
    await streamPrompter(a)('billing-api', PROMPT_BUILD);
    const allow = w.getByRole('button', { name: 'Allow', exact: true });
    await expect(allow).toBeVisible({ timeout: 30_000 });
    await w.waitForTimeout(800);
    await tidy(w, parent);
    await shot(w, 'approval-bar', [
      { target: allow, label: 'Let it do this once', side: 'top' },
      { target: w.getByRole('button', { name: 'Deny', exact: true }), label: 'Or stop it', side: 'bottom' },
      { target: w.getByText('needs you').first(), label: 'This session is waiting on you', side: 'right' },
    ]);
    const rows = [
      w.getByText('Add a dark mode toggle').first(),
      w.getByText('done', { exact: true }).first(),
      w.getByText('Run the production build').first(),
      w.getByText('needs you').first(),
    ];
    await shot(
      w,
      'sessions-list',
      [
        { target: w.getByText('done', { exact: true }).first(), label: 'Finished its turn', side: 'right' },
        { target: w.getByText('needs you').first(), label: 'Waiting for an answer', side: 'right' },
      ],
      { ...(await around(w, rows, 40)), x: 0, width: 660 }
    );
    await shot(w, 'overview', [
      { target: rows, label: 'Every session, and which one needs you', side: 'bottom' },
      { target: newSession, label: 'Start a session', side: 'right' },
      { target: w.locator('.dv-tab', { hasText: 'billing-api' }), label: 'The session you are looking at', side: 'right' },
      { target: composer, label: 'Talk to it here', side: 'top', alignEnd: true },
    ]);
  });
  // ── five things that shipped without a picture (0.8.117, 0.8.118) ──────────
  //
  // Each is small and each is something you would not find by reading: a meter
  // in a corner, a picture after a word, a box that appears when the pointer
  // rests, a marker that exists only while a drag is in the air. So every one is
  // a CLOSE-UP, clipped to the thing, with one label.
  test('the small things', async () => {
    test.setTimeout(300_000);
    const parent = registerTempDir(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-e2e-shots-')));
    const shop = storefront(parent);
    const billing = plainProject(parent, 'billing-api', '# Billing API\n\nInvoices and payments.\n');
    const scriptFile = path.join(parent, 'script.json');
    fs.writeFileSync(scriptFile, JSON.stringify(script(billing)), 'utf8');

    a = await launchApp({
      seedFolder: shop,
      env: { SWITCHBOARD_FAKE_PROVIDER: 'stream', SWITCHBOARD_FAKE_SCRIPT: scriptFile },
    });
    const w = a.window;
    await a.app.evaluate(
      ({ BrowserWindow }, box) => BrowserWindow.getAllWindows()[0]?.setBounds(box),
      onTestDisplay(a, { x: 20, y: 20, ...WINDOW })
    );
    await expect(w.getByText('acme-storefront').first()).toBeVisible({ timeout: 25_000 });
    await setTheme(w, 'nordic');

    const composer = w.getByPlaceholder(/Prompt this session/);
    await composer.click();
    await composer.fill(PROMPT_FEATURE);
    await composer.press('Enter');
    await expect(w.getByText('Want me to store it?')).toBeVisible({ timeout: 30_000 });
    await tidy(w, parent);

    // ── the picture after each tool name ─────────────────────────────────────
    const icons = w.locator('svg[data-tool-icon]');
    await expect(icons.first()).toBeVisible({ timeout: 15_000 });
    const iconClip = await around(w, [icons.first(), icons.last()], 46);
    await shot(
      w,
      'tool-icons',
      // ABOVE it: to the right is the file's path, which is the row's point
      [{ target: icons.first(), label: 'A picture for the kind of step', side: 'top' }],
      // from the left edge of the conversation, wide enough to read each row
      { ...iconClip, width: Math.max(iconClip.width, 760) }
    );

    // ── the context meter ────────────────────────────────────────────────────
    const meter = w.locator('[data-testid="composer-context"]');
    await expect(meter).toBeVisible({ timeout: 15_000 });
    const options = w.locator('[data-testid="composer-options"]');
    await shot(
      w,
      'context-meter',
      [{ target: meter, label: 'How full this session is', side: 'top', alignEnd: true }],
      await around(w, [options, meter], 60)
    );

    // ── rest the pointer on a session: the last thing you asked it ───────────
    const row = w.locator('nav [data-last-prompt-for]').first();
    const hover = w.locator('[data-testid="last-prompt-hover"]');
    const rowBox = (await row.boundingBox())!;
    await shot(
      w,
      'last-prompt-hover',
      [],
      { x: 0, y: Math.max(0, rowBox.y - 60), width: 820, height: 250 },
      // AFTER the labels would be drawn: the box follows the pointer, and it
      // only opens once the pointer has rested
      async () => {
        await w.mouse.move(2, 2);
        await row.hover();
        await expect(hover).toBeVisible({ timeout: 10_000 });
      }
    );
    await w.mouse.move(2, 2);
    await expect(hover).toHaveCount(0);

    // ── the blue marker while a tab is in the air ────────────────────────────
    await a.app.evaluate(({ dialog }, d) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [d] });
    }, billing);
    await w.getByRole('button', { name: '+ session' }).click();
    await expect(w.locator('.dv-tab .identity-tab')).toHaveCount(2, { timeout: 25_000 });
    // side by side, so each session has a row of tabs of its own
    await w.locator('[data-layout-preset="columns2"]').click();
    await tidy(w, parent);
    const from = w.locator('.dv-tab', { hasText: 'billing-api' });
    const onto = w.locator('.dv-tab', { hasText: 'acme-storefront' });
    const a1 = (await from.boundingBox())!;
    const b1 = (await onto.boundingBox())!;
    const marker = w.locator('.dv-drop-target-selection');
    await shot(
      w,
      'tab-drop-marker',
      [],
      { x: Math.max(0, b1.x - 60), y: Math.max(0, b1.y - 40), width: 900, height: 230 },
      // the marker exists only while the button is down, so the picture is
      // taken mid-drag and the tab is let go afterwards
      async () => {
        await w.mouse.move(a1.x + a1.width / 2, a1.y + a1.height / 2);
        await w.mouse.down();
        await w.mouse.move(a1.x + a1.width / 2 + 8, a1.y + a1.height / 2 + 5, { steps: 3 });
        // the RIGHT half of the other tab: "it will land after this one"
        const to = { x: b1.x + b1.width * 0.75, y: b1.y + b1.height / 2 };
        await w.mouse.move((a1.x + to.x) / 2, to.y, { steps: 8 });
        await w.mouse.move(to.x, to.y, { steps: 10 });
        await w.mouse.move(to.x + 1, to.y, { steps: 2 });
        await expect(marker.first()).toBeVisible({ timeout: 10_000 });
      }
    );
    await w.mouse.up();
  });

  test('an empty workspace', async () => {
    test.setTimeout(120_000);
    // no session at all: what a first launch looks like
    a = await launchApp({ env: { SWITCHBOARD_FAKE_PROVIDER: 'stream' } });
    const w = a.window;
    await a.app.evaluate(
      ({ BrowserWindow }, box) => BrowserWindow.getAllWindows()[0]?.setBounds(box),
      onTestDisplay(a, { x: 20, y: 20, ...WINDOW })
    );
    const start = w.getByTestId('empty-workspace-new-session');
    await expect(start).toBeVisible({ timeout: 25_000 });
    await setTheme(w, 'nordic');
    // for the build stamp in the title bar; there are no paths on this screen
    await tidy(w, os.tmpdir());
    await shot(w, 'empty-workspace', [{ target: start, label: 'Pick a folder to begin', side: 'bottom' }]);
  });

  // ── the rest of the manual ─────────────────────────────────────────────────
  //
  // One picture per remaining page, in three launches. The second and third
  // exist only because the update feed and the provider-status feed are read at
  // boot and change what every OTHER picture would show (a dialog over the
  // window; "provider degraded" in the status bar), so each gets an app of its
  // own rather than leaking into the rest.

  test('the reference pages', async () => {
    test.setTimeout(420_000);
    const parent = registerTempDir(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-e2e-shots-')));
    const shop = storefront(parent, { tooling: true });
    const billing = plainProject(parent, 'billing-api', '# Billing API\n\nInvoices and payments.\n');
    const scriptFile = path.join(parent, 'script.json');
    fs.writeFileSync(scriptFile, JSON.stringify(script(billing)), 'utf8');

    a = await launchApp({
      seedFolder: shop,
      env: { SWITCHBOARD_FAKE_PROVIDER: 'stream', SWITCHBOARD_FAKE_SCRIPT: scriptFile },
    });
    const w = await staged(a, 'acme-storefront');

    const newSession = w.getByRole('button', { name: '+ session' });
    const composer = w.getByPlaceholder(/Prompt this session/);
    const tabs = w.locator('[data-testid="view-tabs"]');

    // ── slash commands — BEFORE the first turn, while the list is the app's own
    // curated one; after it the stand-in reports a made-up command of its own
    await composer.click();
    await composer.pressSequentially('/');
    const completions = w.locator('[data-completion-list]');
    await expect(completions).toBeVisible({ timeout: 15_000 });
    // The stand-in's list carries one command that exists only to prove the
    // list is the stand-in's. Like `claude-fake-1` in `tidy`, it is taken out
    // so the picture shows what a real session shows.
    await w.evaluate(() => {
      for (const row of document.querySelectorAll('[data-completion-row]')) {
        if (row.textContent?.includes('curated-only')) row.remove();
      }
    });
    await tidy(w, parent);
    await shot(
      w,
      'slash-commands',
      [
        { target: composer, label: 'Type / in the prompt box…', side: 'bottom' },
        { target: completions, label: '…and pick from what this session knows', side: 'top' },
      ],
      await around(w, [completions, composer], 70)
    );
    await w.keyboard.press('Escape');

    // ── a session that has done some work ────────────────────────────────────
    await composer.click();
    await composer.fill(PROMPT_FEATURE);
    await composer.press('Enter');
    await expect(w.getByText('Want me to store it?')).toBeVisible({ timeout: 30_000 });

    // ── the command palette ──────────────────────────────────────────────────
    await w.keyboard.press(`${MOD}+Shift+P`);
    const palette = w.getByRole('dialog', { name: 'Command palette' });
    await expect(palette).toBeVisible();
    await tidy(w, parent);
    await shot(w, 'command-palette', [
      { target: w.getByPlaceholder('Type a command or a session name…'), label: 'Type a few letters of what you want', side: 'top' },
      { target: w.locator('[data-palette-rows]').getByRole('option').first(), label: 'Enter runs the highlighted one', side: 'right' },
    ]);
    await w.keyboard.press('Escape');
    await expect(palette).toHaveCount(0);

    // ── find ─────────────────────────────────────────────────────────────────
    await w.locator('[data-feed-region]').click({ position: { x: 5, y: 5 } });
    await w.keyboard.press(`${MOD}+f`);
    const findInput = w.locator('[data-testid="find-input"]');
    await findInput.fill('toggle');
    await expect(w.locator('[data-testid="find-count"]')).toContainText(/of/, { timeout: 15_000 });
    await tidy(w, parent);
    await shot(w, 'find', [
      { target: findInput, label: 'Ctrl+F, then what you are looking for', side: 'bottom' },
      { target: w.locator('[data-testid="find-count"]'), label: 'How many, and which one you are on', side: 'bottom' },
      { target: w.locator('mark[data-feed-match-current]').first(), label: 'The current match', side: 'right' },
    ]);
    await w.locator('[data-testid="find-close"]').click();

    // ── choosing a model ─────────────────────────────────────────────────────
    const model = w.locator('[data-testid="composer-model"]');
    await model.click();
    const modelMenu = w.locator('[data-testid="model-quick-menu"]');
    await expect(modelMenu).toBeVisible();
    // The stand-in's own model heads the list; it is shown as the one a real
    // session would have ticked. The menu fills in after it opens, hence the
    // second pass at the last moment.
    const realNames = { 'Fake (default)': 'Opus', 'claude-fake-1': 'claude-opus-5' };
    await expect(modelMenu.locator('[data-model]').first()).toBeVisible();
    await w.waitForTimeout(400);
    await tidy(w, parent, realNames);
    await shot(
      w,
      'model-menu',
      [
        { target: model, label: 'Click the model name…', side: 'bottom' },
        {
          target: [modelMenu.locator('[data-model]').first(), modelMenu.locator('[data-model]').last()],
          label: '…and pick another — the tick is the one in use',
          side: 'right',
        },
      ],
      undefined,
      () => tidy(w, parent, realNames)
    );
    await w.keyboard.press('Escape');

    // ── the Files tab ────────────────────────────────────────────────────────
    await tabs.getByText(/^Files/).click();
    const tree = w.locator('[data-testid="file-tree"]');
    await expect(tree.getByText('README.md')).toBeVisible({ timeout: 15_000 });
    await tree.getByText('src', { exact: true }).click();
    await tree.getByText('pages', { exact: true }).click();
    await expect(tree.getByText('SettingsPage.tsx')).toBeVisible({ timeout: 15_000 });
    await tidy(w, parent);
    await shot(w, 'files-tab', [
      { target: tree.getByText('SettingsPage.tsx'), label: 'Click a file to read it', side: 'right' },
      {
        target: tree.locator('[data-testid^="file-tree-row-"]', { hasText: 'SettingsPage.tsx' }).locator('.file-vcs'),
        label: 'M changed, U new — the letters git uses',
        side: 'left',
      },
      { target: tree.getByText('.mcp.json'), label: 'Folders first, then files', side: 'right' },
    ]);

    // ── the History tab ──────────────────────────────────────────────────────
    await tabs.locator('[data-vtab="history"]').first().click();
    await expect(w.locator('.history-row').first()).toBeVisible({ timeout: 20_000 });
    await tidy(w, parent);
    await shot(w, 'history-tab', [
      { target: w.locator('.history-search'), label: 'Filter by words, author, or hash', side: 'right' },
      { target: w.locator('.history-row').last(), label: 'One commit — click it to see its files', side: 'bottom' },
    ]);
    await tabs.getByText(/^Session/).click();

    // ── handing work to a fresh session ──────────────────────────────────────
    await w.getByTitle('Session menu').click();
    await w.getByTestId('card-menu').getByTestId('card-dispatch').click();
    const dispatch = w.locator('[data-testid="dispatch-dialog"]');
    await expect(dispatch).toBeVisible({ timeout: 15_000 });
    await tidy(w, parent);
    await shot(w, 'dispatch', [
      { target: w.locator('[data-dispatch-template="builtin:code-reviewer"]'), label: 'What kind of help you want', side: 'left' },
      { target: w.locator('[data-testid="dispatch-task"]'), label: 'What it will be told — read it first', side: 'left' },
      { target: w.locator('[data-testid="dispatch-go"]'), label: 'Start it', side: 'left' },
    ]);
    await w.keyboard.press('Escape');
    await expect(dispatch).toHaveCount(0);

    // ── MCP servers ──────────────────────────────────────────────────────────
    await runCommand(w, 'MCP servers');
    const mcp = w.locator('[data-testid="mcp-manager"]');
    await expect(mcp).toBeVisible({ timeout: 15_000 });
    await expect(mcp.locator('[data-mcp-server]').first()).toBeVisible({ timeout: 20_000 });
    await tidy(w, parent);
    await shot(w, 'mcp-servers', [
      { target: mcp.locator('[data-mcp-server]').first(), label: 'A server, and where it stands', side: 'left' },
      { target: mcp.getByRole('button', { name: /Add server/ }), label: 'Add one without editing a file', side: 'bottom' },
    ]);
    await w.keyboard.press('Escape');
    await expect(mcp).toHaveCount(0);

    // ── settings ─────────────────────────────────────────────────────────────
    const settings = await openSettings(w);
    await tidy(w, parent);
    await shot(w, 'settings', [
      { target: settings.locator('[data-settings-section="appearance"]'), label: 'One section per subject', side: 'right' },
      { target: settings.getByRole('button', { name: 'Done', exact: true }), label: 'Nothing to save — changes apply at once', side: 'left' },
    ]);
    await closeSettings(w);

    // ── the performance summary ──────────────────────────────────────────────
    await runCommand(w, 'Show performance summary');
    const perf = w.getByRole('dialog', { name: 'Performance summary' });
    await expect(perf).toBeVisible({ timeout: 15_000 });
    await tidy(w, parent);
    await shot(w, 'performance-summary', [
      { target: perf.locator('[data-perf-row]').first(), label: 'One thing the app timed, and its slowest go', side: 'right' },
    ]);
    await w.keyboard.press('Escape');
    await expect(perf).toHaveCount(0);

    // ── reporting a problem ──────────────────────────────────────────────────
    await runCommand(w, 'Report a problem');
    const report = w.locator('[data-report-dialog]');
    await expect(report).toBeVisible({ timeout: 15_000 });
    await report.locator('[data-report-field="subject"]').fill('The Changes tab stays empty after a commit');
    await tidy(w, parent);
    await shot(w, 'report-problem', [
      { target: report.locator('[data-report-field="subject"]'), label: 'Say what went wrong, in a line', side: 'right' },
      { target: report.locator('[data-report-submit]'), label: 'Bundles the logs for you to send', side: 'left' },
    ]);
    await w.keyboard.press('Escape');
    await expect(report).toHaveCount(0);

    // ── the Events drawer, with something in it that needs an answer ─────────
    await a.app.evaluate(({ dialog }, d) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [d] });
    }, billing);
    await newSession.click();
    await expect(w.getByText('billing-api').first()).toBeVisible({ timeout: 25_000 });
    await streamPrompter(a)('billing-api', PROMPT_BUILD);
    await expect(w.getByRole('button', { name: 'Allow', exact: true }).first()).toBeVisible({ timeout: 30_000 });
    await openEventsDrawer(w);
    const drawer = w.getByTestId('events-drawer');
    await w.waitForTimeout(600);
    await tidy(w, parent);
    await shot(w, 'events-drawer', [
      { target: drawer.locator('[data-testid="events-filters"]'), label: 'Everything, or only what needs you', side: 'left' },
      { target: drawer.locator('[data-event-held]').first(), label: 'A session waiting on you — answer it right here', side: 'left' },
      // `done` or `ready`: a turn that finishes in front of someone using the
      // window is seen at once and filed as looked-at (#1219). Either way the
      // row is "a session that finished its turn".
      {
        target: drawer.locator('.event-row[data-event-kind="done"], .event-row[data-event-kind="ready"]').first(),
        label: 'A session that finished its turn',
        side: 'left',
      },
    ]);
    await w.getByTestId('events-close').click();

    // ── a reply arriving, LAST: this turn never ends ─────────────────────────
    await w.locator('.dv-tab', { hasText: 'acme-storefront' }).click();
    await streamPrompter(a)('acme-storefront', '!partial-md');
    // the whole reply, not only the stretch of it still being written (#716)
    const streaming = w
      .locator('[data-feed-seq]')
      .filter({ has: w.locator('.feed-md[data-feed-streaming]') });
    await expect(streaming).toBeVisible({ timeout: 30_000 });
    // The stand-in streams test words; the picture shows a reply. Nothing else
    // about it is touched — the cursor, the half-finished bold and the working
    // bar are the app's own.
    const reply = {
      '!partial-md': PROMPT_FOLLOW_UP,
      'STREAMED-HEADING': 'Remembering the theme',
      '=with ': 'The choice goes in ',
      '= text': ' when the toggle changes:',
      'BOLD-WHILE-OPEN': 'localStorage',
      'const halfWritten = 1;': "localStorage.setItem('theme', next);",
      'NEVER-CLOSED': 'useTheme',
    };
    await w.waitForTimeout(600);
    await tidy(w, parent, reply);
    const working = w.getByText('Claude is working').first();
    await shot(
      w,
      'direct-streaming',
      [
        { target: streaming.last(), label: 'The reply appears as it is written', side: 'top', alignEnd: true },
        { target: working, label: 'Still going', side: 'right' },
      ],
      undefined,
      () => tidy(w, parent, reply)
    );
  });

  test('the update box', async () => {
    test.setTimeout(180_000);
    const parent = registerTempDir(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-e2e-shots-')));
    const shop = storefront(parent);
    const scriptFile = path.join(parent, 'script.json');
    fs.writeFileSync(scriptFile, JSON.stringify(script(parent)), 'utf8');
    const feed = await serveJson(() => [
      {
        tag_name: 'v0.9.0',
        name: 'v0.9.0',
        body:
          '### Added\n\n- **Hand work to a fresh session.** Pick a role, read the task, and a new session starts on it beside yours.\n' +
          '- The History tab shows which commits are waiting to be pushed.\n\n' +
          '### Fixed\n\n- A narrow session no longer draws its tabs over the numbers beside them.',
        html_url: 'https://github.com/badsonstudios/switchboard.ai/releases/tag/v0.9.0',
        draft: false,
        prerelease: false,
        published_at: '2026-10-01T10:00:00Z',
      },
    ]);
    try {
      a = await launchApp({
        seedFolder: shop,
        env: {
          SWITCHBOARD_FAKE_PROVIDER: 'stream',
          SWITCHBOARD_FAKE_SCRIPT: scriptFile,
          SWITCHBOARD_UPDATE_FEED: `${feed.url}/releases`,
        },
      });
      const box = a.window.locator('[role="dialog"][data-update-state]');
      // The box opens by itself at start-up, over everything — including the
      // Settings window `staged` needs for the theme. Put it away, dress the
      // window, then ask for the check again the way the page describes.
      await expect(box).toHaveAttribute('data-update-state', 'available', { timeout: 30_000 });
      await a.window.keyboard.press('Escape');
      await expect(box).toHaveCount(0);
      const w = await staged(a, 'acme-storefront');
      const composer = w.getByPlaceholder(/Prompt this session/);
      await composer.click();
      await composer.fill(PROMPT_FEATURE);
      await composer.press('Enter');
      await expect(w.getByText('Want me to store it?')).toBeVisible({ timeout: 30_000 });
      await runCommand(w, 'Check for updates');
      await expect(box).toHaveAttribute('data-update-state', 'available', { timeout: 30_000 });
      await tidy(w, parent);
      await shot(w, 'update-box', [
        { target: box.locator('.feed-md'), label: 'What is new in it', side: 'right' },
        { target: box.getByRole('button', { name: 'Update', exact: true }), label: 'Download, check, and install it', side: 'bottom', alignEnd: true },
        { target: box.getByRole('button', { name: 'Skip this version' }), label: 'Never offer this one again', side: 'left' },
      ]);
    } finally {
      await feed.stop();
    }
  });

  test('the provider status dot', async () => {
    test.setTimeout(180_000);
    const parent = registerTempDir(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-e2e-shots-')));
    const shop = storefront(parent);
    const scriptFile = path.join(parent, 'script.json');
    fs.writeFileSync(scriptFile, JSON.stringify(script(parent)), 'utf8');
    const status = await serveJson((url) => {
      const page = { id: 'stub', name: 'Claude', url: 'https://status.claude.com' };
      return url.includes('incidents')
        ? {
            page,
            incidents: [
              {
                id: 'inc-1',
                name: 'Elevated error rates on Claude Code',
                status: 'investigating',
                impact: 'minor',
                shortlink: 'https://stspg.io/inc-1',
              },
            ],
          }
        : { page, status: { indicator: 'minor', description: 'Degraded Performance' } };
    });
    try {
      a = await launchApp({
        seedFolder: shop,
        env: {
          SWITCHBOARD_FAKE_PROVIDER: 'stream',
          SWITCHBOARD_FAKE_SCRIPT: scriptFile,
          SWITCHBOARD_STATUS_FEED: status.url,
        },
      });
      const w = await staged(a, 'acme-storefront');
      const composer = w.getByPlaceholder(/Prompt this session/);
      await composer.click();
      await composer.fill(PROMPT_FEATURE);
      await composer.press('Enter');
      await expect(w.getByText('Want me to store it?')).toBeVisible({ timeout: 30_000 });
      const dot = w.locator('[data-testid="service-health"]');
      await expect(dot).toHaveAttribute('data-state', 'degraded', { timeout: 30_000 });
      await openEventsDrawer(w);
      const incident = w.locator('[data-events-notice="incident"]');
      await expect(incident).toBeVisible({ timeout: 15_000 });
      await tidy(w, parent);
      await shot(w, 'provider-status', [
        { target: dot, label: 'The provider is having trouble — it is not you', side: 'top' },
        { target: incident, label: 'What they have said about it', side: 'left' },
      ]);
    } finally {
      await status.stop();
    }
  });
});
