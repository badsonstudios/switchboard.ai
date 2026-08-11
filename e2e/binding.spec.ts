// P2-E15-10: the Session view says WHY it is empty (§5.26, AR-P1-8).
//
// The Session view renders only if transcript binding succeeds, and binding
// rides two undocumented contracts in series — the CLI's storage layout, and
// hooks liveness. Until this item all three situations below rendered the same
// blank pane, so a user could not tell "I haven't asked it anything yet" from
// "your app lost my conversation".
//
// The fake provider writes no transcript, so as in feed.spec.ts the test plays
// Claude's part and writes JSONL into the isolated HOME itself.
//
// TRANSPORT SCOPE (P2-E18-18, #404): `[pty]` for the whole group. Every session
// here runs on the PTY (see `launchApp` in `fixtures/app.ts`), and the empty
// state these tests read is the one a PTY session gets: the `unbound` arm ends
// in `binding.unboundFallback` — "The Terminal tab is unaffected — your session
// is still running there." — which is a sentence only a PTY session can be
// told. A Direct session's Terminal tab holds the P2-E18-08b notice, not a
// running CLI. There is no Direct counterpart spec: the watcher still binds for
// a stream session (only `deriveFeed` is off, `sessions/ipc.ts`), so these
// states are reachable on Direct and are simply untested there.
//
// OUT OF SCOPE, FOUND HERE (#418): `binding.unboundFallback` renders with no
// transport gate (`FeedView.tsx`, the `copy.problem` arm), so an unbound DIRECT
// session is currently told to go look at a Terminal tab that has no terminal.
// That is a product defect, not a test one, so this item does not touch it —
// it is reported on #418 rather than fixed here.
import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { hookPoster, launchApp, LaunchedApp, tempProjectFolder } from './fixtures/app';

function slugForCwd(cwd: string): string {
  return cwd.replace(/[\\/:. ]/g, '-');
}

test.describe('[pty] transcript binding transparency (E15-10)', () => {
  let a: LaunchedApp;
  test.afterEach(async () => a?.cleanup());

  test('a fresh session says it is waiting for the first prompt, not that something broke', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    await expect(w.getByText(folder.split(/[\\/]/).pop()!).first()).toBeVisible();

    // Feed is the default view (E12-07), so this shows with no click.
    await expect(w.getByText('No conversation yet')).toBeVisible();
    await expect(w.getByText('Send a prompt below and it will appear here.')).toBeVisible();
    // and it is emphatically NOT dressed as a failure
    await expect(w.locator('[data-binding="awaiting-prompt"]')).toBeVisible();
    await expect(w.locator('[data-binding="unbound"]')).toHaveCount(0);
  });

  test('an un-prompted session never ages into a failure, however long it sits', async () => {
    // The give-up deadline is 2s here. A card you opened and have not typed
    // into has no transcript BY DESIGN — the CLI creates one on the first
    // prompt — so the deadline must not apply to it at all. Getting this wrong
    // turns every idle card in a busy workspace red within a minute, which is
    // the exact false alarm this item exists to remove.
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder, env: { SWITCHBOARD_BIND_GIVEUP_MS: '2000' } });
    const w = a.window;
    await expect(w.locator('[data-binding="awaiting-prompt"]')).toBeVisible();

    // Send the hook the CLI sends AT LAUNCH. This is the whole point of the
    // test: `SessionStart` carries a session_id, so it reaches the watcher
    // about a second after every card spawns, and the first version of this
    // feature took that as proof a conversation had started. Without this post
    // the fake provider generates no hook traffic at all and the test would
    // stay green against the very bug it is here to catch.
    const post = await hookPoster(a);
    const title = folder.split(/[\\/]/).pop()!;
    await post(title, {
      hook_event_name: 'SessionStart',
      source: 'startup',
      session_id: 'native-e2e',
    });

    await w.waitForTimeout(4_000); // twice the deadline
    await expect(w.locator('[data-binding="awaiting-prompt"]')).toBeVisible();
    await expect(w.locator('[data-binding="unbound"]')).toHaveCount(0);
    await expect(w.getByText('No conversation yet')).toBeVisible();
  });

  test('a transcript we cannot claim flips it to searching, then to a real explanation', async () => {
    const folder = tempProjectFolder();
    // 6s give-up, so the deadline is reachable without the test sitting
    // through the real 45s (main reads this only in a dev build, and only
    // when it parses positive). Not 2s: `searching` would then exist for a
    // two-second window that two sequential assertions have to fit inside,
    // which is a cliff on a loaded CI runner rather than a test.
    a = await launchApp({ seedFolder: folder, env: { SWITCHBOARD_BIND_GIVEUP_MS: '6000' } });
    const w = a.window;
    await expect(w.getByText('No conversation yet')).toBeVisible();

    // A transcript appears under OUR folder that is NOT ours — a foreign cwd
    // in the head is exactly what `claim()` refuses. This is the storage-layout
    // contract moving, and it must become visible even though hooks are silent.
    const dir = path.join(a.home, '.claude', 'projects', slugForCwd(folder));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'not-ours.jsonl'),
      JSON.stringify({
        type: 'assistant',
        sessionId: 'someone-elses-conversation',
        cwd: 'C:/somewhere/entirely/else',
        timestamp: new Date().toISOString(),
        message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
      }) + '\n'
    );

    await expect(w.locator('[data-binding="searching"]')).toBeVisible({ timeout: 5_000 });
    await expect(w.getByText("Looking for this session's transcript…")).toBeVisible();

    // ...and past the deadline it stops saying "any moment now" and says what
    // it tried, plus the thing the user most needs to hear: the CLI is fine.
    await expect(w.locator('[data-binding="unbound"]')).toBeVisible({ timeout: 15_000 });
    await expect(w.getByText("Couldn't find this session's transcript")).toBeVisible();
    await expect(
      w.getByText('The Terminal tab is unaffected — your session is still running there.')
    ).toBeVisible();
  });

  test('the real transcript binds and every explanation disappears', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder, env: { SWITCHBOARD_BIND_GIVEUP_MS: '2000' } });
    const w = a.window;
    await expect(w.getByText('No conversation yet')).toBeVisible();

    const dir = path.join(a.home, '.claude', 'projects', slugForCwd(folder));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'native-e2e.jsonl'),
      JSON.stringify({
        type: 'user',
        sessionId: 'native-e2e',
        cwd: folder,
        timestamp: new Date().toISOString(),
        message: { role: 'user', content: 'hello there' },
      }) + '\n'
    );

    await expect(w.getByText('hello there')).toBeVisible();
    // no empty-state block of any flavour survives a bound session with content
    await expect(w.locator('[data-binding]')).toHaveCount(0);
  });
});
