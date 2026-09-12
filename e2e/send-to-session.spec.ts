// P2-E11-05 (#765): one session's message lands in ANOTHER's composer, and it
// does not submit until a person presses Enter.
//
// WHAT THIS PROVES THAT NOTHING ELSE CAN. The unit tests pin the delivery
// policy (`sessions/delivery.test.ts`), the inbox and the composer against a
// stub bridge (`FeedView.sibling.test.tsx`), and `check:bus` drives the real bus
// child through the real pipe into the real policy. What none of them can see is
// `main/index.ts` — the file with no tests that hands `SiblingDelivery` every
// one of its dependencies — nor the real preload, the real `App.tsx` listener
// and the real acknowledgement coming back over IPC. #763's worst finding was
// exactly this gap: "the units can be tested while the wiring is not".
//
// So this enters at `SiblingDelivery.send` through a non-packaged-only seam (the
// fake provider declares no `mcp` capability, so no bus child runs here) and
// asserts everything from the resolver to the screen and back again.
//
// Direct transport throughout: auto-accept is Direct-only by design, and the
// fake stream CLI echoes a submitted turn back into the feed, which is what
// makes "it was sent" and "it was NOT sent" observable on screen.
import { test, expect, type Page } from '@playwright/test';
import path from 'path';
import { launchApp, LaunchedApp, pollAsync, sessionStatuses, tempProjectFolder } from './fixtures/app';

test.describe.configure({ mode: 'serial' });

interface Receipt {
  ok: boolean;
  value?: { outcome: string; shown?: boolean; session: { name: string } };
  reason?: string;
}

