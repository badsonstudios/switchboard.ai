// P2-E9-11: the grouped permission prompt, against the REAL hook listener.
//
// The item's done-when is three claims, and all three are about what happens
// when TWO CLIs are blocked at the same moment. Nothing below stubs the part
// that matters: the test plays both CLIs' part (a `PreToolUse` POST each, with
// each session's own token), the UI answers, and the verdicts come back down
// the two parked HTTP responses.
//
// It also exercises the one thing no unit test can reach. Dockview mounts only
// the panel it is showing, so of two cards in a group exactly one exists as a
// component — which is precisely why a cross-session prompt cannot live in a
// card, and why "the second session's question is on screen at all" is a claim
// that has to be made in a real window.
import { test, expect, Page } from '@playwright/test';
import path from 'path';
import { hookPoster, launchApp, LaunchedApp, tempProjectFolder } from './fixtures/app';

/** The hook listener's answer to a PreToolUse POST, as `hook-listener.ts`
 *  writes it. Absent when the request was not held. */
interface HookResponse {
  hookSpecificOutput?: {
    hookEventName: string;
    permissionDecision: 'allow' | 'deny';
    permissionDecisionReason: string;
  };
}

function verdict(body: string): 'allow' | 'deny' {
  const parsed = JSON.parse(body) as HookResponse;
  if (!parsed.hookSpecificOutput) throw new Error(`request was never held: ${body}`);
  return parsed.hookSpecificOutput.permissionDecision;
}

/** the rail row for a session, by title — the house locator */
const row = (w: Page, title: string) =>
  w.locator('nav').locator('[draggable="true"]', { hasText: title }).first();

/** open one more session, in its own folder (so nothing auto-groups) */
async function addSession(a: LaunchedApp): Promise<string> {
  const dir = tempProjectFolder();
  await a.app.evaluate(({ dialog }, d) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [d] });
  }, dir);
  await a.window.getByRole('button', { name: '+ session' }).click();
  const name = path.basename(dir);
  await expect(row(a.window, name)).toBeVisible({ timeout: 25_000 });
  return name;
}

/** the requests main is STILL holding — the only witness that survives a card
 *  being unmounted, and the one that says "nothing was answered for it" */
function heldIds(w: Page): Promise<string[]> {
  return w.evaluate(() =>
    window.switchboard.sessions.pendingPermissions().then((l) => l.map((p) => p.requestId))
  );
}

/** answer a request the way a card would, for the sibling whose card is not on
 *  screen — the production preload, no test-only channel */
async function answer(w: Page, requestId: string, decision: 'allow' | 'deny'): Promise<void> {
  await w.evaluate(
    ([id, d]) => window.switchboard.sessions.decidePermission(id, d as 'allow' | 'deny'),
    [requestId, decision]
  );
}

const bash = (command: string): Record<string, unknown> => ({
  hook_event_name: 'PreToolUse',
  tool_name: 'Bash',
  tool_input: { command },
});

// ONE app for the whole file, and `serial` so a failure stops the block rather
// than cascading through the tests behind it.
//
// Four launches of a two-session workspace cost 4.3 minutes and blew the hook
// budget on the fourth — a per-test relaunch buys isolation this file does not
// need, because the only state these tests share is "what is currently held",
// and every one of them ends by answering everything (the afterEach below makes
// that true even when one fails). The sessions themselves are inert between
// tests: the fake provider sits in a shell and does nothing until a hook POST
// arrives.
test.describe.configure({ mode: 'serial' });

