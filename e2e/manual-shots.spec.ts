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
import os from 'os';
import path from 'path';
import {
  launchApp,
  LaunchedApp,
  onTestDisplay,
  registerTempDir,
  setTheme,
  streamPrompter,
} from './fixtures/app';

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
function storefront(parent: string): string {
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
  clip?: { x: number; y: number; width: number; height: number }
): Promise<void> {
  await annotate(w, callouts);
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
async function tidy(w: Page, tempParent: string): Promise<void> {
  await w.evaluate((parent) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = n.nodeValue ?? '';
      if (text.includes('claude-fake-1')) n.nodeValue = text.replace('claude-fake-1', 'opus');
      // the build stamp beside the version — a commit hash that dates the
      // picture to one developer's working tree and says nothing to a reader
      else if (/^[0-9a-f]{7,10}\*?$/.test(text.trim())) n.nodeValue = '';
      // …and the temp folder the run really used, which has the user name of
      // whoever generated the pictures in it
      else if (text.includes(parent)) n.nodeValue = text.split(parent).join('C:\\Projects');
    }
  }, tempParent);
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
      [{ target: newSession, label: 'Start another session here', side: 'right' }],
      { ...(await around(w, [newSession], 22)), width: 640, height: 190 }
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
});
