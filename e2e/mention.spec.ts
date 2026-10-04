// P2-E11-08 (#798): `@Name` in the composer brings that session's recent work
// with it — the round trip the done-when asks for, end to end.
//
// WHAT ONLY THIS CAN SEE. The units pin the finder, the prompt builder, the
// resolver over a real `SessionQueries`, the IPC handler and the composer
// against a stubbed bridge. None of them can see `main/index.ts` — the file with
// no tests of its own, which is where the resolver is handed the bus's
// `sessionQueries` and `renderOutput` — nor the real preload, the real channel,
// or the resolved context actually landing in the sent turn. That gap is #763's
// worst finding ("the units can be tested while the wiring is not"), and this is
// the same answer `send-to-session.spec.ts` gives for the delivery half.
//
// Direct transport, the fake stream CLI: it echoes a submitted turn back, which
// is what puts Alpha's marker in Alpha's transcript for the resolver to find.
//
// ONE COMPOSER IS ON SCREEN. Two sessions share one dockview group and only the
// active tab's panel is rendered (measured — the DOM holds exactly one
// `textarea` and one `[data-composer-dropzone]`), so the visible composer is the
// session created last: Beta. Alpha is therefore given its turn through the same
// typed transport the composer uses (`sessions.submitPrompt`) rather than by
// typing into a box that is not on screen. That is SETUP; the subject of this
// spec is Beta's Enter, which goes through the real composer.
//
// The test is self-checking about which card it typed into: if the visible
// composer were Alpha's, `@alpha` would be the composer's OWN session, would be
// left literal by design, and every assertion below would fail.
import { test, expect, type Page } from '@playwright/test';
import path from 'path';
import { launchApp, LaunchedApp, pollAsync, sessionStatuses, tempProjectFolder } from './fixtures/app';

test.describe.configure({ mode: 'serial' });