test.describe('batch permission handling (P2-E9-11)', () => {
  let a: LaunchedApp;
  let post: (title: string, body: Record<string, unknown>) => Promise<string>;
  let one: string;
  let two: string;

  test.beforeAll(async () => {
    test.setTimeout(180_000); // two real spawns, and the listener has to come up
    const folder = tempProjectFolder();
    one = path.basename(folder);
    a = await launchApp({ seedFolder: folder });
    await expect(row(a.window, one)).toBeVisible({ timeout: 25_000 });
    two = await addSession(a);
    // AFTER both sessions exist: the poster snapshots the token map and the
    // card list once
    post = await hookPoster(a, 2);
  });

  // A held request left over from a failed test would park its CLI and,
  // worse, silently seed the next test's ledger. Drain unconditionally.
  test.afterEach(async () => {
    if (!a) return;
    for (const id of await heldIds(a.window)) await answer(a.window, id, 'deny');
  });

  test.afterAll(async () => a?.cleanup());

  test('two sessions asking the same thing present as ONE card, and one Allow answers both', async () => {
    const w = a.window;
    // both CLIs park. Deliberately not awaited: a held POST does not answer
    // until the UI decides, which is the whole mechanism.
    const first = post(one, bash('npm test'));
    const second = post(two, bash('npm test'));

    const card = w.getByTestId('batch-approval');
    await expect(card).toBeVisible({ timeout: 15_000 });
    // it counts SESSIONS and names the tool and the argument, so nobody
    // answers a question they could not read
    await expect(card).toContainText('2 sessions want to run Bash');
    await expect(card).toContainText('npm test');
    // …and names both sessions by their §5.11 identity, including the one
    // whose card dockview has not mounted
    await expect(w.locator(`[data-batch-member][title="${one}"]`)).toBeVisible();
    await expect(w.locator(`[data-batch-member][title="${two}"]`)).toBeVisible();

    // ONE question, ONE place to answer it: the mounted card's own review bar
    // does not draw the same request a second time
    await expect(w.getByText('Allow Bash?')).toHaveCount(0);
    // …and it does not fall through to "answer it in the terminal" either
    // (#125's bar): the question is answerable, just not from the card
    await expect(w.locator('[data-handoff="permission"]')).toHaveCount(0);

    await w.getByTestId('batch-allow-all').click();

    // one click, two real hook verdicts, down two separate parked responses
    expect(verdict(await first)).toBe('allow');
    expect(verdict(await second)).toBe('allow');
    await expect(card).toHaveCount(0);
    expect(await heldIds(w)).toEqual([]);
  });

  test('declining ONE leaves the other held', async () => {
    const w = a.window;
    const first = post(one, bash('rm -rf build'));
    const second = post(two, bash('rm -rf build'));

    const card = w.getByTestId('batch-approval');
    await expect(card).toBeVisible({ timeout: 15_000 });

    // the cherry-pick half: this session, and only this session
    await w.locator(`[data-batch-member][title="${one}"] [data-batch-deny]`).click();
    expect(verdict(await first)).toBe('deny');

    // the group is down to one session, so it dissolves — the question does
    // NOT: main is still holding it, and the other CLI is still blocked
    await expect(card).toHaveCount(0);
    await expect.poll(() => heldIds(w)).toHaveLength(1);

    // and nothing answered it behind the user's back. `Promise.race` against a
    // timer, because "this promise has not settled" is the actual claim.
    const settled = await Promise.race([
      second.then(() => 'settled' as const),
      new Promise<'still held'>((r) => setTimeout(() => r('still held'), 750)),
    ]);
    expect(settled).toBe('still held');

    // THE INVARIANT the whole suppression rests on: a question the group let go
    // of is back on its own session's bar. Focused explicitly rather than
    // assumed — with two sessions parking at once, which card the reveal policy
    // leaves active is a race, and this claim is not about that race.
    await row(w, two).click();
    await expect(w.getByText('Allow Bash?')).toBeVisible({ timeout: 10_000 });

    // and answered through the UI, so the loop closes where a user would close it
    await w.getByRole('button', { name: 'Allow', exact: true }).click();
    expect(verdict(await second)).toBe('allow');
  });

  test('answering an UNGROUPED request never disturbs a grouped sibling', async () => {
    // The card's review bar renders the head of its FILTERED queue while its
    // grouped request sits earlier in the raw one, so "answer the bar" and
    // "drop the first entry" name different requests. Getting that wrong
    // deletes a request that is still held, from a card that will never show it
    // again — invisible everywhere the moment the group dissolves.
    test.setTimeout(90_000); // three held requests and three card switches
    const w = a.window;
    const grouped = post(one, bash('npm test')); // …joins the group
    const alone = post(one, bash('git status')); // …stays on session one's bar
    const sibling = post(two, bash('npm test')); // …the other half of the group

    await expect(w.getByTestId('batch-approval')).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => heldIds(w)).toHaveLength(3);

    // answer session one's OWN question, on session one's own bar
    await row(w, one).click();
    await expect(w.getByText('Allow Bash?')).toBeVisible({ timeout: 10_000 });
    // `.first()`: the bar prints the command twice — once as the summary line,
    // once in the command block. Both are the right bar.
    await expect(w.getByText('git status').first()).toBeVisible();
    // `exact`: the grouped card's own Deny buttons are named "Deny in <session>",
    // so only the card bar's plain one matches
    await w.getByRole('button', { name: 'Deny', exact: true }).click();
    expect(verdict(await alone)).toBe('deny');

    // the group is untouched, and now dissolving it must hand session one's
    // grouped request back to a card that still knows about it
    await expect(w.getByTestId('batch-approval')).toBeVisible();
    await w.locator(`[data-batch-member][title="${two}"] [data-batch-deny]`).click();
    expect(verdict(await sibling)).toBe('deny');

    await expect(w.getByTestId('batch-approval')).toHaveCount(0);
    await row(w, one).click();
    await expect(w.getByText('Allow Bash?')).toBeVisible({ timeout: 10_000 });
    await expect(w.getByText('npm test').first()).toBeVisible();
    await w.getByRole('button', { name: 'Allow', exact: true }).click();
    expect(verdict(await grouped)).toBe('allow');
  });

  test('two sessions asking DIFFERENT things do not group', async () => {
    // the conservative half of the rule, end to end. Same tool, same argument
    // shape, different value — over-grouping here is a user clicking one Allow
    // and authorising something they never read.
    const w = a.window;
    const first = post(one, bash('rm -rf build'));
    const second = post(two, bash('rm -rf /'));

    // Wait for the RENDERER to have both, not just main. `heldIds` asks main,
    // which can be holding two while the window has processed neither push —
    // and "no grouped card" against a renderer that has heard nothing is a
    // green test over a rule that never ran. Each card's own bar IS the
    // renderer-side witness that its request landed.
    for (const title of [one, two]) {
      await row(w, title).click();
      await expect(w.getByText('Allow Bash?')).toBeVisible({ timeout: 15_000 });
    }
    await expect.poll(() => heldIds(w)).toHaveLength(2);
    // …and with both of them in the renderer, neither is on a grouped card
    await expect(w.getByTestId('batch-approval')).toHaveCount(0);

    for (const id of await heldIds(w)) await answer(w, id, 'deny');
    expect(verdict(await first)).toBe('deny');
    expect(verdict(await second)).toBe('deny');
  });
});
