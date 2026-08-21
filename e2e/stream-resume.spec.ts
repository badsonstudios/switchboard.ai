// A Direct conversation SURVIVING an app relaunch: the native session id is
// learned from `system:init` and persisted so the next boot can `--resume` on
// it (#404), and the history the user already had is back on screen before they
// type anything (#395).
//
// Split out of `stream.spec.ts` by #626 (move-only). See that file's header for
// the whole `stream*.spec.ts` family and what belongs where.
//
// TRANSPORT SCOPE (P2-E18-18, #404): Direct throughout, and by DEFAULT — there
// is no `SWITCHBOARD_TRANSPORT` anywhere in this file on purpose. This is the
// path every real user has been on since #381.
import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { launchApp, LaunchedApp, readWorkspaceFile } from './fixtures/app';
import { tempProjectFolder, teardown } from './fixtures/stream-session';
// The FIRST fake conversation's id. Since #603 the fake mints one per SPAWN —
// it was a single constant every fake session announced, which made every
// Direct card in a run claim one native conversation and fed the main process's
// id-keyed logic (#484's sweep, #539's untangle) a state the real CLI cannot
// produce. Every assertion below is on a single-card test, so the first id is
// the card's id and these read exactly as they did.
import { FAKE_SESSION_ID } from '../src/main/providers/fake-stream-ids';

// The net for the last test's stragglers: by now every app in this file is
// gone, so a folder that was merely late to unlock goes on this pass.
test.afterAll(async () => teardown());

// #404 — a Direct conversation survives an app relaunch.
//
// The resume identity comes off the stream itself: `system:init.session_id` →
// the manager's pump → persisted onto the card → the next boot's
// `sessions:create` finds it, `canResume` finds the transcript the fake wrote,
// and the spawn carries `--resume`. The fake's RESUMED-FROM marker is the only
// on-screen trace that the flag was really passed (`fake-stream-protocol.ts`),
// so the final assertion reads the whole path at once.
//
// NO `SWITCHBOARD_TRANSPORT` anywhere in this describe: this is the DEFAULT
// path, the one every real user has been on since #381 — and until #404 the
// only writer of the persisted id was the hook listener the fake never fires
// SessionStart on, so this exact journey silently started a fresh conversation.
test.describe('a Direct conversation survives an app relaunch (#404)', () => {
  let a: LaunchedApp | undefined;
  test.afterEach(async () => {
    const launched = a;
    a = undefined; // cleared BEFORE the close — see `teardown`
    await teardown(launched);
  });

  test('the id learned from system:init is persisted, and the relaunch resumes with it', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder, env: { SWITCHBOARD_FAKE_PROVIDER: 'stream' } });
    const first = a;
    const w = first.window;
    await expect(w.getByText(folder.split(/[\\/]/).pop()!).first()).toBeVisible({
      timeout: 25_000,
    });

    // one full turn, so the pump has seen a system:init
    const box = w.getByPlaceholder(/Prompt this session/);
    await box.click();
    await box.fill('hello from before the relaunch');
    await box.press('Enter');
    await expect(w.getByText('FAKE-REPLY: hello from before the relaunch')).toBeVisible({
      timeout: 30_000,
    });

    // the id is already durable — on disk, where the next boot reads it. The
    // save is debounced, so poll rather than race it.
    await expect(() => {
      const card = readWorkspaceFile(first.home).sessions?.[0];
      expect(card?.nativeSessionId).toBe(FAKE_SESSION_ID);
    }).toPass({ timeout: 15_000 });
    await first.close();

    // Fresh process, same profile — and deliberately NO seedFolder: seeding
    // again creates a SECOND card, and the assertion lands on the wrong one
    // (the #381 relaunch test paid for that lesson first).
    a = await launchApp({ home: first.home, env: { SWITCHBOARD_FAKE_PROVIDER: 'stream' } });
    const w2 = a.window;
    await expect(w2.getByText(folder.split(/[\\/]/).pop()!).first()).toBeVisible({
      timeout: 25_000,
    });

    const box2 = w2.getByPlaceholder(/Prompt this session/);
    await box2.click();
    await box2.fill('same conversation?');
    await box2.press('Enter');

    await expect(w2.getByText(`RESUMED-FROM:${FAKE_SESSION_ID}`)).toBeVisible({
      timeout: 30_000,
    });
  });
});

