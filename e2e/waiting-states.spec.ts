// A session that is waiting on you says so — on its tab, its row in the left
// list, and its pill on the strip (#1351, treatment A).
//
// The owner, 2026-10-18: "If an AI session stops and it's waiting on me for
// anything — a gate, a question, an approval — I want it to say it's waiting
// for me. It should not say 'calm' or 'done'." Five sessions, one in each state
// that matters, driven through the real machinery by the fake stream CLI:
//
//   !perm x.sh   a held approval        → "approval"
//   !ask         an AskUserQuestion     → "question"
//   hello        a turn that finishes   → "waiting" ("waiting for you" in the list)
//   !hang        a turn that runs on    → "working", the tab's ring spinning
//   (nothing)    no turn yet            → "calm", unwashed
//
// What it asserts is what a glance reads: the word, the state on the element
// the stylesheet washes, and that the wash really is painted (a computed
// background that is not the calm one's). The ratios are tokens.drift's; the
// state rule is rail-view.test's.
//
// With SWITCHBOARD_MANUAL_SHOTS=1 it also writes the three surfaces in nordic
// and daylight to docs/manual/img — the pictures in the manual and the PR.
import { test, expect, Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { launchApp, LaunchedApp, setTheme, streamPrompter, tempProjectFolder } from './fixtures/app';

const rail = (w: Page) => w.locator('nav');
const row = (w: Page, title: string) => rail(w).locator('.rail-row').filter({ hasText: title });
const tab = (w: Page, title: string) =>
  w.locator('.dv-tabs-container .dv-tab').filter({ hasText: title }).locator('.identity-tab');
const strip = (w: Page) => w.getByTestId('sessions-strip');
const pill = (w: Page, title: string) =>
  strip(w)
    .locator('[data-strip-pill]')
    .filter({ has: w.locator('[data-strip-pill-title]', { hasText: title }) });

const SHOTS = process.env.SWITCHBOARD_MANUAL_SHOTS
  ? (process.env.SWITCHBOARD_MANUAL_SHOTS_DIR ?? path.join(__dirname, '..', 'docs', 'manual', 'img'))
  : undefined;

async function addSession(a: LaunchedApp): Promise<string> {
  const dir = tempProjectFolder();
  await a.app.evaluate(({ dialog }, d) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [d] });
  }, dir);
  await a.window.getByRole('button', { name: '+ session' }).click();
  const name = path.basename(dir);
  await expect(row(a.window, name)).toBeVisible({ timeout: 25_000 });
  return name;
}

/** the computed fill, so "washed" is a pixel fact and not only an attribute */
const fill = (l: ReturnType<typeof row>): Promise<string> =>
  l.evaluate((el) => getComputedStyle(el).backgroundColor);

