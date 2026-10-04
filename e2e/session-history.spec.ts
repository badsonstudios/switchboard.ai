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
import { launchApp, LaunchedApp, registerTempDir, tempProjectFolder } from './fixtures/app';

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
