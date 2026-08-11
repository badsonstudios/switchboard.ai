// P2-E18-14 — permissions in DIRECT mode, the transport the app defaults to.
//
// THE GAP THIS FILLS, from the #404 audit: 37 of 39 e2e spec files silently run
// their sessions on the PTY, because the default fake refuses the stream and
// `session-manager.ts` falls back. So `approval.spec.ts` and
// `batch-approval.spec.ts` — eleven tests, the whole permission story — exercise
// the HOOK hold path, which a Direct session bypasses entirely
// (`hook-listener.ts:620`). Direct's coverage was one Allow and one allow-all,
// both happy paths. No Deny, no queue, no cross-session group, and nothing at
// all for the failure mode that hangs a CLI for five minutes: a renderer that
// died while a question was parked.
//
// NO `SWITCHBOARD_TRANSPORT` ANYWHERE IN THIS FILE, deliberately. Direct is the
// default since #381, so a spec about the default must not name it — naming it
// would keep passing on the day the default moved back.
//
// How a session is proved to really be Direct, without a Terminal-tab detour in
// every test: the review bar carries `decision_reason`, the CLI's OWN prose for
// why it is asking (`sensitive file`). A hook `PreToolUse` payload has no such
// field, so text on that bar can only have come off the control channel.
import { test, expect, Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import {
  findFile,
  launchApp,
  LaunchedApp,
  pollAsync,
  streamPrompter,
  tempProjectFolder,
} from './fixtures/app';

/** the dual-capable fake, asked for nothing — i.e. the app's own default */
const DIRECT = { SWITCHBOARD_FAKE_PROVIDER: 'stream' };

const railRow = (w: Page, status: string) =>
  w.locator(`nav .rail-row[data-session-status="${status}"]`);

/** the requests MAIN is still holding — the witness a dead card cannot give */
function heldIds(w: Page): Promise<string[]> {
  return w.evaluate(() =>
    window.switchboard.sessions.pendingPermissions().then((l) => l.map((p) => p.requestId))
  );
}

/**
 * The JSONL the fake CLI writes, FOUND rather than reconstructed.
 *
 * The child derives the directory from its own `process.cwd()` through
 * `slugForCwd`, and the app compares that slug case-insensitively precisely
 * because real Windows paths disagree about the drive letter's case
 * (`transcripts/paths.ts`). A fourth hand-copy of the slug rule here would
 * turn any such disagreement into a 30-second poll that fails with a message
 * blaming `StreamPermissions` for a fixture bug. The file name is unique
 * (`FAKE_SESSION_ID`), so searching the isolated home is exact and cannot
 * drift.
 */
const FAKE_TRANSCRIPT = '00000000-fake-4000-8000-000000000000.jsonl';

test.describe('Direct-mode permissions (P2-E18-14)', () => {
  let a: LaunchedApp;
  test.afterEach(async () => a?.cleanup());

  // The half of the loop Direct mode has never had an e2e for. Allow was
  // covered from the day the channel existed; Deny — the answer that has to
  // reach the CLI as a REFUSAL and stop the tool — was not.
  test('Deny reaches the CLI and the tool never runs', async () => {
    // a launch, a gated call and the CLI's reply to the refusal: over the 60s
    // default on a cold runner, and a retry costs ten minutes
    test.setTimeout(90_000);
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder, env: DIRECT });
    const w = a.window;
    await expect(w.getByText(path.basename(folder)).first()).toBeVisible({ timeout: 25_000 });

    const box = w.getByPlaceholder(/Prompt this session/);
    await box.click();
    await box.fill('!perm refused.sh');
    await box.press('Enter');

    await expect(w.getByText('Allow Write?')).toBeVisible({ timeout: 30_000 });
    // the CLI's own prose — proof this question came off `can_use_tool` and not
    // off a hook payload, which has no such field
    await expect(w.getByText(/sensitive file/)).toBeVisible();
    await expect(railRow(w, 'needs-permission')).toHaveCount(1, { timeout: 15_000 });

    await w.getByRole('button', { name: 'Deny', exact: true }).click();

    // The CLI ACTED on the refusal and said so on the stream. This is the claim
    // a hook `deny` cannot make for a `.claude/` write at all (measured
    // 2026-08-01, the observation the whole epic exists for): the verdict was
    // honoured rather than layered under a second prompt.
    await expect(w.getByText(/denied write to/)).toBeVisible({ timeout: 30_000 });
    expect(fs.existsSync(path.join(folder, 'refused.sh'))).toBe(false);

    // …and nothing is left claiming a question. Both surfaces, because they
    // fail apart: the bar is renderer state, the badge is the status machine.
    await expect(w.getByText('Allow Write?')).toHaveCount(0);
    await expect(railRow(w, 'needs-permission')).toHaveCount(0, { timeout: 15_000 });
    expect(await heldIds(w)).toEqual([]);
  });

  // Two gated calls in ONE turn, which is the only way to reach the card's
  // queue on this transport from the outside: a second prompt cannot be typed
  // while the composer's session sits behind the first request's bar. The fake
  // raises both from one turn, exactly as an assistant message carrying two
  // gated `tool_use` blocks would (`!perm a b`, P2-E18-14).
  //
  // It also drives E10-04 review P0#5 on this transport: a question needs eyes,
  // so the Session tab SURFACES on its own. The card starts on the Terminal
  // tab, which in Direct mode is the "no terminal for this session" notice —
  // the reveal has to work from a tab that is not a terminal at all.
  test('concurrent holds queue on the card, and the Session tab surfaces itself', async () => {
    test.setTimeout(90_000);
    const folder = tempProjectFolder();
    const title = path.basename(folder);
    a = await launchApp({ seedFolder: folder, env: DIRECT });
    const w = a.window;
    await expect(w.getByText(title).first()).toBeVisible({ timeout: 25_000 });

    // park somewhere else first, and confirm this really is a Direct session
    // while we are there
    await w.getByRole('tab', { name: 'Terminal' }).first().click();
    await expect(w.getByText('No terminal for this session')).toBeVisible({ timeout: 30_000 });

    // Prompted through the session's own IPC rather than the composer: the
    // composer belongs to the Session tab, and the whole point is that the user
    // is NOT looking at it when the question arrives.
    const prompt = streamPrompter(a);
    await prompt(title, '!perm first.sh second.sh');

    // the Session tab came forward by itself, with the bar and the queue badge
    await expect(w.getByText('Allow Write?')).toBeVisible({ timeout: 30_000 });
    await expect(w.getByText('+1 more waiting')).toBeVisible();
    await expect(w.getByText(/first\.sh/).first()).toBeVisible();
    await expect.poll(() => heldIds(w)).toHaveLength(2);

    await w.getByRole('button', { name: 'Allow', exact: true }).click();

    // the second advances into the bar, and the badge goes with it
    await expect(w.getByText(/second\.sh/).first()).toBeVisible({ timeout: 15_000 });
    await expect(w.getByText('+1 more waiting')).toHaveCount(0);
    await w.getByRole('button', { name: 'Deny', exact: true }).click();
    await expect(w.getByText('Allow Write?')).toHaveCount(0);

    // BOTH verdicts landed, and they landed on the right requests — read off
    // the disk, which is the CLI's answer rather than ours
    await expect(() => {
      expect(fs.existsSync(path.join(folder, 'first.sh'))).toBe(true);
    }).toPass({ timeout: 20_000 });
    expect(fs.existsSync(path.join(folder, 'second.sh'))).toBe(false);
    expect(await heldIds(w)).toEqual([]);
  });

  // P2-E9-11's grouped prompt (#80's band), on the transport it has never been
  // tested on. `batch-approval.spec.ts` drives it through the hook listener, so
  // every one of its four tests is a PTY test; the grouping rule itself is
  // transport-blind (`lib/permission-batches.ts` keys on tool + input + reason),
  // and this is what proves the WIRING is too — main merges both routers'
  // pending lists into the one ledger the card reads (`sessions/ipc.ts`).
  //
  // The target is an ABSOLUTE path, and that is what makes the two questions
  // identical: `!perm` resolves a relative target against each session's own
  // cwd, and two sessions in two folders would then be asking two different
  // questions and would correctly NOT group. It is also never written — the
  // test answers deny-all — so nothing outside the temp folders is touched.
  test('two Direct sessions asking the same thing present as ONE card', async () => {
    test.setTimeout(180_000); // two real spawns
    const one = tempProjectFolder();
    const two = tempProjectFolder();
    a = await launchApp({ seedFolder: one, env: DIRECT });
    const w = a.window;
    const titles = [path.basename(one), path.basename(two)];
    await expect(w.getByText(titles[0]).first()).toBeVisible({ timeout: 25_000 });

    await a.app.evaluate(({ dialog }, d) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [d] });
    }, two);
    await w.getByRole('button', { name: '+ session' }).click();
    await expect(w.getByText(titles[1]).first()).toBeVisible({ timeout: 25_000 });

    const prompt = streamPrompter(a);
    // the same question, byte for byte, from two different CLIs
    for (const title of titles) await prompt(title, '!perm /sb-e2e-batch-target.sh');

    const card = w.getByTestId('batch-approval');
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card).toContainText('2 sessions want to run Write');
    await expect(card).toContainText('/sb-e2e-batch-target.sh');
    // both sessions are named on it, including the one dockview has not mounted
    for (const title of titles) {
      await expect(w.locator(`[data-batch-member][title="${title}"]`)).toBeVisible();
    }
    // ONE question, ONE place to answer it: the mounted card's own bar does not
    // draw the same request a second time
    await expect(w.getByText('Allow Write?')).toHaveCount(0);
    await expect.poll(() => heldIds(w)).toHaveLength(2);

    // one click, two real `control_response` frames, down two separate stdins
    await w.getByTestId('batch-deny-all').click();
    await expect(card).toHaveCount(0, { timeout: 15_000 });
    await expect.poll(() => heldIds(w)).toEqual([]);
    // and both CLIs really acted on it
    await expect(w.getByText(/denied write to/).first()).toBeVisible({ timeout: 30_000 });
  });

  // P2-E15-09's failure mode, on the channel where it is WORSE.
  //
  // `approval.spec.ts` covers it for hooks, where a released hold means
  // answering nothing and letting the CLI's own TUI prompt take the question.
  // A `control_request` has no such fallback: the CLI is blocked on us and on
  // nothing else, so a hold that outlives its renderer parks that session for
  // the full 300s deadline with nobody able to decide it. `StreamPermissions`
  // answers DENY instead (#319) — and until this test, nothing outside a unit
  // test had ever seen it do so through a real crash.
  //
  // The observable cannot be the DOM: the renderer is what we just killed. It
  // is the fake CLI's own transcript, written from inside the child process —
  // so what this reads is the CLI acting on a verdict, which is the claim.
  test('a CRASHED renderer releases a Direct hold instead of parking the CLI', async () => {
    // Same reason as approval.spec.ts's twin: crashing the renderer under xvfb
    // takes the WINDOW with it, `window-all-closed` quits the app, and the
    // session dies before anything can answer it. On Windows the window
    // provably survives with dead contents, which is the state under test.
    test.skip(
      process.platform === 'linux',
      'a renderer crash kills the whole app under xvfb; covered on Windows'
    );
    // 25s launch + 30s for the bar + a 30s poll comfortably exceeds the 60s
    // default on a cold runner — and this test only ever runs on the SLOWER of
    // the two, since Linux skips it. A retry costs ten minutes.
    test.setTimeout(120_000);
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder, env: DIRECT });
    const w = a.window;
    await expect(w.getByText(path.basename(folder)).first()).toBeVisible({ timeout: 25_000 });

    const box = w.getByPlaceholder(/Prompt this session/);
    await box.click();
    await box.fill('!perm orphaned.sh');
    await box.press('Enter');
    // parked: the CLI is blocked on this and on nothing else
    await expect(w.getByText('Allow Write?')).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => heldIds(w)).toHaveLength(1);

    await a.app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer();
    });

    // The CLI was answered and moved on. Read from the transcript the fake
    // writes, because there is no renderer left to ask — and a deny is the only
    // thing that produces this line, so it cannot be satisfied by the session
    // merely still being alive.
    await pollAsync(
      () => {
        const transcript = findFile(a.home, FAKE_TRANSCRIPT);
        const said =
          transcript !== null && fs.readFileSync(transcript, 'utf8').includes('denied write to');
        return Promise.resolve(said ? true : null);
      },
      'the hold outlived the renderer: nothing answered it',
      30_000
    );
    // …and it really was a refusal, not a silent allow
    expect(fs.existsSync(path.join(folder, 'orphaned.sh'))).toBe(false);
  });
});
