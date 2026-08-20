// The folder-trust setting's REACH (#397), pinned end to end at the two seams
// unit tests cannot reach (#488): the chip is inert while nothing in the
// workspace will spawn on a terminal, and the `~/.claude.json` pre-write is
// gated on that same condition.
//
// Split out of `stream.spec.ts` by #626 (move-only). See that file's header for
// the whole `stream*.spec.ts` family and what belongs where.
import { test, expect } from '@playwright/test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { expectTurnCompleted, launchApp, LaunchedApp, registerTempDir } from './fixtures/app';
import { tempProjectFolder, teardown } from './fixtures/stream-session';

// The net for the last test's stragglers: by now every app in this file is
// gone, so a folder that was merely late to unlock goes on this pass.
test.afterAll(async () => teardown());

// #488 — the trust setting, pinned at the two seams unit tests cannot reach.
//
// TRANSPORT SCOPE: mixed. The first two tests are Direct (the default); the
// third is `[pty]` by construction — it exists precisely to show the OTHER
// answer, so it asks for the Terminal transport by env.
//
// #397 made the trust chip inert unless some card will spawn on the Terminal,
// and gated the `~/.claude.json` pre-write on the same condition. Both halves
// were unit-tested and both were still unpinned END TO END, which is a
// different thing:
//
//  - `trust-reach.ts` is pure and thoroughly tested, but NOTHING asserted that
//    `App.tsx` feeds it the real card list. Hard-coding `trustReaches={true}`
//    left the whole suite green — the rule was right and the wiring was
//    unmeasured, which is the #153 shape exactly (every part verified, the
//    product broken).
//
//  - the pre-write's gate is covered at the ipc seam (`sessions/ipc.test.ts`),
//    where `ensureTrusted` is a spy. A regression BELOW that seam — the gate
//    dropped in `sessions/ipc.ts`, or `trust.ts` writing where it was told not
//    to — would show up as a permanent edit to a real user's `~/.claude.json`
//    and nothing would have failed.
//
// Both are zero-token: the fakes declare the same `trust` capability the real
// provider does (`providers/fake.ts`, `providers/fake-stream.ts`, both routed
// to `sessions/trust.ts`), and every e2e home is isolated — `HOME`/`USERPROFILE`
// point at the temp dir, so `os.homedir()` inside `trust.ts` resolves there and
// the assertions below read a file this test made. NOTHING here touches the
// developer's real `~/.claude.json`.
test.describe('the trust setting is honest about its reach (#397)', () => {
  let a: LaunchedApp | undefined;
  test.afterEach(async () => {
    const launched = a;
    a = undefined; // cleared BEFORE the close — see `teardown`
    await teardown(launched);
  });

  /**
   * An isolated home with an EMPTY Claude config in it.
   *
   * The config has to exist for the pre-write to be observable at all:
   * `ensureFolderTrusted` opens `~/.claude.json` first and fails OPEN on any
   * error, so against a home with no config the write silently does not happen
   * — and the pty test below would pass for the wrong reason while asserting
   * `false`, and fail while asserting `true`. Seeding it in BOTH lanes is what
   * makes the transport the only difference between them.
   */
  function homeWithClaudeConfig(): string {
    const home = registerTempDir(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-e2e-')));
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ projects: {} }, null, 2));
    return home;
  }

  /** Did the app accept `folder` on the user's behalf, in THIS isolated home? */
  function trustAccepted(home: string, folder: string): boolean {
    const cfg = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8')) as {
      projects?: Record<string, { hasTrustDialogAccepted?: boolean }>;
    };
    // the key `trust.ts` writes: absolute path, forward slashes
    return cfg.projects?.[folder.replace(/\\/g, '/')]?.hasTrustDialogAccepted === true;
  }

  // HALF ONE: the wiring. `aria-disabled` and not `disabled`, because the chip
  // stays findable while it is inert (`components/chrome.tsx`).
  //
  // One test and not two, because the TRANSITION is the assertion that cannot
  // be faked: a hard-coded `true` fails the first half, a hard-coded `false`
  // fails the second, and a chip wired to anything other than the live card
  // list fails the second even so — `sessions:setTransport` is what announces
  // the change (`cardsChanged`), and nothing else in this test moves.
  test('the trust chip is inert on an all-Direct workspace and wakes when a card goes to Terminal', async () => {
    const folder = tempProjectFolder();
    // the dual-capable fake so the card really is on Direct — with the PTY-only
    // fake the session runs on a terminal by refusal, and this test is about
    // the transport the card CHOSE, which is what the chip reads
    a = await launchApp({ seedFolder: folder, env: { SWITCHBOARD_FAKE_PROVIDER: 'stream' } });
    const w = a.window;

    // There is a card, and it is Direct. Asserting on an EMPTY workspace would
    // pass for the wrong reason: an empty one is inert too.
    await expect(w.getByText(folder.split(/[\\/]/).pop()!).first()).toBeVisible({
      timeout: 25_000,
    });
    const chip = w.getByTestId('auto-trust');
    await expect(chip).toHaveAttribute('aria-disabled', 'true', { timeout: 15_000 });
    // ...and it says WHY, which is the whole point of leaving it on screen
    await expect(chip).toHaveAttribute(
      'title',
      /only ever asks about folder trust in Terminal mode/
    );

    // The manual's escape hatch, walked: switch the card to Terminal from its
    // ⋯ menu. NO restart — the chip has to wake on the CHOICE, because the
    // spawn that would read the setting is the one that comes after it.
    await w.getByRole('button', { name: '⋯' }).first().click();
    await w.getByRole('button', { name: /switch to Terminal/i }).click();
    await w.keyboard.press('Escape'); // the menu stays open on the pending notice

    await expect(chip).not.toHaveAttribute('aria-disabled', 'true', { timeout: 15_000 });
    await expect(chip).toHaveAttribute('title', /Whether a folder you open is trusted for you/);
  });

  // HALF TWO, Direct lane: the folder is left alone.
  //
  // The turn is driven deliberately. `sessions:create` decides about trust
  // BEFORE it spawns, so a completed turn is proof the decision has already
  // been taken — an acceptance absent here is one that was never written, not
  // one that has yet to be.
  test('a Direct spawn writes no trust acceptance for the folder', async () => {
    const folder = tempProjectFolder();
    const home = homeWithClaudeConfig();
    a = await launchApp({
      home,
      seedFolder: folder,
      env: { SWITCHBOARD_FAKE_PROVIDER: 'stream', SWITCHBOARD_TRANSPORT: 'stream' },
    });
    const w = a.window;
    await expect(w.getByText(folder.split(/[\\/]/).pop()!).first()).toBeVisible({
      timeout: 25_000,
    });

    // auto-trust is ON (the default) — so this is the gate refusing, not the
    // setting being off. The chip is the one surface that states the value.
    await expect(w.getByTestId('auto-trust')).toHaveText('🔓 auto-trust');

    const box = w.getByPlaceholder(/Prompt this session/);
    await box.click();
    await box.fill('hello direct');
    await box.press('Enter');
    await expectTurnCompleted(w);

    expect(trustAccepted(home, folder)).toBe(false);
  });

  // HALF TWO, pty lane: the same app, the same setting, the same folder — and
  // the opposite answer, because here a prompt could actually happen. Without
  // this the Direct assertion above would also be satisfied by a build that
  // never trusts anything at all.
  test('[pty] a Terminal spawn does write the trust acceptance', async () => {
    const folder = tempProjectFolder();
    const home = homeWithClaudeConfig();
    a = await launchApp({
      home,
      seedFolder: folder,
      // the ASKED-FOR transport is what the gate reads (`sessions/ipc.ts`),
      // and this is the app-wide way to ask for the Terminal (#381)
      env: { SWITCHBOARD_FAKE_PROVIDER: 'stream', SWITCHBOARD_TRANSPORT: 'pty' },
    });
    const w = a.window;
    await expect(w.getByText(folder.split(/[\\/]/).pop()!).first()).toBeVisible({
      timeout: 25_000,
    });

    // and with a Terminal card in the workspace the chip is live — the same
    // condition, read by the other half of #397
    await expect(w.getByTestId('auto-trust')).not.toHaveAttribute('aria-disabled', 'true', {
      timeout: 15_000,
    });

    await expect.poll(() => trustAccepted(home, folder), { timeout: 20_000 }).toBe(true);
  });
});