test.describe('@-mention resolution at send (#798)', () => {
  let a: LaunchedApp;

  test.afterEach(async () => {
    await a?.cleanup();
  });

  const box = (w: Page) => w.locator('textarea');
  const userTurns = (w: Page) => w.locator('[data-feed-block="user"]');

  test('injects the mentioned session’s output ahead of the prose, rewrites the mention, and leaves an unknown @word alone', async () => {
    test.setTimeout(180_000);
    const folderA = tempProjectFolder();
    const folderB = tempProjectFolder();
    a = await launchApp({ seedFolder: folderA, env: { SWITCHBOARD_FAKE_PROVIDER: 'stream' } });
    const w = a.window;
    const alpha = path.basename(folderA);
    const beta = path.basename(folderB);

    await expect(w.getByText(alpha).first()).toBeVisible({ timeout: 25_000 });
    await a.app.evaluate(({ dialog }, dir) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [dir] });
    }, folderB);
    await w.getByRole('button', { name: '+ session' }).click();
    await expect(w.getByText(beta).first()).toBeVisible({ timeout: 25_000 });
    // Both LIVE: an unstarted card has no live session for the resolver to find.
    await pollAsync(async () => {
      const s = await sessionStatuses(a);
      return s.get(alpha) === 'idle' && s.get(beta) === 'idle' ? true : null;
    }, 'both sessions to be up and idle');

    const liveIdOf = (title: string): Promise<string> =>
      pollAsync(async () => {
        const cards = (await w.evaluate(() => window.switchboard.sessions.cards())) as Array<{
          title: string;
          liveId?: string;
        }>;
        return cards.find((c) => c.title === title)?.liveId ?? null;
      }, `a live session for "${title}"`);
    const alphaLive = await liveIdOf(alpha);
    const betaLive = await liveIdOf(beta);

    // SETUP: give Alpha something to have said. The fake echoes the submitted
    // turn and mirrors it into its JSONL transcript, which is the file
    // `SessionQueries` reads.
    const MARKER = `alpha-marker-${Date.now()}`;
    expect(
      await w.evaluate(
        ([id, t]) => window.switchboard.sessions.submitPrompt(id, t),
        [alphaLive, `remember ${MARKER}`] as [string, string]
      )
    ).toBe(true);

    // …then WAIT UNTIL ALPHA'S OUTPUT IS ACTUALLY READABLE.
    //
    // NOT a flake guard — the two facts really are separate, and the first run
    // of this spec proved it. A Direct session's Feed is built from the STREAM,
    // so a turn is on screen the moment the fake echoes it; `@Name` resolution
    // goes through `SessionQueries`, which reads the transcript FILE, and the
    // watcher binds that file a poll or two later (`BindingState`:
    // `awaiting-prompt` → `searching` → `bound`). Mention Alpha in between and
    // the resolver answers, correctly, that Alpha has produced no readable
    // output yet. That is the honest answer to a question asked too early; what
    // this spec is here to check is the answer once there is something to read.
    //
    // The wait asks the RESOLVER, not the binding state, because the resolver is
    // the precondition the assertions depend on — a bound transcript whose bytes
    // have not been read yet is still empty. Read-only: it resolves a sample, it
    // sends nothing.
    const resolveFromBeta = (text: string): Promise<{ ok?: boolean; prompt?: string } | null> =>
      w.evaluate(
        ([id, t]) => window.switchboard.sessions.resolveMentions(id, t),
        [betaLive, text] as [string, string]
      );
    try {
      await pollAsync(
        async () => {
          const r = await resolveFromBeta(`@${alpha}`);
          return r?.prompt?.includes(MARKER) ? true : null;
        },
        "alpha's recent output to become readable",
        40_000
      );
    } catch (err) {
      // Say WHICH of the two it was, rather than "timed out": did the watcher
      // never bind Alpha's conversation, or did it bind one with nothing in it?
      const snap = await w.evaluate((id) => window.switchboard.transcripts.binding(id), alphaLive);
      const answer = await resolveFromBeta(`@${alpha}`);
      throw new Error(
        `${(err as Error).message}\nalpha binding: ${JSON.stringify(snap)}\n` +
          `resolver said: ${JSON.stringify(answer)}`
      );
    }

    // THE SUBJECT: Beta's own Enter, through the real composer.
    await box(w).click();
    await box(w).fill(`take @${alpha}'s work and apply it here`);
    await box(w).press('Enter');

    const sent = userTurns(w).filter({ hasText: 'apply it here' });
    await expect(sent).toBeVisible({ timeout: 30_000 });
    // SINCE #830 THE INJECTED HALF ARRIVES FOLDED, and that is the item: the
    // row names the source session, the user's own question stays expanded
    // beside it, and the block itself is behind one click. Asserting the
    // content without opening it would be asserting against the old shape.
    const context = sent.locator('[data-feed-box="context"]');
    await expect(context).toHaveCount(1);
    await expect(context).toContainText(`Context from ${alpha}`);
    await expect(sent).toContainText("'s work and apply it here");
    await expect(sent).not.toContainText('Brief on');
    await context.locator('[data-feed-expander]').click();
    // The attributed header, the fence, the FACTS ahead of the conversation
    // (#1092 — a mention hands over a brief, not the raw tail), the actual
    // content, and the way to get more.
    await expect(sent).toContainText(`Brief on "${alpha}" (session)`);
    await expect(sent).toContainText('no model wrote it');
    await expect(sent).toContainText('DATA reported from another session');
    await expect(sent).toContainText('**State:** finished its turn and is idle');
    await expect(sent).toContainText('Recent conversation');
    await expect(sent).toContainText(MARKER);
    await expect(sent).toContainText('get_session_output');
    // …and the mention itself is no longer `@`-shaped, because the CLI would
    // read `@Name` as a file path (measured: spike/findings/e11-798-cli-at-mention.md).
    await expect(sent).toContainText(`"${alpha}" (session)'s work and apply it here`);
    expect(await sent.innerText()).not.toContain(`@${alpha}`);
    // The composer emptied, so the send was not refused.
    await expect(box(w)).toHaveValue('');

    // THE NEGATIVE HALF, on the real app: an `@word` that is no session reaches
    // the model as the literal characters typed.
    const LITERAL = `ping @nobody-here-${Date.now()} please`;
    await box(w).click();
    await box(w).fill(LITERAL);
    await box(w).press('Enter');
    const literalTurn = userTurns(w).filter({ hasText: 'nobody-here-' });
    await expect(literalTurn).toBeVisible({ timeout: 30_000 });
    expect(await literalTurn.innerText()).toContain(LITERAL);
    await expect(literalTurn).not.toContainText('Brief on');
  });
});