test.describe('waiting on you (#1351)', () => {
  let a: LaunchedApp | undefined;
  test.afterEach(async () => {
    const launched = a;
    a = undefined;
    await launched?.cleanup();
  });

  test('approval, question and waiting are told apart from working and calm on the tab, the row and the pill', async () => {
    test.setTimeout(240_000);
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    const calm = path.basename(folder);
    await expect(row(w, calm)).toBeVisible({ timeout: 25_000 });
    const approval = await addSession(a);
    const question = await addSession(a);
    const waiting = await addSession(a);
    const working = await addSession(a);

    const prompt = streamPrompter(a);
    await prompt(approval, '!perm waiting-states.sh');
    await prompt(question, '!ask');
    await prompt(waiting, 'hello');
    await prompt(working, '!hang');

    // ── the left list ───────────────────────────────────────────────────────
    const expected: Array<[string, string | null, RegExp]> = [
      [approval, 'approval', /^approval( · <\d+[ms])?$/],
      [question, 'question', /^question$/],
      [waiting, 'waiting', /^waiting for you$/],
      [working, null, /^working$/],
      [calm, null, /^calm$/],
    ];
    for (const [title, state, word] of expected) {
      await expect(row(w, title).locator('[data-rail-state]'), title).toHaveText(word, { timeout: 30_000 });
      if (state) await expect(row(w, title)).toHaveAttribute('data-wait-state', state);
      else await expect(row(w, title)).not.toHaveAttribute('data-wait-state', /./);
    }
    // "done", "idle" and "calm" say nothing about a session waiting on you
    for (const title of [approval, question, waiting]) {
      await expect(row(w, title).locator('[data-rail-state]')).not.toHaveText(/^(done|idle|calm|needs you|needs input)$/);
    }
    // the wash is painted: three different fills, none of them the calm row's
    const calmFill = await fill(row(w, calm));
    const fills = new Set<string>();
    for (const title of [approval, question, waiting]) {
      const f = await fill(row(w, title));
      expect(f, `${title}'s row is washed`).not.toBe(calmFill);
      fills.add(f);
    }
    expect(fills.size, 'each state has its own colour').toBe(3);

    // ── the tabs ────────────────────────────────────────────────────────────
    for (const [title, state] of [[approval, 'approval'], [question, 'question'], [waiting, 'waiting']] as const) {
      await expect(tab(w, title)).toHaveAttribute('data-wait-state', state);
      await expect(tab(w, title).locator('[data-tab-state]')).toHaveText(state);
      await expect(tab(w, title).locator('.ai-badge')).toHaveAttribute('data-ring-spin', 'false');
    }
    await expect(tab(w, waiting).locator('.ai-badge')).toHaveAttribute('data-ring', 'waiting');
    // working: the ring SPINS on the tab now, and the word says so quietly
    await expect(tab(w, working).locator('.ai-badge')).toHaveAttribute('data-ring-spin', 'true');
    await expect(tab(w, working).locator('.status-ring')).toBeVisible();
    await expect(tab(w, working).locator('[data-tab-state]')).toHaveText('working');
    await expect(tab(w, working)).not.toHaveAttribute('data-wait-state', /./);
    // calm: no wash, no word, a still ring
    await expect(tab(w, calm)).not.toHaveAttribute('data-wait-state', /./);
    await expect(tab(w, calm).locator('[data-tab-state]')).toHaveCount(0);
    await expect(tab(w, calm).locator('.ai-badge')).toHaveAttribute('data-ring-spin', 'false');
    const calmTab = await tab(w, calm).evaluate((el) => getComputedStyle(el).backgroundColor);
    for (const title of [approval, question, waiting]) {
      expect(await tab(w, title).evaluate((el) => getComputedStyle(el).backgroundColor), title).not.toBe(calmTab);
    }

    if (SHOTS) {
      fs.mkdirSync(SHOTS, { recursive: true });
      for (const theme of ['nordic', 'daylight']) {
        await setTheme(w, theme);
        const list = await rail(w).boundingBox();
        await w.screenshot({
          path: path.join(SHOTS, `waiting-states-list-${theme}.png`),
          clip: { x: list!.x, y: list!.y, width: list!.width, height: Math.min(list!.height, 420) },
          animations: 'disabled',
        });
        // the five tabs, wherever the grid put them: the box round all of them
        const boxes = [];
        for (const title of [working, approval, question, waiting, calm]) {
          const b = await tab(w, title).boundingBox();
          if (b) boxes.push(b);
        }
        const x1 = Math.min(...boxes.map((b) => b.x)) - 8;
        const y1 = Math.min(...boxes.map((b) => b.y)) - 6;
        const x2 = Math.max(...boxes.map((b) => b.x + b.width)) + 8;
        const y2 = Math.max(...boxes.map((b) => b.y + b.height)) + 6;
        await w.screenshot({
          path: path.join(SHOTS, `waiting-states-tabs-${theme}.png`),
          clip: { x: Math.max(0, x1), y: Math.max(0, y1), width: x2 - Math.max(0, x1), height: y2 - Math.max(0, y1) },
          animations: 'disabled',
        });
      }
      await setTheme(w, 'nordic');
    }

    // ── the strip ───────────────────────────────────────────────────────────
    await w.locator('[data-placement="top"]').click();
    await expect(strip(w)).toBeVisible();
    for (const [title, state, word] of [
      [approval, 'approval', 'approval'],
      [question, 'question', 'question'],
      [waiting, 'waiting', 'waiting'],
    ] as const) {
      await expect(pill(w, title)).toHaveAttribute('data-wait-state', state);
      await expect(pill(w, title).locator('[data-strip-pill-state]')).toHaveText(word);
    }
    await expect(pill(w, working)).not.toHaveAttribute('data-wait-state', /./);
    await expect(pill(w, calm)).not.toHaveAttribute('data-wait-state', /./);
    const calmPill = await pill(w, calm).evaluate((el) => getComputedStyle(el).backgroundColor);
    for (const title of [approval, question, waiting]) {
      expect(await pill(w, title).evaluate((el) => getComputedStyle(el).backgroundColor), title).not.toBe(calmPill);
    }

    if (SHOTS) {
      for (const theme of ['nordic', 'daylight']) {
        await setTheme(w, theme);
        const box = await strip(w).boundingBox();
        await w.screenshot({
          path: path.join(SHOTS, `waiting-states-strip-${theme}.png`),
          clip: box!,
          animations: 'disabled',
        });
      }
      await setTheme(w, 'nordic');
    }
  });

  // #1362: a session whose CLI EXITED is not waiting for anything. The state
  // machine leaves it at the same `done` a finished turn has, and until main
  // projected it as `ended` it read "waiting" on all three surfaces while its
  // own card said "Session ended". One of each, side by side, through the real
  // exit path: the fake stream CLI's `!exit 0` ends the child cleanly.
  test('a session whose process has exited says "ended" on the tab, the row and the pill, not "waiting"', async () => {
    test.setTimeout(180_000);
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder, env: { SWITCHBOARD_FAKE_PROVIDER: 'stream' } });
    const w = a.window;
    const ended = path.basename(folder);
    await expect(row(w, ended)).toBeVisible({ timeout: 25_000 });
    const waiting = await addSession(a);

    const prompt = streamPrompter(a);
    await prompt(waiting, 'hello');
    await prompt(ended, '!exit 0');

    // the card's own panel: the clean-exit copy, which is what makes this the
    // ENDED path and not a crash. The second session opened as a tab over the
    // first, so bring the ended one forward to see its panel.
    await expect(row(w, ended).locator('[data-rail-state]')).toHaveText(/^ended$/, { timeout: 30_000 });
    await tab(w, ended).click();
    const overlay = w.getByTestId('card-overlay');
    await expect(overlay.getByText('Session ended')).toBeVisible({ timeout: 25_000 });
    await expect(overlay.getByText('The session closed.')).toBeVisible();

    // ── the left list: "ended", neutral, unwashed ──
    await expect(row(w, ended).locator('[data-rail-state]')).toHaveText(/^ended$/, { timeout: 30_000 });
    await expect(row(w, ended)).not.toHaveAttribute('data-wait-state', /./);
    await expect(row(w, ended)).toHaveAttribute('data-session-status', 'idle');
    // ...beside a finished turn that still says it is waiting (#1351, unchanged)
    await expect(row(w, waiting).locator('[data-rail-state]')).toHaveText(/^waiting for you$/, { timeout: 30_000 });
    await expect(row(w, waiting)).toHaveAttribute('data-wait-state', 'waiting');

    // ── the tab: the word, quietly, and no wash ──
    await expect(tab(w, ended).locator('[data-tab-state]')).toHaveText('ended');
    await expect(tab(w, ended).locator('[data-tab-state]')).toHaveAttribute('data-tab-state', 'ended');
    await expect(tab(w, ended)).not.toHaveAttribute('data-wait-state', /./);
    await expect(tab(w, ended).locator('.ai-badge')).toHaveAttribute('data-ring', 'idle');
    await expect(tab(w, waiting)).toHaveAttribute('data-wait-state', 'waiting');

    // ── the strip ──
    await w.locator('[data-placement="top"]').click();
    await expect(strip(w)).toBeVisible();
    await expect(pill(w, ended).locator('[data-strip-pill-state]')).toHaveText('ended');
    await expect(pill(w, ended)).not.toHaveAttribute('data-wait-state', /./);
    await expect(pill(w, waiting)).toHaveAttribute('data-wait-state', 'waiting');
  });
});