// #395 — a resumed Direct session SHOWS the conversation it resumed.
//
// #404 proved the resume itself: the id off `system:init` is persisted, the
// next boot passes `--resume`, and the CLI keeps the context. What the user
// SAW was still nothing — `--resume` re-sends no history over the stream, and a
// stream session's transcript is deliberately barred from deriving blocks (it
// would interleave with the live tail). So every pre-existing card opened blank
// after 0.3.0 and read as data loss.
//
// This is that journey with the missing half asserted: the prior turn is on
// screen BEFORE anything is typed, and the live tail then appends to it with
// nothing duplicated and nothing missing at the join. The stream fake writes
// the same JSONL the real CLI does, so the history read here is a real
// transcript, not a fixture.
test.describe('a resumed Direct session replays its history (#395)', () => {
  let a: LaunchedApp | undefined;
  test.afterEach(async () => {
    const launched = a;
    a = undefined; // cleared BEFORE the close — see `teardown`
    await teardown(launched);
  });

  test('the prior conversation is on screen before the first new prompt, and the live tail appends to it', async () => {
    const folder = tempProjectFolder();
    // no SWITCHBOARD_TRANSPORT: Direct is the default every user is on (#381)
    a = await launchApp({ seedFolder: folder, env: { SWITCHBOARD_FAKE_PROVIDER: 'stream' } });
    const first = a;
    const w = first.window;
    await expect(w.getByText(folder.split(/[\\/]/).pop()!).first()).toBeVisible({ timeout: 25_000 });

    const box = w.getByPlaceholder(/Prompt this session/);
    await box.click();
    await box.fill('remember this turn');
    await box.press('Enter');
    await expect(w.getByText('FAKE-REPLY: remember this turn')).toBeVisible({ timeout: 30_000 });

    // the id has to be durable before the relaunch can resume on it (#404)
    await expect(() => {
      const card = readWorkspaceFile(first.home).sessions?.[0];
      expect(card?.nativeSessionId).toBe(FAKE_SESSION_ID);
    }).toPass({ timeout: 15_000 });
    await first.close();

    // fresh process, same profile, NO seedFolder — seeding again would make a
    // second card and land every assertion below on the wrong one
    a = await launchApp({ home: first.home, env: { SWITCHBOARD_FAKE_PROVIDER: 'stream' } });
    const w2 = a.window;
    await expect(w2.getByText(folder.split(/[\\/]/).pop()!).first()).toBeVisible({ timeout: 25_000 });

    // THE ASSERTION THIS ISSUE IS ABOUT: both halves of the old turn are there,
    // and nobody has typed anything into this launch.
    await expect(w2.getByText('FAKE-REPLY: remember this turn')).toBeVisible({ timeout: 30_000 });
    await expect(w2.getByText('remember this turn', { exact: true })).toHaveCount(1);
    await expect(w2.getByText('FAKE-REPLY: remember this turn')).toHaveCount(1);

    // ...and now the seam. The next turn appends BELOW the replayed history:
    // the fake's RESUMED-FROM marker proves the flag really went out, and the
    // block order proves nothing was duplicated or lost at the join.
    const box2 = w2.getByPlaceholder(/Prompt this session/);
    await box2.click();
    await box2.fill('and one more turn');
    await box2.press('Enter');
    await expect(w2.getByText('FAKE-REPLY: and one more turn')).toBeVisible({ timeout: 30_000 });
    await expect(w2.getByText(`RESUMED-FROM:${FAKE_SESSION_ID}`)).toHaveCount(1);

    // one copy of each prompt, in the order they were asked
    expect(
      (await w2.locator('[data-feed-block="user"]').allTextContents()).map((t) => t.trim())
    ).toEqual(['remember this turn', 'and one more turn']);
    await expect(w2.getByText('FAKE-REPLY: remember this turn')).toHaveCount(1);
  });

  test('a card whose transcript is gone resumes to an empty view, not an error', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder, env: { SWITCHBOARD_FAKE_PROVIDER: 'stream' } });
    const first = a;
    const w = first.window;
    await expect(w.getByText(folder.split(/[\\/]/).pop()!).first()).toBeVisible({ timeout: 25_000 });

    const box = w.getByPlaceholder(/Prompt this session/);
    await box.click();
    await box.fill('this history is about to be deleted');
    await box.press('Enter');
    await expect(w.getByText('FAKE-REPLY: this history is about to be deleted')).toBeVisible({
      timeout: 30_000,
    });
    await expect(() => {
      const card = readWorkspaceFile(first.home).sessions?.[0];
      expect(card?.nativeSessionId).toBe(FAKE_SESSION_ID);
    }).toPass({ timeout: 15_000 });
    await first.close();

    // The user pruned `~/.claude/projects` between runs. The card still carries
    // the id, so the next boot asks about it — `canResume` says no, the session
    // starts fresh, and there is nothing to replay. The claim under test is that
    // this reads as an empty session rather than a broken one: same resolver
    // answers both questions (`paths.ts`), so "resumable" and "replayable"
    // cannot disagree.
    fs.rmSync(path.join(first.home, '.claude', 'projects'), { recursive: true, force: true });

    a = await launchApp({ home: first.home, env: { SWITCHBOARD_FAKE_PROVIDER: 'stream' } });
    const w2 = a.window;
    await expect(w2.getByText(folder.split(/[\\/]/).pop()!).first()).toBeVisible({ timeout: 25_000 });

    // the card is alive and takes a prompt; there is simply no history to show
    const box2 = w2.getByPlaceholder(/Prompt this session/);
    await box2.click();
    await box2.fill('still works');
    await box2.press('Enter');
    await expect(w2.getByText('FAKE-REPLY: still works')).toBeVisible({ timeout: 30_000 });
    await expect(w2.getByText('this history is about to be deleted', { exact: true })).toHaveCount(0);
  });
});
