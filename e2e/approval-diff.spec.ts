// P2-E22-01 (#972): the approval card is a REVIEW SURFACE (§5.16).
//
// ── WHAT ONLY THE REAL APP CAN SETTLE ───────────────────────────────────────
//
// Everything about which payloads are diffable, apply order, the separator trick
// and the bound is arithmetic and is pinned in `lib/approval-diff.test.ts`. The
// dispatch and the fail-open fallback are pinned in `ApprovalPreview.test.tsx` and
// `FeedView.approval-preview.test.tsx`, with Monaco stubbed — because Monaco does
// not run in jsdom at all.
//
// So what is left for this file is the half none of those can reach: **a real
// Monaco diff editor, mounted in a real window, on a real held `can_use_tool`
// request, answered.** A diff editor that fails to lay out, fails to find its
// worker, or renders two empty panes looks identical to a working one from a unit
// test's point of view.
//
// ── THE ARRIVAL CLAIM, AND HOW IT IS MEASURED ───────────────────────────────
//
// The done-when says no new long task when an approval ARRIVES. The card has to be
// readable and answerable in the frame the question appears, and it is: the diff is
// behind `Suspense` with the plain panes as the fallback.
//
// ⚠️ WHAT THIS BUDGET IS AND IS NOT WATCHING. It is NOT watching Monaco being
// parsed lazily — monaco-editor rides in the entry chunk because `DiffPane` is a
// static import, so it is already evaluated long before any approval arrives (see
// `ApprovalDiffView`'s header). What it is watching is the arrival path staying
// clear of whatever the card does next: building two models, laying out an editor,
// computing a diff. If any of that moved onto the render that shows the question,
// this is where it would show up.
//
// Measured with E21-01's own data source: a `PerformanceObserver` on `longtask`,
// which is the browser reporting work it had already done and already timed. The
// budget is deliberately generous — this is a floor under a REGRESSION (someone
// making the import eager, which puts a multi-hundred-millisecond parse on the
// arrival path), not a millisecond-level performance assertion, and a loaded CI
// runner has long tasks of its own that have nothing to do with us.
import { test, expect, Page } from '@playwright/test';
import path from 'path';
import {
  answerHeldPermissions,
  launchApp,
  LaunchedApp,
  permissionHolderEdit,
  streamPrompter,
  tempProjectFolder,
} from './fixtures/app';

/** the diff's host element, which only exists once Monaco is actually mounted */
const diffHost = (w: Page) => w.locator('[data-approval-diff-host]');
/** Monaco's own rendered text layer — proof it laid out rather than merely mounted */
const monacoLines = (w: Page) => w.locator('[data-approval-diff-host] .view-lines');

/**
 * Long tasks from now on, read out of the page.
 *
 * Installed rather than polled: `PerformanceObserver` is the same tier-1 source
 * `lib/perf.ts` uses, and a `longtask` entry cannot be reconstructed after the
 * fact.
 */
async function watchLongTasks(w: Page): Promise<void> {
  await w.evaluate(() => {
    const g = globalThis as unknown as { __longTasks?: Array<{ at: number; ms: number }> };
    g.__longTasks = [];
    // `longtask` is Chromium-only and that is fine: this spec runs in Electron.
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) g.__longTasks!.push({ at: e.startTime, ms: e.duration });
    }).observe({ entryTypes: ['longtask'] });
  });
}

/** The longest long task that had STARTED by `before`, in ms. */
async function worstLongTaskBefore(w: Page, before: number): Promise<number> {
  return w.evaluate((cutoff) => {
    const g = globalThis as unknown as { __longTasks?: Array<{ at: number; ms: number }> };
    return (g.__longTasks ?? [])
      .filter((t) => t.at <= cutoff)
      .reduce((worst, t) => Math.max(worst, t.ms), 0);
  }, before);
}

