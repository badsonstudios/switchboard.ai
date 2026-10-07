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

  /**
   * Two idle sessions, Alpha with something said that is readable through the
   * resolver. The first test above does the same by hand and explains each
   * wait; this is that setup for the cases below.
   */
  async function twoSessions(): Promise<{
    w: Page;
    alpha: string;
    alphaLive: string;
    betaLive: string;
    marker: string;
    resolveFromBeta: (text: string) => Promise<{ ok?: boolean; prompt?: string } | null>;
  }> {
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
    const marker = `alpha-marker-${Date.now()}`;
    expect(
      await w.evaluate(
        ([id, t]) => window.switchboard.sessions.submitPrompt(id, t),
        [alphaLive, `remember ${marker}`] as [string, string]
      )
    ).toBe(true);
    const resolveFromBeta = (text: string): Promise<{ ok?: boolean; prompt?: string } | null> =>
      w.evaluate(
        ([id, t]) => window.switchboard.sessions.resolveMentions(id, t),
        [betaLive, text] as [string, string]
      );
    await pollAsync(
      async () => ((await resolveFromBeta(`@${alpha}`))?.prompt?.includes(marker) ? true : null),
      "alpha's recent output to become readable",
      40_000
    );
    // ...and Alpha's turn is OVER. The handoff switch only asks a session that
    // is free, and "its output is readable" is true a moment before "done".
    await pollAsync(async () => ((await sessionStatuses(a)).get(alpha) === 'done' ? true : null), 'alpha to finish its turn');
    return { w, alpha, alphaLive, betaLive, marker, resolveFromBeta };
  }

  const handoffSwitch = (w: Page) => w.locator('[data-handoff-switch]');
  const notice = (w: Page) => w.locator('[data-composer-attach-notice]');

  test('with the switch on, the named session writes its own handoff and it rides at the top of the brief (#1126)', async () => {
    test.setTimeout(180_000);
    const { w, alpha, marker, resolveFromBeta } = await twoSessions();

    await box(w).click();
    await box(w).fill(`pick up @${alpha}'s work from here`);
    // The switch is offered because the draft names another session, by name…
    await expect(handoffSwitch(w)).toHaveText(`Ask ${alpha} to write the handoff`);
    const toggle = handoffSwitch(w).locator('input[type="checkbox"]');
    // …and it is OFF until asked for.
    await expect(toggle).not.toBeChecked();
    await toggle.check();
    await box(w).press('Enter');

    // THE ROUND TRIP, through the real manager and the real feed: Alpha is sent
    // the request, the fake answers it (`FAKE-REPLY: <the prompt>`), Alpha's
    // turn ends, and what it said comes back to Beta's send.
    const sent = userTurns(w).filter({ hasText: 'work from here' });
    await expect(sent).toBeVisible({ timeout: 60_000 });
    await expect(notice(w)).toHaveText(`Sent with the handoff ${alpha} wrote.`);
    await expect(box(w)).toHaveValue('');
    // the switch was for that send; the next draft starts with it off
    await expect(handoffSwitch(w)).toHaveCount(0);

    const context = sent.locator('[data-feed-box="context"]');
    await context.locator('[data-feed-expander]').click();
    // the app no longer claims no model wrote it, and says which part one did
    await expect(sent).not.toContainText('no model wrote it');
    await expect(sent).toContainText('switchboard has not checked it');
    await expect(sent).toContainText('Handoff, written by that session');
    // what Alpha "wrote": the fake's echo of the request it was sent
    await expect(sent).toContainText('FAKE-REPLY: [switchboard: handoff request]');
    // ⚠️ AND THE REST OF THE BRIEF IS ALPHA AS IT WAS BEFORE IT WAS ASKED. The
    // request must not be listed under what Alpha "was asked", nor its answer
    // quoted a second time under the recent conversation.
    await expect(sent).toContainText(marker);
    const text = await sent.innerText();
    expect(text.split('[switchboard: handoff request]').length - 1).toBe(1);

    // ALPHA REALLY DID TAKE THE TURN — its own conversation now ends with the
    // request and its answer, which is what a later, ordinary mention reads.
    await pollAsync(
      async () =>
        ((await resolveFromBeta(`@${alpha}`))?.prompt?.includes('[switchboard: handoff request]') ? true : null),
      "the handoff request to be in alpha's own conversation",
      30_000
    );
  });

  test('a BUSY session is not asked: the prompt goes at once with the usual brief, and the box says so (#1126)', async () => {
    test.setTimeout(180_000);
    const { w, alpha, alphaLive, resolveFromBeta } = await twoSessions();

    // Alpha starts a turn that never ends.
    expect(
      await w.evaluate(
        ([id, t]) => window.switchboard.sessions.submitPrompt(id, t),
        [alphaLive, '!hang'] as [string, string]
      )
    ).toBe(true);
    await pollAsync(async () => ((await sessionStatuses(a)).get(alpha) === 'working' ? true : null), 'alpha to be working');

    await box(w).click();
    await box(w).fill(`pick up @${alpha}'s work from here`);
    await handoffSwitch(w).locator('input[type="checkbox"]').check();
    await box(w).press('Enter');

    const sent = userTurns(w).filter({ hasText: 'work from here' });
    // AT ONCE — no wait on a session that will never finish
    await expect(sent).toBeVisible({ timeout: 20_000 });
    await expect(notice(w)).toHaveText(`${alpha} was busy, so it was not asked. The usual brief went instead.`);
    const context = sent.locator('[data-feed-box="context"]');
    await context.locator('[data-feed-expander]').click();
    // today's brief, exactly: no handoff section, and the app's own claim intact
    await expect(sent).toContainText('no model wrote it');
    await expect(sent).not.toContainText('Handoff, written by that session');
    // …and nothing was sent to Alpha. It is still on the turn it was on.
    expect((await sessionStatuses(a)).get(alpha)).toBe('working');
    expect((await resolveFromBeta(`@${alpha}`))?.prompt ?? '').not.toContain('[switchboard: handoff request]');
  });

  test('a session whose process has ENDED is not asked — and is not left looking busy (#1126)', async () => {
    // Found in review, and it needs the real manager to see: a session that
    // exits cleanly keeps `done` on its record and keeps a transport handle
    // that swallows a send and reports success. So it was "asked", its card
    // flipped to working for good, and Send waited out the whole ninety seconds
    // for a turn that could never end.
    test.setTimeout(180_000);
    const { w, alpha, alphaLive } = await twoSessions();
    expect(
      await w.evaluate(
        ([id, t]) => window.switchboard.sessions.submitPrompt(id, t),
        [alphaLive, '!exit 0'] as [string, string]
      )
    ).toBe(true);
    // gone, by the app's own account of it
    await pollAsync(async () => {
      const cards = (await w.evaluate(() => window.switchboard.sessions.summaries())) as Array<{
        name: string;
        exited: boolean;
      }>;
      return cards.find((c) => c.name === alpha)?.exited ? true : null;
    }, 'alpha to have exited');
    const statusBefore = (await sessionStatuses(a)).get(alpha);

    await box(w).click();
    await box(w).fill(`pick up @${alpha}'s work from here`);
    await handoffSwitch(w).locator('input[type="checkbox"]').check();
    await box(w).press('Enter');

    const sent = userTurns(w).filter({ hasText: 'work from here' });
    // AT ONCE — well inside the ninety seconds it used to hang for
    await expect(sent).toBeVisible({ timeout: 20_000 });
    await expect(notice(w)).toHaveText(
      `${alpha} is not running, so there is no handoff from it. The usual brief went instead.`
    );
    // …and its card says what it said before. It was not flipped to "working".
    expect((await sessionStatuses(a)).get(alpha)).toBe(statusBefore);
    expect(statusBefore).not.toBe('working');
  });
});
