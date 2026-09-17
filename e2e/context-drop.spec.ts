// P2-E11-10 (#799): a context chip dropped on another session's prompt box
// briefs that session — the round trip, end to end.
//
// WHAT ONLY THIS CAN SEE. The units pin the offer builder, the dialog, the
// inbox and the composer's handlers against a stubbed bridge. None of them can
// see `main/index.ts` — the file with no tests of its own, which is where
// `buildContextOffer` is handed the real `sessionQueries` — nor the real
// preload, the real broker channel, or a real package built from a real
// transcript arriving in another session's composer. That gap is #763's worst
// finding ("the units can be tested while the wiring is not"), and this is the
// same answer `mention.spec.ts` and `send-to-session.spec.ts` give.
//
// ⚠️ WHAT IT CANNOT DO, stated so no assertion below quietly assumes otherwise.
// Two sessions share one dockview group and only the ACTIVE tab's panel is
// rendered — measured in #798's spec, and the DOM here holds exactly one
// `textarea`. So session A's card header and session B's composer are never in
// the document at the same time, and a real pointer drag between them cannot be
// performed. This spec therefore checks the two halves separately:
//
//   * the SOURCE half by asserting the visible card carries a draggable chip
//     that puts a session id on the transfer under the agreed type;
//   * the DELIVERY half by dispatching that exact transfer at B's composer,
//     which is what crosses the preload, the channel and the main-process
//     wiring — the part no unit test reaches.
//
// A genuine cross-card pointer drag stays a hand test; it is on the PR's list.
//
// Direct transport, the fake stream CLI: it echoes a submitted turn back, which
// is what puts A's work in A's transcript for the package builder to find.
import { test, expect, type Page } from '@playwright/test';
import path from 'path';
import { launchApp, LaunchedApp, pollAsync, sessionStatuses, tempProjectFolder } from './fixtures/app';

/** the transfer type the chip drags under — `shared/context-drop.ts` */
const CONTEXT_DND_TYPE = 'application/x-switchboard-context';

test.describe.configure({ mode: 'serial' });

