// SWITCHBOARD MUST NOT ACCEPT A FOLDER ON THE USER'S BEHALF (#397, #488, #952).
//
// This file pinned the folder-trust setting's REACH end to end at two seams unit
// tests cannot reach: the chip was inert while nothing in the workspace would
// spawn on a terminal, and the `~/.claude.json` pre-write was gated on that same
// condition. #952 deleted the chip and the pre-write's only caller, so what is
// left is the half that is a SECURITY claim rather than a UI one — and it is the
// half that has to keep being true.
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
// The remaining test's argument, unchanged: the pre-write's gate is covered at
// the ipc seam (`sessions/ipc.test.ts`), where `ensureTrusted` is a spy. A
// regression BELOW that seam — `trust.ts` writing where it was told not to —
// would show up as a permanent edit to a real user's `~/.claude.json` and nothing
// would have failed. That is why this one is end to end.
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

  // The chip test went with the chip (#952). Its history is worth one line,
  // because it kept losing strength and nobody re-read it: it originally asserted
  // the TRANSITION — inert on an all-Direct workspace, awake the moment a card
  // was switched to Terminal — which was the half that could not be faked. #873
  // removed the ⋯ switch and it degraded to asserting the inert state alone, at
  // which point a chip hard-coded to `aria-disabled="true"` would have passed it.
  // **A test that can no longer distinguish the thing it is named after is worth
  // deleting, not keeping green.**

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
      env: { SWITCHBOARD_FAKE_PROVIDER: 'stream' },
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

  // ⚠️ THE COUNTERPART WENT TOO, AND ITS ARGUMENT IS WHY THIS FILE STILL MATTERS.
  //
  // A `[pty]` test asserted the OPPOSITE answer — a Terminal spawn DID write the
  // acceptance — and it existed because without it "we never wrote anything"
  // above is also satisfied by a build that never trusts anything at all.
  //
  // A build that never trusts anything at all is now the intended state, so the
  // counterpart cannot be rebuilt and the remaining assertion is weaker than it
  // was. What keeps it honest is the seeded config: `homeWithClaudeConfig` writes
  // a real `~/.claude.json` into the isolated home, because `ensureFolderTrusted`
  // opens it FIRST and fails open on any error — so against a home with no config
  // the write silently would not happen and this test would pass for the wrong
  // reason. The file it reads is one it made.
});