test.describe('send_to_session — the delivery policy, end to end (#765)', () => {
  let a: LaunchedApp;

  test.afterEach(async () => {
    await a?.cleanup();
  });

  async function twoDirectSessions(): Promise<{ w: Page; alpha: string; beta: string }> {
    test.setTimeout(120_000);
    const folderA = tempProjectFolder();
    const folderB = tempProjectFolder();
    a = await launchApp({
      seedFolder: folderA,
      env: { SWITCHBOARD_FAKE_PROVIDER: 'stream', SWITCHBOARD_E2E_SIBLING_SEND: '1' },
    });
    const w = a.window;
    const alpha = path.basename(folderA);
    const beta = path.basename(folderB);
    await expect(w.getByText(alpha).first()).toBeVisible({ timeout: 25_000 });
    await a.app.evaluate(({ dialog }, dir) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [dir] });
    }, folderB);
    await w.getByRole('button', { name: '+ session' }).click();
    await expect(w.getByText(beta).first()).toBeVisible({ timeout: 25_000 });
    // both LIVE before anything is sent — an unstarted card has no live id
    // for the resolver to find
    await pollAsync(async () => {
      const s = await sessionStatuses(a);
      return s.get(alpha) === 'idle' && s.get(beta) === 'idle' ? true : null;
    }, 'both sessions to be up and idle');
    return { w, alpha, beta };
  }

  async function cardOf(title: string): Promise<{ cardId: string; liveId: string }> {
    return pollAsync(async () => {
      const cards = (await a.window.evaluate(() => window.switchboard.sessions.cards())) as Array<{
        cardId: string;
        title: string;
        liveId?: string;
      }>;
      const c = cards.find((x) => x.title === title);
      return c?.liveId ? { cardId: c.cardId, liveId: c.liveId } : null;
    }, `no live session for "${title}"`);
  }

  /** `SiblingDelivery.send`, through the seam — i.e. what the bus host calls. */
  function send(fromLiveId: string, to: string, message: string): Promise<Receipt> {
    return a.app.evaluate(
      (_electron, [from, ref, text]) =>
        (
          globalThis as unknown as {
            __switchboardSendToSession: (c: string, r: string, m: string) => Promise<Receipt>;
          }
        ).__switchboardSendToSession(from, ref, text),
      [fromLiveId, to, message] as const
    );
  }

  const heldBlock = (w: Page, text: string) => w.locator('[data-sibling-message]', { hasText: text });
  const userTurn = (w: Page, text: string) => w.locator('[data-feed-block="user"]', { hasText: text });

  test('lands in the target composer as an attributed block, and does NOT submit until Enter', async () => {
    const { w, alpha, beta } = await twoDirectSessions();
    const from = await cardOf(alpha);
    const MESSAGE = `sibling-note-${Date.now()}: the regulator is the fault`;

    const receipt = await send(from.liveId, beta, MESSAGE);
    expect(receipt).toMatchObject({ ok: true, value: { outcome: 'held', session: { name: beta } } });

    // On screen, attributed to the SENDER by its card title.
    const block = heldBlock(w, MESSAGE);
    await expect(block).toBeVisible({ timeout: 15_000 });
    await expect(block).toContainText(`From @${alpha}`);

    // THE SAFETY PROPERTY, on the real app: nothing reached Beta's CLI. The
    // fake echoes every submitted turn into the feed, so a submit would put the
    // text in a user block; and a submit moves the session to working.
    await w.waitForTimeout(1_500);
    await expect(userTurn(w, MESSAGE)).toHaveCount(0);
    expect((await sessionStatuses(a)).get(beta)).toBe('idle');

    // …and the SIDEBAR says something is waiting (#774). The unit tests pin the
    // mark against a stubbed store; what only this can see is that the count
    // survives the real push, the real ack and the real rail — and that the
    // card whose composer is NOT on screen is the one wearing it.
    const to = await cardOf(beta);
    const railMark = w.locator(`[data-rail-waiting="${to.cardId}"]`);
    await expect(railMark).toHaveText('1', { timeout: 10_000 });
    await expect(w.locator(`[data-rail-waiting="${from.cardId}"]`)).toHaveCount(0);

    // The user's Enter is the keypress §5.4 requires.
    const box = w.locator('[data-composer-dropzone]', { has: w.locator('[data-sibling-message]') }).locator('textarea');
    await box.click();
    await box.press('Enter');
    await expect(userTurn(w, MESSAGE)).toBeVisible({ timeout: 20_000 });
    await expect(userTurn(w, MESSAGE)).toContainText(`"${alpha}"`);
    await expect(userTurn(w, MESSAGE)).toContainText('The user reviewed it and sent it on to you');
    await expect(heldBlock(w, MESSAGE)).toHaveCount(0);
    // the mark goes with the message it was about
    await expect(railMark).toHaveCount(0, { timeout: 10_000 });
  });

  test('with "accept automatically" on, it goes straight in — and says nobody reviewed it', async () => {
    const { w, alpha, beta } = await twoDirectSessions();
    const from = await cardOf(alpha);
    const to = await cardOf(beta);
    const on = await w.evaluate(
      (cardId) => window.switchboard.sessions.setAcceptFromSiblings(cardId, true),
      to.cardId
    );
    expect(on).toBe(true);
    const MESSAGE = `pipeline-step-${Date.now()}`;

    const receipt = await send(from.liveId, beta, MESSAGE);
    expect(receipt).toMatchObject({ ok: true, value: { outcome: 'submitted' } });
    await expect(userTurn(w, MESSAGE)).toBeVisible({ timeout: 20_000 });
    await expect(userTurn(w, MESSAGE)).toContainText('delivered automatically');
    // …and it never passed through the composer.
    await expect(heldBlock(w, MESSAGE)).toHaveCount(0);
  });

  test('the refusals reach the sender with a reason — self, and a session that does not exist', async () => {
    const { alpha } = await twoDirectSessions();
    const from = await cardOf(alpha);
    expect(await send(from.liveId, alpha, 'hi me')).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/cannot send a message to itself/),
    });
    expect(await send(from.liveId, 'NoSuchSession', 'hi')).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/no session named "NoSuchSession"/),
    });
  });
});