test.describe('dropping a context chip on another session (#799)', () => {
  let a: LaunchedApp;

  test.afterEach(async () => {
    await a?.cleanup();
  });

  const box = (w: Page) => w.locator('textarea');
  const userTurns = (w: Page) => w.locator('[data-feed-block="user"]');
  const dialog = (w: Page) => w.locator('[data-testid="context-drop"]');

  /** every live session the app knows, as the renderer sees them */
  async function liveSessions(w: Page): Promise<Array<{ id: string; title: string }>> {
    return await w.evaluate(async () => {
      const rows = (await window.switchboard.sessions.list()) as Array<{
        id: string;
        identity: { title: string };
      }>;
      return rows.map((r) => ({ id: r.id, title: r.identity.title }));
    });
  }

  /**
   * Drop a context chip carrying `fromId` on the visible composer.
   *
   * A real `DataTransfer`, built in the page and carrying the real type, so the
   * handler is exercised through the same read it does in production
   * (`getData(CONTEXT_DND_TYPE)`) rather than through a shape invented here.
   */
  async function dropChip(w: Page, fromId: string): Promise<void> {
    await w.evaluate(
      ({ type, id }) => {
        const zone = document.querySelector('[data-composer-dropzone]');
        if (!zone) throw new Error('no composer dropzone on screen');
        const dt = new DataTransfer();
        dt.setData(type, id);
        for (const kind of ['dragenter', 'dragover', 'drop']) {
          zone.dispatchEvent(new DragEvent(kind, { dataTransfer: dt, bubbles: true, cancelable: true }));
        }
      },
      { type: CONTEXT_DND_TYPE, id: fromId }
    );
  }

  test('offers the three fidelities with real sizes, and the chosen one reaches the other session unsent', async () => {
    test.setTimeout(180_000);
    const folderA = tempProjectFolder();
    const folderB = tempProjectFolder();
    a = await launchApp({ seedFolder: folderA, env: { SWITCHBOARD_FAKE_PROVIDER: 'stream' } });
    const w = a.window;
    const alpha = path.basename(folderA);
    const beta = path.basename(folderB);

    await expect(w.getByText(alpha).first()).toBeVisible({ timeout: 25_000 });
    await a.app.evaluate(({ dialog: d }, dir) => {
      d.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [dir] });
    }, folderB);
    await w.getByRole('button', { name: '+ session' }).click();
    await expect(w.getByText(beta).first()).toBeVisible({ timeout: 25_000 });

    // Both LIVE: an unstarted card has no live session, and a package is
    // resolved by LIVE id.
    await pollAsync(async () => {
      const s = await sessionStatuses(a);
      return s.size >= 2 && [...s.values()].every((v) => v !== 'suspended');
    }, 'both sessions never came up live — a package is resolved by LIVE id', 60_000);

    const sessions = await liveSessions(w);
    const alphaId = sessions.find((s) => s.title === alpha)?.id;
    const betaId = sessions.find((s) => s.title === beta)?.id;
    expect(alphaId, 'alpha must be live to have context to hand over').toBeTruthy();
    expect(betaId).toBeTruthy();
    // The visible composer must be BETA's, or this spec proves nothing: a
    // self-drop is refused by design and every assertion below would fail.
    expect(alphaId).not.toBe(betaId);

    // Give ALPHA a turn, so its transcript holds something worth handing over.
    // Through the typed transport rather than the box, because Alpha's composer
    // is not the one on screen (see the header).
    await w.evaluate(
      ({ id, text }) => window.switchboard.sessions.submitPrompt(id, text),
      { id: alphaId!, text: 'Port the settings pane to the new theme tokens.' }
    );
    // …and wait for it to come back, so the package has prose to find. The fake
    // echoes a submitted turn, which is what puts Alpha's words in Alpha's
    // transcript for the builder to read.
    await pollAsync(
      async () => {
        const got = await liveSessions(w);
        return got.length >= 2;
      },
      'the session list never settled after Alpha’s turn',
      30_000
    );
    await w.waitForTimeout(3_000);

    // ── the SOURCE half: the card carries a real drag handle ────────────────
    const chip = w.locator('[data-testid="card-context-chip"]').first();
    await expect(chip).toBeVisible({ timeout: 15_000 });
    expect(await chip.getAttribute('draggable')).toBe('true');

    // ── the DELIVERY half: the trip no unit test can make ───────────────────
    await dropChip(w, alphaId!);
    await expect(dialog(w)).toBeVisible({ timeout: 20_000 });

    // All three fidelities, each with a size the PACKAGE reported.
    for (const id of ['state', 'package', 'excerpt']) {
      await expect(w.locator(`[data-context-option="${id}"]`)).toBeVisible();
    }
    // §5.5's default is the summary handoff, and it is pre-selected.
    expect(
      await w.locator('[data-context-option="package"]').getAttribute('data-selected')
    ).toBe('yes');
    // A real conversation produces a real estimate — this is the number that
    // would be 0 if the offer were built from an empty or unread package.
    const tokens = Number(
      await w.locator('[data-context-option="package"]').getAttribute('data-context-tokens')
    );
    expect(tokens).toBeGreaterThan(0);

    // Choose the default and commit.
    await w.locator('[data-context-ok]').click();
    await expect(dialog(w)).toBeHidden();

    // It is WAITING in Beta's composer, attributed — and nothing has been sent.
    const held = w.locator('[data-sibling-message][data-sibling-kind="context"]');
    await expect(held).toHaveCount(1, { timeout: 15_000 });
    await expect(held).toContainText(`Context from @${alpha}`);
    const before = await userTurns(w).count();

    // ── and the user's Enter is what sends it ───────────────────────────────
    // A block must have been on screen for the settle window before an Enter
    // may forward it (#765), so this waits rather than racing it.
    await w.waitForTimeout(1_500);
    await box(w).click();
    await box(w).fill('Carry on from here.');
    await box(w).press('Enter');

    await expect(userTurns(w)).toHaveCount(before + 1, { timeout: 30_000 });
    const sent = userTurns(w).last();
    // The handoff went, under its own header — visible even collapsed, because
    // it is the turn's first line.
    await expect(sent).toContainText(`Context from @${alpha}`);

    // ⚠️ EXPAND BEFORE READING THE BODY. A handoff is thousands of characters,
    // so the feed collapses the turn to a one-line marker and the body is not
    // in the DOM at all until it is opened — the first version of this spec
    // asserted against `▸# Context from @…click to expand` and failed on text
    // that had genuinely been sent.
    const expander = sent.locator('[data-feed-expander]').first();
    if ((await expander.count()) > 0) await expander.click();
    else await sent.click();

    await expect(sent).toContainText('Carry on from here.', { timeout: 15_000 });
    // …and the package really was built from Alpha's own transcript, by the
    // real query core in `main/index.ts` — the wiring no unit test can see.
    await expect(sent).toContainText('Port the settings pane');
    // NOT under the header that would have claimed another agent sent this.
    await expect(sent).not.toContainText('from another switchboard session');
    // The block is off the card once it has gone.
    await expect(held).toHaveCount(0, { timeout: 15_000 });
  });
});
