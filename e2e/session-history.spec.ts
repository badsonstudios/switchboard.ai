// P2-E20-01 (#836): opening a previous conversation from the session card —
// the round trip the done-when asks for, end to end.
//
// WHAT ONLY THIS CAN SEE. The units pin the listing and its descriptions
// (`transcripts/history.test.ts`), the plan's pick-vs-lineage rules
// (`start-plan.test.ts`), the channel and every refusal (`ipc.test.ts`) and the
// dialog against a stubbed bridge (`SessionHistoryDialog.test.tsx`). None of
// them can see the real preload, the real channel, or a REAL `--resume` reaching
// a real spawn from a row the user clicked. They also cannot see the thing this
// feature is most likely to get wrong, which since #1090 is the OPPOSITE of what
// it was: a pick made from a card's own history opens the conversation IN THAT
// CARD. It used to open a second card and leave the first alone, and the owner's
// experience of that was a session he did not know he had switched into.
//
// The transcript is written into the isolated temp home before launch, which is
// the same seam several other specs use (`providers/fake.ts` says so in its own
// comment). That makes the conversation genuinely resumable: the fake adapter's
// `canResume` is `conversationExists` against the host's root, exactly like the
// real one.
import { test, expect } from '@playwright/test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  launchApp,
  LaunchedApp,
  pollAsync,
  registerTempDir,
  sessionStatuses,
  tempProjectFolder,
} from './fixtures/app';

/**
 * `slugForCwd`, restated.
 *
 * Deliberately a copy rather than an import: `tsconfig.e2e.json` covers `e2e/**`
 * and the renderer's `env.d.ts`, not `src/main`, and reaching into the main
 * process from a spec to compute a path would make this test agree with the
 * implementation by construction instead of by evidence. If the layout ever
 * changes, this line is supposed to fail.
 */
const slug = (cwd: string): string => cwd.replace(/[\\/:. ]/g, '-').toLowerCase();

const TITLE = 'The conversation we had before';