test.describe('the approval card shows a real diff (E22-01)', () => {
  let a: LaunchedApp;
  test.afterEach(async () => a?.cleanup());

  test('a held Edit renders a Monaco diff, and is answerable before it paints', async () => {
    const folder = tempProjectFolder();
    const title = path.basename(folder);
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    await expect(w.getByText(title).first()).toBeVisible({ timeout: 25_000 });

    await watchLongTasks(w);
    await permissionHolderEdit(a)(title, 'one');

    // 1. THE QUESTION ARRIVES AND IS ANSWERABLE. Asserted before anything about
    //    the diff, and in this order on purpose: the card's job is to ask, and a
    //    body that is still loading must never cost the user the ability to
    //    answer. This is also the whole of the fail-open requirement as a user
    //    experiences it.
    //    The timestamp is taken INSIDE THE PAGE, the moment the bar's node exists,
    //    rather than after Playwright has finished polling for it — otherwise the
    //    window below also covers editor construction and whatever else the app did
    //    in the meantime, which makes it a flake source instead of a floor.
    const arrived = await w.evaluate(async () => {
      const seen = (): boolean => (document.body.textContent ?? '').includes('Allow Edit?');
      const deadline = performance.now() + 15_000;
      while (!seen() && performance.now() < deadline) {
        await new Promise((r) => requestAnimationFrame(() => r(null)));
      }
      return performance.now();
    });
    await expect(w.getByText('Allow Edit?')).toBeVisible({ timeout: 15_000 });
    const allow = w.getByRole('button', { name: 'Allow', exact: true });
    await expect(allow).toBeEnabled();

    // 2. …and the arrival did not carry Monaco's parse with it. See the header:
    //    a floor under the eager-import regression, not a millisecond assertion.
    expect(await worstLongTaskBefore(w, arrived)).toBeLessThan(250);

    // 3. THE DIFF. `.view-lines` is Monaco's own rendered text layer, so this is
    //    "it laid out and painted" rather than "the element exists" — an editor
    //    that cannot measure its host renders an empty one, which is exactly the
    //    failure no unit test can see.
    await expect(diffHost(w)).toBeVisible({ timeout: 25_000 });
    await expect(monacoLines(w).first()).toBeVisible();
    // both sides of the pair the fake sent, in the editor
    await expect(w.getByText('old-one')).toBeVisible();
    await expect(w.getByText('new-one')).toBeVisible();

    // 4. and the question is still answerable with the diff on screen, which is
    //    the round trip the whole card exists for
    await allow.click();
    await expect(w.getByText('Allow Edit?')).toHaveCount(0);
    await expect(diffHost(w)).toHaveCount(0);
  });

  test('the side-by-side / inline toggle changes the diff in place', async () => {
    const folder = tempProjectFolder();
    const title = path.basename(folder);
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    await expect(w.getByText(title).first()).toBeVisible({ timeout: 25_000 });
    await permissionHolderEdit(a)(title, 'one');
    await expect(diffHost(w)).toBeVisible({ timeout: 25_000 });

    // ⚠️ ASSERT THE PREFERENCE, NOT THE RENDERED LAYOUT, and the difference is the
    // bug review caught in the first version of this control. #532's measured floor
    // forces the inline view below 400px of editor, and a card's bar is often under
    // that — so on a narrow card the rendered layout does NOT change when you press
    // the buttons, and a test that polled it would be red for a working app.
    //
    // What must always be true is that the control reflects the CHOICE: two buttons,
    // `aria-pressed` on the one you picked, exactly as the Changes tab does it.
    const group = w.locator('[data-approval-diff-pref]');
    await expect(group).toBeVisible();
    const sideBySide = w.locator('[data-approval-diff-button="side-by-side"]');
    const inline = w.locator('[data-approval-diff-button="inline"]');

    await inline.click();
    await expect(group).toHaveAttribute('data-approval-diff-pref', 'inline');
    await expect(inline).toHaveAttribute('aria-pressed', 'true');
    await expect(sideBySide).toHaveAttribute('aria-pressed', 'false');
    // inline is BELOW the floor, so the rendered layout must follow the choice here
    // whatever the width is
    await expect(group).toHaveAttribute('data-approval-diff-layout', 'inline');

    await sideBySide.click();
    await expect(group).toHaveAttribute('data-approval-diff-pref', 'side-by-side');
    await expect(sideBySide).toHaveAttribute('aria-pressed', 'true');

    // …and when the floor HAS overridden the choice, it says so where a keyboard user
    // can find it: a visible note, not a `title`. Chromium never shows `title` on
    // focus, which is the whole reason `DiffPane` renders this note and the reason
    // this card renders the same one.
    const rendered = await group.getAttribute('data-approval-diff-layout');
    const note = w.getByText('Too narrow for two columns');
    if (rendered === 'inline') await expect(note).toBeVisible();
    else await expect(note).toHaveCount(0);

    // and the editor is still there and still painted — a toggle that rebuilt the
    // editor would blank it, which is why `DiffPane` changes this in place too
    await expect(monacoLines(w).first()).toBeVisible();
  });

  test('a MultiEdit shows every change, labelled, in the order they apply', async () => {
    const folder = tempProjectFolder();
    const title = path.basename(folder);
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    await expect(w.getByText(title).first()).toBeVisible({ timeout: 25_000 });

    // `!permedit a b c` raises THREE separate Edit requests, not one MultiEdit —
    // so the payload has to come from the composer as a real multi-edit shape.
    // `!permmulti` is the fake's verb for exactly this; see
    // `fake-stream-protocol.ts`.
    await streamPrompter(a)(title, '!permmulti');
    await expect(w.getByText('Allow MultiEdit?')).toBeVisible({ timeout: 15_000 });
    await expect(diffHost(w)).toBeVisible({ timeout: 25_000 });

    // THE DONE-WHEN: separate hunks in apply order, not one concatenated blob.
    // The separators are what make that true — Monaco reads a line identical on
    // both sides as unchanged context and breaks its hunks there — so their
    // presence, numbering and ORDER is the assertion.
    //
    // ⚠️ `.first()`, AND THE REASON IS THE DESIGN WORKING. The separator is present
    // identically on BOTH sides — that is what makes Monaco treat it as unchanged
    // context and break its hunks there — so a side-by-side diff renders each label
    // TWICE, once per pane, and a bare locator is a strict-mode violation. (Inline
    // renders it once, so the count is a property of the layout and not worth
    // pinning; that the label EXISTS and that the order holds is the claim.)
    // ⚠️ `.filter({ visible: true })`, and BOTH reasons are Monaco's. Side by side
    // paints a separator in each pane, so the label exists twice; and INLINE keeps
    // the original editor in the DOM with no box at all, so a bare `.first()` can
    // land on a node whose `boundingBox()` is null — which is what it did.
    const visible = (label: string) =>
      w.getByText(label, { exact: false }).filter({ visible: true }).first();
    //
    // ⚠️ ORDER IS ASSERTED BY SCROLLING, NOT BY COMPARING TWO BOXES, and the first
    // version of this taught the lesson the hard way: it read both labels'
    // `boundingBox()` and compared their `y`. That passed in isolation and went red
    // in the full suite, because Monaco VIRTUALISES — a line below the fold is not in
    // the DOM at all, so `change 3 of 3` had no box, and the window being a few
    // pixels shorter was the whole difference. Three changes do not fit in a 180px
    // editor, and they are not meant to: the editor scrolls.
    //
    // So: change 1 is at the TOP (it is what you see before touching anything), and
    // change 3 is reachable by scrolling DOWN. Both facts together are apply order,
    // and both are things a user does.
    await expect(visible('change 1 of 3')).toBeVisible();
    await expect(visible('MULTI_NEW_1')).toBeVisible();

    await diffHost(w).hover();
    await w.mouse.wheel(0, 600);
    await expect(visible('change 3 of 3')).toBeVisible({ timeout: 10_000 });
    await expect(visible('MULTI_NEW_3')).toBeVisible();

    // NOT "and change 1 has gone": that would be an assertion about how far one wheel
    // notch scrolls, which is not a claim worth having and flakes both ways — too
    // strict if the editor keeps change 1 partly on screen, and too weak if it
    // happens to fit everything. The ORDER itself is pinned deterministically where
    // it is arithmetic (`lib/approval-diff.test.ts` asserts the exact joined text,
    // separator by separator). What this file adds is that all of it is in ONE real
    // editor, that change 1 is what you meet first, and that the rest is reachable.

    // answerable, with all of it on screen
    expect(await answerHeldPermissions(a)).toBe(1);
    await expect(w.getByText('Allow MultiEdit?')).toHaveCount(0);
  });

  test('in a SHORT window the diff gives way, and Allow stays reachable', async () => {
    // ⚠️ THE CLAIM THAT MATTERS WHEN THE ROOM RUNS OUT, and it is not "the
    // conversation keeps its floor" — measured, it cannot: a pane short enough leaves
    // less than MIN_FEED once the bar, the diff and one line of composer are in it,
    // and the scroller is the only thing that can pay. That is correct fail-open
    // behaviour and `APPROVAL_DIFF_BLOCK_SIZE` says so.
    //
    // What must NEVER give is the answer. §5.16's subject is that a held request gets
    // answered, so **Allow** and **Deny** stay on screen and clickable however little
    // room there is — and the diff shrinks with the window (`min(180px, 24vh)`) rather
    // than pushing them off the bottom. This is the assertion #716 used to carry by
    // accident, made on purpose and where it belongs.
    const folder = tempProjectFolder();
    const title = path.basename(folder);
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    await expect(w.getByText(title).first()).toBeVisible({ timeout: 25_000 });
    await a.app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      win.unmaximize();
      // Deliberately mean. The window's own minimum clamps this upward, which is
      // fine: the point is the shortest pane the app will actually give a user.
      win.setContentSize(1024, 480);
    });

    await permissionHolderEdit(a)(title, 'one');
    await expect(w.getByText('Allow Edit?')).toBeVisible({ timeout: 15_000 });
    await expect(diffHost(w)).toBeVisible({ timeout: 25_000 });

    // the diff took the clamp, not the whole window
    const host = (await diffHost(w).boundingBox())!;
    expect(host.height).toBeLessThan(181);
    expect(host.height).toBeGreaterThan(0);

    // …and all three answers are on screen and usable, which is the whole point
    const allow = w.getByRole('button', { name: 'Allow', exact: true });
    const deny = w.getByRole('button', { name: 'Deny', exact: true });
    await expect(allow).toBeInViewport();
    await expect(deny).toBeInViewport();
    await allow.click();
    await expect(w.getByText('Allow Edit?')).toHaveCount(0);
  });

  test('a Bash command keeps the plain preview — no editor where there is no diff', async () => {
    const folder = tempProjectFolder();
    const title = path.basename(folder);
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    await expect(w.getByText(title).first()).toBeVisible({ timeout: 25_000 });

    await streamPrompter(a)(title, '!permbash npm run build');
    await expect(w.getByText('Allow Bash?')).toBeVisible({ timeout: 15_000 });
    await expect(w.locator('[data-preview="command"]')).toHaveText('npm run build');
    // Given time to be wrong: an assertion that something does not appear is
    // worth only the wait it gives it.
    await w.waitForTimeout(2_000);
    await expect(diffHost(w)).toHaveCount(0);
  });
});