test.describe('session history (#836)', () => {
  let a: LaunchedApp;

  test.afterEach(async () => {
    await a?.cleanup();
  });

  test('a WORKING session asks before it is stopped — Cancel changes nothing, yes opens the pick (#1127)', async () => {
    test.setTimeout(180_000);
    const folder = tempProjectFolder();
    const home = registerTempDir(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-e2e-hist-')));
    const conversation = '66666666-7777-8888-9999-000000000000';
    const dir = path.join(home, '.claude', 'projects', slug(folder));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `${conversation}.jsonl`),
      [
        JSON.stringify({
          type: 'user',
          isSidechain: false,
          cwd: folder,
          message: { role: 'user', content: 'the conversation worth stopping for' },
          uuid: 'u1',
        }),
        JSON.stringify({ type: 'ai-title', aiTitle: TITLE, sessionId: conversation }),
      ].join('\n') + '\n'
    );

    a = await launchApp({ seedFolder: folder, home, env: { SWITCHBOARD_FAKE_PROVIDER: 'stream' } });
    const w = a.window;
    const title = path.basename(folder);
    await expect(w.getByText(title).first()).toBeVisible({ timeout: 25_000 });

    // The session starts a turn that never ends.
    const box = w.getByPlaceholder(/Prompt this session/);
    await box.click();
    await box.fill('!hang');
    await box.press('Enter');
    await pollAsync(async () => ((await sessionStatuses(a)).get(title) === 'working' ? true : null), 'the session to be working');

    await w.locator('[data-testid="card-history"]').first().click();
    // By its title: the list also holds the conversation this session is IN,
    // which exists the moment it was sent a prompt.
    const rows = w.locator('[data-history-row]').filter({ hasText: TITLE });
    await expect(rows).toHaveCount(1, { timeout: 15_000 });
    const ask = w.locator('[data-history-confirm]');

    // ── ⚠️ A DOUBLE-CLICK ────────────────────────────────────────────────────
    // How a row is very often picked. Main answers a busy pick at once, so the
    // question is on screen inside the double-click interval and is drawn where
    // the list was: the second click lands on whatever appeared under the
    // pointer. As first built that was the button that stops the session
    // (found in review). Whatever it lands on now, the session is not stopped.
    await rows.first().dblclick();
    await w.waitForTimeout(1_000);
    expect((await sessionStatuses(a)).get(title)).toBe('working');
    await expect(w.locator('[data-history-dialog]')).toBeVisible();
    // back to a clean picker, whichever way the second click fell
    if (await ask.count()) await w.locator('[data-history-confirm-cancel]').click();
    await expect(ask).toHaveCount(0);

    await rows.first().click();

    // NOT a refusal any more: a question, in the dialog, saying what is at stake
    // — and WHICH conversation it is about.
    await expect(ask).toBeVisible({ timeout: 15_000 });
    await expect(ask).toContainText('This session is working');
    await expect(ask).toContainText(TITLE);
    // the list is gone while it asks: no other row to pick by accident
    await expect(w.locator('[data-history-row]').first()).toBeHidden();
    // ⚠️ CANCEL HAS THE FOCUS. The pick was a click here, but it is just as
    // often an Enter — and the next Enter must land on "no".
    await expect(w.locator('[data-history-confirm-cancel]')).toBeFocused();

    // ── no ───────────────────────────────────────────────────────────────────
    await w.keyboard.press('Enter');
    await expect(ask).toHaveCount(0);
    // the picker is still there, and the session is still doing what it was
    await expect(w.locator('[data-history-dialog]')).toBeVisible();
    expect((await sessionStatuses(a)).get(title)).toBe('working');
    await expect(w.getByText('the conversation worth stopping for')).toHaveCount(0);

    // ── a pick made with the KEYBOARD, and an Enter too many ────────────────
    const search = w.locator('[data-history-search]');
    await expect(search).toBeFocused();
    await search.fill(TITLE.slice(0, 6));
    await w.keyboard.press('Enter');
    await expect(ask).toBeVisible({ timeout: 15_000 });
    await expect(w.locator('[data-history-confirm-cancel]')).toBeFocused();
    await w.keyboard.press('Enter');
    await expect(ask).toHaveCount(0);
    expect((await sessionStatuses(a)).get(title)).toBe('working');
    await search.fill('');

    // ── yes ──────────────────────────────────────────────────────────────────
    await rows.first().click();
    await expect(ask).toBeVisible({ timeout: 15_000 });
    // it cannot be pressed the instant it appears…
    await expect(w.locator('[data-history-confirm-ok]')).toBeDisabled();
    // …only once it has been up long enough to have been read
    await expect(w.locator('[data-history-confirm-ok]')).toBeEnabled({ timeout: 5_000 });
    await w.locator('[data-history-confirm-ok]').click();
    await expect(w.locator('[data-history-dialog]')).toHaveCount(0, { timeout: 15_000 });
    // it is IN the picked conversation — its opening prompt is replayed…
    await expect(w.getByText('the conversation worth stopping for')).toBeVisible({ timeout: 25_000 });
    // …in the same card, running, and not read as "the session died"
    expect(((await w.evaluate(() => window.switchboard.sessions.cards())) as unknown[]).length).toBe(1);
    await expect(w.locator('[data-testid="card-overlay"]')).toHaveCount(0);
    // A POSITIVE status, not merely "not working" — which an absent card would
    // also satisfy. The card is there, under its name, and the turn that was
    // never going to end is not running in it.
    await pollAsync(async () => {
      const status = (await sessionStatuses(a)).get(title);
      return status !== undefined && status !== 'working' ? status : null;
    }, 'the card to be running the picked conversation, with the stopped turn gone');
  });

  test('lists a past conversation, filters it, and opens it IN THE SAME CARD (#1090)', async () => {
    test.setTimeout(180_000);
    const folder = tempProjectFolder();
    const home = registerTempDir(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-e2e-hist-')));
    const conversation = '11111111-2222-3333-4444-555555555555';

    // A conversation the app has never heard of, in the folder the seeded card
    // will open — which is the whole point of the feature: 3,000 of these exist
    // on a real machine and none of them belongs to a card.
    const dir = path.join(home, '.claude', 'projects', slug(folder));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `${conversation}.jsonl`),
      [
        JSON.stringify({ type: 'queue-operation' }),
        JSON.stringify({
          type: 'user',
          isSidechain: false,
          cwd: folder,
          message: { role: 'user', content: 'what did we decide about the cache' },
          uuid: 'u1',
        }),
        JSON.stringify({ type: 'ai-title', aiTitle: TITLE, sessionId: conversation }),
      ].join('\n') + '\n'
    );

    a = await launchApp({ seedFolder: folder, home });
    const w = a.window;
    await expect(w.getByText(path.basename(folder)).first()).toBeVisible({ timeout: 25_000 });

    // COUNT THE CARDS IN MAIN, NOT THE HEADERS ON SCREEN. Two things make a
    // rendered header the wrong proxy for "a card exists", and both bit this
    // spec's first draft: the header lives behind `{live ? … }`, so a card that
    // is still starting has none; and two sessions in one folder share a
    // dockview group, where only the ACTIVE tab's panel is in the DOM at all
    // (measured in `mention.spec.ts`). The header count is therefore 1 no matter
    // how well the feature works.
    const cardCount = async (): Promise<number> =>
      ((await w.evaluate(() => window.switchboard.sessions.cards())) as unknown[]).length;
    expect(await cardCount()).toBe(1);

    await w.locator('[data-testid="card-history"]').first().click();
    const rows = w.locator('[data-history-row]');
    await expect(w.locator('[data-history-dialog]')).toBeVisible({ timeout: 15_000 });
    // Described by the CLI's own title, not by its id — an id identifies a
    // conversation to a machine and to nobody else.
    await expect(rows).toHaveCount(1);
    await expect(w.getByText(TITLE)).toBeVisible();

    // Type-to-search, over the answer rather than the disk.
    const search = w.locator('[data-history-search]');
    await search.fill('before');
    await expect(rows).toHaveCount(1);
    await search.fill('no such conversation');
    await expect(rows).toHaveCount(0);
    await search.fill('');
    await expect(rows).toHaveCount(1);

    await rows.first().click();

    // THE SAME CARD (§5.33 as amended, #1090) — no second one appears. Polled
    // for a moment rather than read once, because "a card did not appear" is
    // only a claim once there has been time for one to.
    await expect(w.locator('[data-history-dialog]')).toHaveCount(0, { timeout: 15_000 });
    await w.waitForTimeout(1_500);
    expect(await cardCount()).toBe(1);

    // ...and it really is IN that conversation rather than being the session it
    // was a moment ago. Two independent pieces of evidence, both of which can
    // ONLY come from the seeded transcript: its opening prompt is replayed into
    // the card's Session view, and the card wears the conversation's own
    // `ai-title`.
    await expect(w.getByText('what did we decide about the cache')).toBeVisible({
      timeout: 25_000,
    });
    await expect(w.getByText(TITLE).first()).toBeVisible();

    // …and it is RUNNING there: the session the pick ended must not be read as
    // "the session died", which would put an ended overlay over a live card.
    await expect(w.locator('[data-testid="card-overlay"]')).toHaveCount(0);

    // Still one card, still under its own name — it was re-pointed, not replaced.
    expect(await cardCount()).toBe(1);
    await expect(w.getByText(path.basename(folder), { exact: true }).first()).toBeVisible();

    // Reopening the picker shows that conversation as the one this card is IN:
    // inert, because picking the conversation you are already looking at is
    // nothing to do, and because one conversation is only ever open once.
    await w.locator('[data-testid="card-history"]').first().click();
    await expect(w.locator('[data-history-dialog]')).toBeVisible({ timeout: 15_000 });
    await expect(w.locator('[data-history-row][aria-disabled="true"]')).toHaveCount(1);
  });
});
