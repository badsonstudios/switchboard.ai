// P2-E12-06: Feed view v1 — read-only rendered blocks from a live conversation.
//
// TRANSPORT SCOPE — THERE IS ONE (#952). This file used to be tagged `[pty]` in its
// entirety, and the tag was accurate: "the test writes JSONL and the watcher tails
// it" WAS the scope, because the transcript-derive pipeline was switched off for a
// stream session (`deriveFeed: record.transport !== 'stream'`) and a stream session
// has been the default since #381. Every rendering, scroll and keyboard assertion
// here was about the non-default path, however green it was.
//
// It now drives the only path there is. `stream-feed.spec.ts` (P2-E18-14) remains
// the Direct-lane counterpart and is no longer a counterpart to anything — the two
// files overlap on tool boxes and the #174 walk, and the duplication is deliberate
// for now: this file reaches claims that one does not (markdown, the gutter and dot
// rules, the clipboard round trip, the popout) and one shared setup would couple
// them.
//
// NOTHING HERE IS `fixme` ANY MORE. There were two.
//
// Local slash-command output (#978) was never the gap its `fixme` advertised —
// it moved to the stream at #140 and `e2e/stream.spec.ts` has covered it since.
// The disabled test measured the transcript path #952 deleted on purpose, and
// leaving it disabled with a ticket number on it is what persuaded an issue, the
// manual and a release note that the feature was missing. Deleted, with the
// reasoning kept where the test was.
//
// The other was subagent captions (#977) — a REGRESSION rather
// than a gap, because #788 shipped the feature and `deriveFeed: false` for a
// stream session switched off the subagent files along with the main
// conversation it was aimed at. It is live again, and it came back with its
// fixture rather than a rewrite: #977's probe re-confirmed the on-disk layout on
// CLI 2.1.280.
import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import {
  findFile,
  hookPoster,
  launchApp,
  permissionHolderBash,
  LaunchedApp,
  pollAsync,
  tabFromFeedToComposer,
  tempProjectFolder,
  setTheme,
  streamPrompter,
} from './fixtures/app';
import { FAKE_SESSION_ID } from '../src/main/providers/fake-stream-ids';

/**
 * A block ARRIVES, without the user having touched the composer.
 *
 * Goes through the bridge rather than the box on purpose — see the note on the
 * describe below. `streamPrompter` resolves the live id per call, so it works on
 * a card that has been restarted.
 */
async function arrive(app: LaunchedApp, title: string, text: string): Promise<void> {
  await streamPrompter(app)(title, text);
}

// ── HOW THIS FILE PROVOKES A CONVERSATION (#952) ─────────────────────────────
//
// It used to WRITE the CLI's transcript JSONL and let the watcher derive Feed
// blocks from it. That worked only because the shell-in-a-PTY fake made every
// test session a PTY: `deriveFeed` was `record.transport !== 'stream'`, so for a
// real Direct session — the default since #381 — the transcript has NOT been the
// Feed's source since E18-10. The Feed is built from typed messages, and the
// transcript is kept for usage, the native id and drift detection.
//
// So the content arrives the way it does in production: through the session. Two
// levers, and the choice between them matters:
//
//   • `arrive()` submits through the BRIDGE (`sessions.submitPrompt`), which is
//     the passive path — no composer focus, no §5.8 auto-minimize, no draft
//     clearing. That is what the old file append was: a block showing up while
//     the user is doing something else. The scroll tests below depend on that
//     distinction, so they must not type.
//   • typing in the composer is a USER GESTURE and is used only where the gesture
//     is the subject.
//
// `!bulk <n> <prefix>` is the fake's volume verb, written for exactly these
// tests: the tail-pin, the reading-position restore and the keyboard walk all
// need a feed taller than the pane.
test.describe('Feed view (E12-06)', () => {
  let a: LaunchedApp;
  test.afterEach(async () => a?.cleanup());

  test('renders assistant text and a collapsed tool row from a live turn', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    const title = folder.split(/[\\/]/).pop()!;
    await expect(w.getByText(title).first()).toBeVisible();

    // Feed is the DEFAULT view (E12-07) — the empty state shows with no click
    await expect(w.getByText('No conversation yet')).toBeVisible();

    // PROSE first, through the reply echo — which is how any assistant text gets
    // here now the transcript is not the Feed's source (#952). The markdown is the
    // point: `**feed**` has to arrive as markup a renderer can render.
    await arrive(a, title, 'Hello from the **feed**');
    // ⚠️ SCOPED TO THE CONVERSATION, and it has to be. The prompt now shows up in
    // three other places — the rail row, the card's task label (#883's provisional
    // label fills a blank from the prompt) and the user block — so a bare
    // `getByText` is a strict-mode violation, and a `.first()` would quietly assert
    // the RAIL instead of the feed.
    const prose = w.locator('[data-feed-region] .feed-md', { hasText: 'Hello from the' });
    await expect(prose.first()).toBeVisible();
    await expect(w.locator('[data-feed-region] .feed-md strong', { hasText: 'feed' }).first()).toBeVisible();

    // `!tools` is the fake's TOOL TURN, and it replaces a hand-written transcript
    // (#952). It emits the measured stream shape — one `assistant` message per
    // content block, each arriving mid-stream — for a Bash call with a two-line
    // command ('Stream check'), an Edit (STREAM_OLD → STREAM_NEW), a plain Read
    // row, a TodoWrite checklist, a `tool_result` for the Bash call, and prose
    // (STREAM_PROSE) AFTER the tools so block order is observable.
    //
    // The literals below are its, not this file's: the old fixtures spelled the
    // same structure BOX_/KEYS_/RICH_. Nothing about what is being claimed moved.
    await arrive(a, title, '!tools');

    await expect(w.getByText('Read', { exact: true })).toBeVisible(); // collapsed tool row
    // expanding the tool row reveals the input detail
    await w.getByText('Read', { exact: true }).click();
    await expect(w.getByText(/file_path/)).toBeVisible();

    // rich blocks v2 (E10-06): Edit diff panes + Bash IN/OUT + todos checklist
    await expect(w.getByText('Stream check')).toBeVisible(); // Bash header description
    await expect(w.getByText('STREAM_NEW')).toBeVisible(); // Edit new pane (open by default)
    await expect(w.getByText('+1 / -1 lines')).toBeVisible(); // edit stats subtitle
    await expect(w.getByText('Update Todos')).toBeVisible();
    await expect(w.getByText('first stream step')).toBeVisible();
    // OUT section expands to the tool result
    await w.getByText('▸ OUT').click();
    await expect(w.getByText('STREAM_OUT_LINE2').last()).toBeVisible();

    // verbosity presets switch live (E12-07): quiet hides tool rows
    await w.getByRole('button', { name: 'quiet' }).click();
    await expect(w.getByText('Read', { exact: true })).toHaveCount(0);
    await expect(prose.first()).toBeVisible(); // prose stays
    await w.getByRole('button', { name: 'normal' }).click();
    await expect(w.getByText('Read', { exact: true })).toBeVisible();
  });

  test('a long history opens scrolled to the BOTTOM (Dan 2026-07-23)', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    const title = path.basename(folder);
    await expect(w.getByText(title).first()).toBeVisible({ timeout: 25_000 });

    await arrive(a, title, '!bulk 60 SCROLL_BLOCK_');

    // the tail is on screen, the head is not — we're pinned to the bottom
    await expect(w.getByText('SCROLL_BLOCK_60')).toBeVisible({ timeout: 15_000 });
    await expect(w.getByText('SCROLL_BLOCK_60')).toBeInViewport();
    await expect(w.getByText('SCROLL_BLOCK_1', { exact: true })).not.toBeInViewport();
  });

  test('switching away and back keeps your reading position (Dan 2026-07-26)', async () => {
    // Dockview HIDES a background panel and the browser resets a hidden
    // element's scrollTop to 0, so returning to a session you had scrolled up
    // in dumped you at the very top — the tail-pin only knew how to reach the
    // bottom. Dan hit it by clicking a finished session's Events row.
    const folder = tempProjectFolder();
    const other = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    const title = path.basename(folder);
    await expect(w.getByText(title).first()).toBeVisible({ timeout: 25_000 });

    await arrive(a, title, '!bulk 60 KEEP_BLOCK_');
    await expect(w.getByText('KEEP_BLOCK_60')).toBeVisible({ timeout: 15_000 });

    const feed = () =>
      w.evaluate(() => {
        const el = [...document.querySelectorAll('div')].find(
          (d) => d.scrollHeight > d.clientHeight + 40 && getComputedStyle(d).overflowY === 'auto'
        );
        return el ? Math.round(el.scrollTop) : -1;
      });

    // Read something partway up, with a REAL wheel gesture — that is what the
    // scroll handler exists to notice, and it keeps the test honest about the
    // path a user actually takes.
    await w.getByText('KEEP_BLOCK_30').hover();
    await w.mouse.wheel(0, -700);
    await w.waitForTimeout(400); // let the scroll event land and unpin the tail
    const target = await feed();
    expect(target).toBeGreaterThan(0);

    // switch to another session, then come back
    await a.app.evaluate(({ dialog }, d) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [d] });
    }, other);
    await w.getByRole('button', { name: '+ session' }).click();
    await expect(w.getByText(path.basename(other)).first()).toBeVisible({ timeout: 25_000 });
    await w.keyboard.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+1`);

    await expect.poll(feed, { timeout: 10_000 }).toBe(target);

    // and a block arriving while you're reading must not yank you anywhere
    await arrive(a, title, 'KEEP_BLOCK_61');
    await expect(w.getByText('KEEP_BLOCK_61').first()).toBeAttached({ timeout: 15_000 });
    expect(await feed()).toBe(target);
  });

  test('a scroll nobody asked for cannot unpin the tail (Dan 2026-07-26)', async () => {
    // The approval bar docks BELOW the feed, so it shrinks the viewport and
    // pushes content under the fold. `pinned` used to be re-derived from that
    // raw measurement, which reads identically to "the user scrolled up" — one
    // such sample left the feed stuck short of the bottom with output cut off.
    // Only a real gesture may move the pin now, so a layout-induced scroll
    // must be corrected back to the tail.
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    const title = path.basename(folder);
    await expect(w.getByText(title).first()).toBeVisible({ timeout: 25_000 });

    await arrive(a, title, '!bulk 60 NUDGE_BLOCK_');
    await expect(w.getByText('NUDGE_BLOCK_60')).toBeInViewport({ timeout: 15_000 });

    const feed = () =>
      w.evaluate(() => {
        const el = [...document.querySelectorAll('div')].find(
          (d) => d.scrollHeight > d.clientHeight + 40 && getComputedStyle(d).overflowY === 'auto'
        );
        return el ? Math.round(el.scrollHeight - el.scrollTop - el.clientHeight) : -1;
      });
    await expect.poll(feed, { timeout: 5_000 }).toBeLessThan(2); // at the tail

    // a scroll with NO gesture behind it — exactly what a layout change causes
    await w.evaluate(() => {
      const el = [...document.querySelectorAll('div')].find(
        (d) => d.scrollHeight > d.clientHeight + 40 && getComputedStyle(d).overflowY === 'auto'
      )!;
      el.scrollTop = 200;
    });

    // it must come back, and stay back as new output lands
    await expect.poll(feed, { timeout: 5_000 }).toBeLessThan(2);
    await arrive(a, title, 'NUDGE_BLOCK_61');
    await expect(w.getByText('NUDGE_BLOCK_61').first()).toBeInViewport({ timeout: 15_000 });
  });

  test('switching away and back keeps you GLUED to the tail if that is where you were', async () => {
    // the other half of the same rule: a tail-pinned session must come back
    // pinned, not at the offset it happened to hold
    const folder = tempProjectFolder();
    const other = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    const title = path.basename(folder);
    await expect(w.getByText(title).first()).toBeVisible({ timeout: 25_000 });

    await arrive(a, title, '!bulk 60 TAIL_BLOCK_');
    await expect(w.getByText('TAIL_BLOCK_60')).toBeInViewport({ timeout: 15_000 });

    await a.app.evaluate(({ dialog }, d) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [d] });
    }, other);
    await w.getByRole('button', { name: '+ session' }).click();
    await expect(w.getByText(path.basename(other)).first()).toBeVisible({ timeout: 25_000 });
    await w.keyboard.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+1`);

    await expect(w.getByText('TAIL_BLOCK_60')).toBeInViewport({ timeout: 10_000 });
  });

  test('composer autonomy chip cycles and survives a relaunch (E10-05)', async () => {
    const folder = tempProjectFolder();
    const title = folder.split(/[\\/]/).pop()!;
    // assign to the shared handle IMMEDIATELY: an assertion failing before
    // close() must leave afterEach something to kill, or the Electron/PTY
    // tree leaks and poisons CI teardown (review P1-test #16)
    a = await launchApp({ seedFolder: folder });
    const first = a;
    const w = first.window;
    await expect(w.getByText(title).first()).toBeVisible({ timeout: 25_000 });

    // by test id, not by title: the hover copy is the product of #534 and is
    // meant to be edited freely, which a locator pinned to it would punish
    const chip = w.getByTestId('composer-autonomy');
    await expect(chip).toContainText('ask');
    await chip.click(); // -> plan
    await expect(chip).toContainText('plan');

    await w.waitForTimeout(900); // debounced store save
    await first.close();
    a = await launchApp({ home: first.home });
    await expect(a.window.getByText(title).first()).toBeVisible({ timeout: 25_000 });
    await expect(a.window.getByTestId('composer-autonomy')).toContainText('plan', {
      timeout: 20_000,
    });
  });

  // #156's transcript-path e2e USED TO LIVE HERE, and #978 deleted it rather
  // than fixing it. Worth the paragraph, because the deletion is the finding.
  //
  // It wrote three real JSONL entries to disk — a `<local-command-caveat>` meta
  // line, the `<command-name>` invocation, and the output as
  // `system`/`subtype:"local_command"` — and asserted the Feed rendered the
  // third. That is the TRANSCRIPT-driven Feed, which #952 deleted on purpose:
  // a stream session is watched with `deriveFeed: 'sidechains'`, and
  // `watcher.ts` returns early for the bound main transcript by design. The
  // test could never pass again and was set `test.fixme` with #978 on it.
  //
  // ⚠️ AND THAT PLACEHOLDER BECAME EVIDENCE. `test.fixme` states the strongest
  // claim a disabled test can make — "this does not work" — and it was read
  // that way: by the issue (#978 was filed 2h12m BEFORE #952 even merged,
  // predicting a breakage), by `docs/manual/05-slash-commands.md`, and by
  // v0.8.100's in-app release notes, which told every user the output was
  // missing. It was never missing. The capability moved to the stream at #140
  // and has been covered since by `e2e/stream.spec.ts` -> "a local slash
  // command's output renders (#156)", which types `/usage` into the composer
  // and passes unmodified.
  //
  // The transcript shape the fixture recorded is not lost: it is in
  // `spike/findings/978-local-slash-commands-on-stream.md`, re-measured on CLI
  // 2.1.280, beside the stream shape it disagrees with. A findings note is
  // where a measurement belongs; a disabled test is where it rots into a
  // rumour.

  // #91, Dan's live feedback 2026-07-26. Two presentation rules that only the
  // real window can settle: a tool block is a BOX whose whole body expands it,
  // and a plain answer carries no timeline dot while keeping its left edge.
  test('tool blocks are clickable boxes and prose has no dot (#91)', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    await expect(w.getByText(folder.split(/[\\/]/).pop()!).first()).toBeVisible({ timeout: 25_000 });

    // `!tools` is the fake's TOOL TURN, and it replaces a hand-written transcript
    // (#952). It emits the measured stream shape — one `assistant` message per
    // content block, each arriving mid-stream — for a Bash call with a two-line
    // command ('Stream check'), an Edit (STREAM_OLD → STREAM_NEW), a plain Read
    // row, a TodoWrite checklist, a `tool_result` for the Bash call, and prose
    // (STREAM_PROSE) AFTER the tools so block order is observable.
    //
    // The literals below are its, not this file's: the old fixtures spelled the
    // same structure BOX_/KEYS_/RICH_. Nothing about what is being claimed moved.
    await arrive(a, path.basename(folder), '!tools');

    // 1. every tool block is its own bordered container
    await expect(w.locator('[data-feed-box="bash"]')).toBeVisible({ timeout: 20_000 });
    await expect(w.locator('[data-feed-box="edit"]')).toBeVisible();
    await expect(w.locator('[data-feed-box="tool"]')).toBeVisible(); // the Read row

    // 2. the ANSWER has no dot; the prompt and the tool calls still do
    await expect(w.locator('[data-feed-block="assistant"] [data-feed-dot]')).toHaveCount(0);
    await expect(w.locator('[data-feed-block="user"] [data-feed-dot]').first()).toBeAttached();
    await expect(w.locator('[data-feed-block="tool"] [data-feed-dot]').first()).toBeAttached();

    // …and dropping the dot must not drop the GUTTER: prose starts on the same
    // column as the boxes, or the conversation zig-zags down the page
    const prose = await w.locator('.feed-md', { hasText: 'STREAM_PROSE' }).boundingBox();
    const box = await w.locator('[data-feed-box="edit"]').boundingBox();
    expect(Math.abs(prose!.x - box!.x)).toBeLessThanOrEqual(1);

    // 3. the BOX BODY expands, not just the header. The Edit block's stats
    //    subtitle is box body by construction — it is neither the header line
    //    nor an inner expander — so a click there proves the whole container is
    //    the target.
    await expect(w.getByText('STREAM_NEW')).toBeVisible(); // Edit opens expanded
    await w.getByText('+1 / -1 lines').click();
    await expect(w.getByText('STREAM_NEW')).toHaveCount(0);
    await w.getByText('+1 / -1 lines').click();
    await expect(w.getByText('STREAM_NEW')).toBeVisible();

    //    …and the Bash box opens from its PADDING, where there is nothing but
    //    the container itself — Dan's ask in his own words: click the box and
    //    see what the command was.
    await expect(w.getByText('▸ IN')).toBeVisible();
    await expect(w.getByText('▸ OUT')).toBeVisible();
    await w.locator('[data-feed-box="bash"]').click({ position: { x: 3, y: 2 } });
    await expect(w.getByText('▾ IN')).toBeVisible();
    await expect(w.getByText('▾ OUT')).toBeVisible();
    await expect(w.getByText('STREAM_CMD_LINE2')).toBeVisible(); // the WHOLE command
    await expect(w.getByText('STREAM_OUT_LINE2')).toBeVisible();

    // 4. an expander INSIDE the box owns its own click (it must not also flip
    //    the box, or every fine-grained control would fight its container)
    await w.locator('[data-feed-box="bash"]').click({ position: { x: 3, y: 2 } }); // close both
    await expect(w.getByText('▸ IN')).toBeVisible();
    await w.getByText('▸ IN').click();
    await expect(w.getByText('▾ IN')).toBeVisible();
    await expect(w.getByText('▸ OUT')).toBeVisible(); // OUT stayed shut

    // 5. the container reads as a container in BOTH shipped themes — an edge
    //    the same colour as its fill is not a box
    const edges = (): Promise<{ border: string; fill: string }> =>
      w.locator('[data-feed-box="edit"]').evaluate((el) => {
        const s = getComputedStyle(el);
        return { border: s.borderTopColor, fill: s.backgroundColor };
      });
    // pinned explicitly: the app boots on `system`, which follows the OS, so
    // "whatever it started as" is not one of the two themes we mean to check
    await setTheme(w, 'nordic');
    await expect(w.locator('html')).toHaveAttribute('data-theme-id', 'nordic');
    const dark = await edges();
    expect(dark.border).not.toBe(dark.fill);

    await setTheme(w, 'daylight');
    await expect(w.locator('html')).toHaveAttribute('data-theme-id', 'daylight');
    await expect.poll(async () => (await edges()).fill).not.toBe(dark.fill);
    const light = await edges();
    expect(light.border).not.toBe(light.fill);
  });

  // #174. Every expander in the conversation used to be a div with an onClick:
  // reachable with a mouse and with nothing else. This walks the whole keyboard
  // path — into the conversation, between its expanders, open one, back out —
  // and checks the semantics are honest while it does (real buttons carrying
  // aria-expanded; no role="button" on a box that contains other buttons).
  test('the conversation is reachable and operable by keyboard alone (#174)', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    await expect(w.getByText(folder.split(/[\\/]/).pop()!).first()).toBeVisible({ timeout: 25_000 });

    // `!tools` is the fake's TOOL TURN, and it replaces a hand-written transcript
    // (#952). It emits the measured stream shape — one `assistant` message per
    // content block, each arriving mid-stream — for a Bash call with a two-line
    // command ('Stream check'), an Edit (STREAM_OLD → STREAM_NEW), a plain Read
    // row, a TodoWrite checklist, a `tool_result` for the Bash call, and prose
    // (STREAM_PROSE) AFTER the tools so block order is observable.
    //
    // The literals below are its, not this file's: the old fixtures spelled the
    // same structure BOX_/KEYS_/RICH_. Nothing about what is being claimed moved.
    await arrive(a, path.basename(folder), '!tools');
    await expect(w.locator('[data-feed-box="bash"]')).toBeVisible({ timeout: 20_000 });

    // 1. EVERY expander is a real <button aria-expanded>, and no box lies about
    //    being one. The box contains the Bash IN/OUT buttons, so role="button"
    //    on it would be invalid ARIA — that lie is the whole reason #174 exists.
    const expanders = w.locator('[data-feed-expander]');
    await expect(expanders).toHaveCount(5); // bash header + IN + OUT, edit header, Read row
    for (const el of await expanders.all()) {
      await expect(el).toHaveJSProperty('tagName', 'BUTTON');
      await expect(el).toHaveAttribute('aria-expanded', /true|false/);
    }
    await expect(w.locator('[data-feed-box][role]')).toHaveCount(0);

    const focused = (): Promise<{ region: boolean; expander: boolean; label: string; expanded: string | null; ring: string }> =>
      w.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        return {
          region: !!el?.hasAttribute('data-feed-region'),
          expander: !!el?.hasAttribute('data-feed-expander'),
          label: (el?.textContent ?? '').trim().slice(0, 40),
          expanded: el?.getAttribute('aria-expanded') ?? null,
          ring: el ? getComputedStyle(el).outlineWidth : '',
        };
      });

    // 2. the conversation is ONE tab stop, and it is reachable from the chrome
    //    above it (the verbosity chips)
    await w.getByRole('button', { name: 'normal', exact: true }).click();
    await w.keyboard.press('Tab'); // -> firehose
    await w.keyboard.press('Tab'); // -> the conversation region
    expect((await focused()).region).toBe(true);
    await expect(w.getByText('↑ ↓ move · Enter expands · Esc leaves')).toBeVisible();

    // 3. Up enters at the BOTTOM of the transcript — the Read row, last block —
    //    with a ring you can actually see
    await w.keyboard.press('ArrowUp');
    let f = await focused();
    expect(f.expander).toBe(true);
    expect(f.label).toContain('Read');
    expect(f.expanded).toBe('false');
    expect(f.ring).not.toBe('0px');

    // 4. Enter operates it — the tool detail appears and the state is announced
    await w.keyboard.press('Enter');
    await expect(w.getByText(/file_path/)).toBeVisible();
    expect((await focused()).expanded).toBe('true');

    // 5. the arrows walk the whole set, including the expanders INSIDE the Bash
    //    box that no box-level shortcut could ever reach on their own
    await w.keyboard.press('Home'); // -> the first expander, the Bash header
    expect((await focused()).label).toContain('Stream check');
    await w.keyboard.press('ArrowDown'); // -> Bash IN
    await w.keyboard.press('ArrowDown'); // -> Bash OUT
    f = await focused();
    expect(f.label).toContain('OUT');
    await w.keyboard.press('Enter');
    await expect(w.getByText('STREAM_OUT_LINE2').last()).toBeVisible();
    await expect(w.getByText('▸ IN')).toBeVisible(); // IN stayed shut — no coarse toggle

    // 6. Escape hands focus back to the region, and tabbing out of it reaches
    //    the composer: a conversation with hundreds of blocks must never bury
    //    it. Past #442's conditional stop where the window is small enough for
    //    it to exist — this walk is #524's twin on the transcript path, written
    //    the same way and exposed to the same geometry (see the helper).
    await w.keyboard.press('Escape');
    expect((await focused()).region).toBe(true);
    await tabFromFeedToComposer(w);
    await expect(w.getByPlaceholder(/Prompt this session/)).toBeFocused();
  });

  // #196. #174 named the conversation landmark and gave every card the same
  // name, so a screen-reader user with four cards open got four identical
  // landmarks. The name now carries the session title — and the title it
  // carries has to be the CURRENT one, which is the half a prop threaded from
  // dockview's panel api would have got wrong: dockview is told a panel's
  // title once, at creation, and never again.
  test('the conversation landmark names its session, and follows a rename (#196)', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    const title = folder.split(/[\\/]/).pop()!;
    // the RAIL row, not the card header: it is what the rename below acts on
    await expect(w.locator('nav [draggable="true"]')).toHaveCount(1, { timeout: 25_000 });

    // named by role and accessible name — the same lookup a screen reader's
    // landmark list makes, rather than an attribute we happen to have written
    await expect(w.getByRole('region', { name: `Conversation — ${title}` })).toBeVisible();

    // rename from the rail: double-click the row, retype, Enter
    await w.locator('nav [draggable="true"]').first().dblclick();
    const field = w.locator('nav input');
    await expect(field).toBeVisible();
    await field.fill('renamed-session');
    await field.press('Enter');

    await expect(
      w.getByRole('region', { name: 'Conversation — renamed-session' })
    ).toBeVisible({ timeout: 10_000 });
    await expect(w.getByRole('region', { name: `Conversation — ${title}` })).toHaveCount(0);
  });

  // A popped-out card is a first-class host (#226), and its landmark is the
  // one that most needs a name: the window has no rail and no tab strip, so
  // the region's name is the only thing in it that says which session it is.
  // dockview ADOPTS the group's DOM into the new window rather than
  // re-rendering it, so this is really asserting that nothing about the name
  // depended on the main window — including the rename that arrives after the
  // move.
  test('a popped-out conversation keeps its named landmark (#196)', async () => {
    test.skip(
      process.platform === 'linux',
      'popout opens a 2nd OS window — unreliable under headless xvfb'
    );
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    const title = folder.split(/[\\/]/).pop()!;
    await expect(w.locator('nav [draggable="true"]')).toHaveCount(1, { timeout: 25_000 });

    await w.getByTitle('Pop out into its own window').click();
    // by URL, not by "the other one": devtools or a rescued window would both
    // satisfy `!== w` and neither hosts a session
    await expect
      .poll(() => a.app.windows().filter((p) => p.url().includes('popout.html')).length, {
        timeout: 15_000,
      })
      .toBe(1);
    const popout = a.app.windows().find((p) => p.url().includes('popout.html'))!;
    await popout.waitForLoadState('domcontentloaded');

    await expect(popout.getByRole('region', { name: `Conversation — ${title}` })).toBeVisible({
      timeout: 15_000,
    });

    // renamed from the main window's rail, the popout's landmark follows
    await w.locator('nav [draggable="true"]').first().dblclick();
    const field = w.locator('nav input');
    await expect(field).toBeVisible();
    await field.fill('popped-and-renamed');
    await field.press('Enter');
    await expect(
      popout.getByRole('region', { name: 'Conversation — popped-and-renamed' })
    ).toBeVisible({ timeout: 15_000 });

    // hand the second OS window back before teardown rather than leaving it to
    // the tree-kill: a live popout has outlived cleanup on CI before
    await popout.evaluate(() => window.close());
  });

  // #903's done-when 6, and the cheapest possible cover for it. The whole
  // claim is that Clear's confirmation and its focus belong to the POPOUT's
  // own document — the #573 rule — so the only thing worth asserting from a
  // machine is that the question appears in that window and takes focus with
  // it. Whether it LOOKS right there is a hand-test line in the tracker.
  test("the composer's Clear asks its question in the popout's own window (#903)", async () => {
    test.skip(
      process.platform === 'linux',
      'popout opens a 2nd OS window — unreliable under headless xvfb'
    );
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    const title = folder.split(/[\\/]/).pop()!;
    await expect(w.locator('nav [draggable="true"]')).toHaveCount(1, { timeout: 25_000 });

    // The session controls are LOCKED while 'starting' (§5.10's startup-dialog
    // rule), and the fake provider stays there until the CLI says otherwise —
    // so play the CLI, the way `slash-commands.spec.ts` does for the ⋯ menu.
    const post = await hookPoster(a);
    await post(title, { hook_event_name: 'SessionStart', source: 'startup' });

    await w.getByTitle('Pop out into its own window').click();
    await expect
      .poll(() => a.app.windows().filter((p) => p.url().includes('popout.html')).length, {
        timeout: 15_000,
      })
      .toBe(1);
    const popout = a.app.windows().find((p) => p.url().includes('popout.html'))!;
    await popout.waitForLoadState('domcontentloaded');

    const clear = popout.getByTestId('composer-clear');
    await expect(clear).toBeEnabled({ timeout: 25_000 });
    await clear.click();

    // the question is HERE, not in the window the card came from
    await expect(popout.getByTestId('composer-clear-go')).toBeVisible();
    await expect(w.getByTestId('composer-clear-go')).toHaveCount(0);
    // …and so is the focus, on the safe answer
    expect(await popout.evaluate(() => document.activeElement?.getAttribute('data-testid'))).toBe(
      'composer-clear-cancel'
    );

    // back out: nothing is cleared, and focus returns to the button that asked
    await popout.getByTestId('composer-clear-cancel').click();
    await expect(popout.getByTestId('composer-clear-go')).toHaveCount(0);
    expect(await popout.evaluate(() => document.activeElement?.getAttribute('data-testid'))).toBe(
      'composer-clear'
    );

    await popout.evaluate(() => window.close());
  });

  // #527. The one thing only the real app can settle: a click on a link in a
  // reply reaches `shell.openExternal` IN MAIN — across the preload bridge,
  // through the IPC broker's capability check, past main's scheme allowlist.
  // Everything about WHICH hrefs are allowed is a table in
  // `markdown-links.test.ts`; this is the round trip, and it is the half that
  // was missing (the renderer never called the seam at all, and
  // `will-navigate` swallowed the click in silence).
  //
  // `shell.openExternal` is REPLACED in the main process rather than allowed
  // to run: the real one launches the machine's actual browser, and a CI run
  // that opens a browser window per test is a bad neighbour.
  test('clicking a link in a reply reaches the browser seam (#527)', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    const title = path.basename(folder);
    await expect(w.getByText(title).first()).toBeVisible({ timeout: 25_000 });

    const opened = async (): Promise<string[]> =>
      a.app.evaluate(() => (globalThis as unknown as { __opened?: string[] }).__opened ?? []);
    await a.app.evaluate(({ shell }) => {
      const g = globalThis as unknown as { __opened: string[] };
      g.__opened = [];
      // `defineProperty`, not assignment: electron's module objects use getters
      // for their members, and a plain `shell.openExternal = …` is silently
      // dropped on one.
      Object.defineProperty(shell, 'openExternal', {
        configurable: true,
        value: (url: string): Promise<void> => {
          g.__opened.push(url);
          return Promise.resolve();
        },
      });
    });

    // The same markdown, arriving as the reply to a prompt (#952). The fake
    // echoes what it is asked, so any assistant TEXT a test needs — markdown,
    // links, a code fence — can be provoked this way; what it cannot invent is a
    // stream message the real CLI never sends.
    //
    // The three URLs are the point and are unchanged: one safe, and two the
    // renderer must refuse to hand to the OS.
    await arrive(
      a,
      title,
      [
        'See [the docs](https://links.test/docs) for more.',
        '',
        'And [do not open this](javascript:globalThis.__pwned=1) either,',
        'nor [this one](file:///C:/Windows/System32/calc.exe).',
      ].join('\n')
    );

    const feed = w.getByRole('region', { name: /^Conversation/ });
    const link = feed.getByText('the docs', { exact: true });
    await expect(link).toBeVisible({ timeout: 20_000 });

    // 1. the good one goes to the OS browser
    const before = w.url();
    await link.click();
    await expect.poll(opened, { timeout: 5_000 }).toEqual(['https://links.test/docs']);
    // 2. and the app is still the app — no in-app navigation happened
    expect(w.url()).toBe(before);

    // 3. the hostile ones do nothing at all, and never ran
    await feed.getByText('do not open this', { exact: true }).click();
    await feed.getByText('this one', { exact: true }).click();
    await expect.poll(opened, { timeout: 2_000 }).toEqual(['https://links.test/docs']);
    expect(w.url()).toBe(before);
    expect(await w.evaluate(() => (window as unknown as { __pwned?: unknown }).__pwned)).toBe(
      undefined
    );
  });

  // The per-window half (#477's lesson, and #477 is why the copy button in a
  // reply is delegated at all): dockview ADOPTS the group's DOM into the
  // popped-out window, so a handler that only works because of where the main
  // window's listeners sit stops working the moment the card is torn off.
  test('a link still opens the browser from a popped-out card (#527)', async () => {
    test.skip(
      process.platform === 'linux',
      'popout opens a 2nd OS window — unreliable under headless xvfb'
    );
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    await expect(w.locator('nav [draggable="true"]')).toHaveCount(1, { timeout: 25_000 });

    await a.app.evaluate(({ shell }) => {
      const g = globalThis as unknown as { __opened: string[] };
      g.__opened = [];
      Object.defineProperty(shell, 'openExternal', {
        configurable: true,
        value: (url: string): Promise<void> => {
          g.__opened.push(url);
          return Promise.resolve();
        },
      });
    });

    // the link arrives in a reply, through the echo (#952) — the same lever the
    // in-window link test above uses, so the only difference between them stays the
    // window the click happens in
    await arrive(a, path.basename(folder), 'See [popped docs](https://popped.test/x).');
    await expect(w.getByText('popped docs', { exact: true })).toBeVisible({ timeout: 20_000 });

    await w.getByTitle('Pop out into its own window').click();
    await expect
      .poll(() => a.app.windows().filter((p) => p.url().includes('popout.html')).length, {
        timeout: 15_000,
      })
      .toBe(1);
    const popout = a.app.windows().find((p) => p.url().includes('popout.html'))!;
    await popout.waitForLoadState('domcontentloaded');

    const link = popout.getByText('popped docs', { exact: true });
    await expect(link).toBeVisible({ timeout: 15_000 });
    await link.click();
    await expect
      .poll(
        async () =>
          a.app.evaluate(() => (globalThis as unknown as { __opened?: string[] }).__opened ?? []),
        { timeout: 5_000 }
      )
      .toEqual(['https://popped.test/x']);

    // hand the second OS window back before teardown rather than leaving it to
    // the tree-kill: a live popout has outlived cleanup on CI before
    await popout.evaluate(() => window.close());
  });

  // "the composer drives the real CLI over the PTY (E10-02)" stood here. It
  // typed `echo COMPOSER_OK_42` into the composer and then read the echo out of
  // the Terminal tab's scrollback — the scrollback was the only witness that
  // the keystrokes had reached a real process.
  //
  // That surface is gone (#873) and no other rendered surface shows PTY output,
  // so the composer→PTY path has no e2e witness left. The composer still writes
  // to the PTY in code, and the transport itself is exercised below the UI by
  // the `check:pty` harness. The composer→CLI claim on the DEFAULT transport is
  // covered throughout the `stream*.spec.ts` family, where a prompt produces a
  // rendered reply.

  // P2-E10-08 (#406). The unit tests pin the sizing rule against a stubbed
  // layout; only a real engine can say whether the box actually wraps, caps and
  // stays docked. Every length below is derived from the MEASURED box, because
  // the panel's size depends on the window the runner gives us.
  //
  // The cap is "twelve lines OR whatever the panel can spare, whichever is
  // smaller" (`roomForBox` in FeedView.tsx): the composer is the bottom of a
  // column whose conversation yields height first, so on a short panel twelve
  // flat lines would push the options row off the bottom instead of pushing the
  // feed up. WHICH branch a run takes is pure geometry, and a dev machine never
  // sees the small one while CI always does — this test's own first CI red, and
  // #416's lesson before it. So the cap is asserted through its CONTRACT (it
  // stops; it is never more than twelve lines; what stopped it is either the cap
  // or the conversation at its floor) and the whole check is then re-run at CI's
  // exact window geometry, which nothing else here would reach.
  test('the composer grows with WRAPPED text, caps at twelve lines, and shrinks back (E10-08)', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    await expect(w.getByText(folder.split(/[\\/]/).pop()!).first()).toBeVisible({ timeout: 25_000 });

    /**
     * Under the app's own 600px minimum, so Electron clamps to it: the SHORTEST
     * window a user can make, and shorter than any CI runner's (Linux CI is
     * 1008x655 on a 1024x768 desktop, measured 2026-08-11). Whatever branch a
     * runner lands on, this reaches it or one stricter.
     */
    const SHORTEST_CONTENT_HEIGHT = 400;
    /** MIN_FEED_PX in FeedView.tsx — the conversation's floor */
    const MIN_FEED = 60;

    const box = w.getByPlaceholder(/Prompt this session/);
    const chip = w.getByTestId('composer-autonomy');
    const feed = w.locator('[data-feed-region]').first();
    /** height, inner overflow and one rendered line — as the engine has them */
    const measure = (): Promise<{ height: number; scrollHeight: number; line: number; width: number }> =>
      box.evaluate((el) => {
        const t = el as HTMLTextAreaElement;
        return {
          height: t.clientHeight,
          scrollHeight: t.scrollHeight,
          line: Number.parseFloat(getComputedStyle(t).lineHeight),
          width: t.clientWidth,
        };
      });
    /** one line of text, no newline in it anywhere, `chars` long */
    const paragraph = (chars: number): string => 'lorem ipsum '.repeat(Math.ceil(chars / 12)).slice(0, chars);

    /**
     * Fill the box far past any possible cap and assert what stopped it —
     * whatever the panel's size, and without ever asking WHICH branch it is on
     * before making an assertion.
     */
    const assertItCaps = async (one: { height: number; line: number; width: number }): Promise<void> => {
      await box.fill(paragraph(Math.round(one.width * 6)));
      const capped = await measure();
      // eleven lines more than the one-line box is twelve lines: never a 13th,
      // and measuring against that box keeps padding out of the assertion
      expect(capped.height - one.height).toBeLessThan(11.5 * one.line);
      // ...and it is a CAP, not a coincidence: three times the text, same height
      await box.fill(paragraph(Math.round(one.width * 18)));
      const more = await measure();
      expect(Math.abs(more.height - capped.height)).toBeLessThanOrEqual(1);
      expect(more.scrollHeight).toBeGreaterThan(more.height + 2); // the rest scrolls inside
      // What stopped it is one of the two limits and nothing else: either it
      // reached twelve lines, or the conversation is down to its floor.
      const reachedTwelve = more.height - one.height >= 10.5 * one.line;
      if (!reachedTwelve) {
        expect((await feed.boundingBox())!.height).toBeLessThan(MIN_FEED + 8);
        expect((await feed.boundingBox())!.height).toBeGreaterThan(MIN_FEED - 8);
      }
      // ...and at full height the neighbours are still docked where they belong:
      // the options row under the box, both of them inside the window
      const boxBox = (await box.boundingBox())!;
      const chipBox = (await chip.boundingBox())!;
      expect(chipBox.y).toBeGreaterThanOrEqual(boxBox.y + boxBox.height - 1);
      await expect(chip).toBeInViewport();
      await expect(box).toBeInViewport();
    };

    const empty = await measure();
    const feedEmpty = (await feed.boundingBox())!;

    // ~0.8 characters per pixel of width: at any plausible glyph width that is
    // between four and seven wrapped lines — inside the cap on any geometry
    await box.fill(paragraph(Math.round(empty.width * 0.8)));
    const grown = await measure();
    expect(grown.height).toBeGreaterThan(empty.height + 3 * empty.line); // wrapped, and it noticed
    expect(grown.scrollHeight).toBeLessThanOrEqual(grown.height + 2); // all of it on screen
    // the feed gave up the room — the composer did not grow over it
    expect((await feed.boundingBox())!.height).toBeLessThan(feedEmpty.height - 3 * empty.line);

    await assertItCaps(empty);

    // Typing at the bottom of a capped box must not scroll the user back to the
    // top of their own prompt. Re-measuring RELEASES the height, which makes the
    // content fit and would clamp the element's own scrollTop to 0 on every
    // keystroke — the one hazard of auto-grow that only a real engine has.
    await box.press('Control+End');
    await box.pressSequentially('tail');
    expect(await box.evaluate((el) => (el as HTMLTextAreaElement).scrollTop)).toBeGreaterThan(0);

    // Now the shortest window the app allows, with the long draft still in the
    // box: a panel that shrinks under a filled composer must RE-FIT it, not
    // leave it overhanging its own options row. This is also the geometry that
    // takes the OTHER branch of the cap — the conversation reaches its floor
    // before the box reaches twelve lines — which no dev machine sees at its
    // normal window size and every short runner does.
    const tall = await measure();
    await a.app.evaluate(({ BrowserWindow }, height) => {
      const win = BrowserWindow.getAllWindows()[0];
      win.unmaximize();
      win.setContentSize(win.getContentSize()[0], height);
    }, SHORTEST_CONTENT_HEIGHT);
    await expect
      .poll(async () => (await measure()).height, { timeout: 10_000 })
      .toBeLessThan(tall.height); // re-fitted without a keystroke

    // ...and re-fitted CORRECTLY, not merely smaller (#716 review). `<
    // tall.height` passes with a cap a hundred pixels too generous, and this is
    // the ONE place the bounds are computed while the box is already tall —
    // which is the case the old code made unreachable by collapsing the box to
    // 0 before measuring, and the new code reaches on purpose. If `roomForBox`'s
    // chrome subtraction is wrong under a squeezed panel, it is wrong HERE and
    // nowhere else, so assert what "correct" means: the conversation keeps its
    // floor and the options row stays on screen.
    const refitted = await measure();
    const reachedTwelve = refitted.height - empty.height >= 10.5 * empty.line;
    if (!reachedTwelve) {
      const feedBox = (await feed.boundingBox())!;
      expect(feedBox.height).toBeLessThan(MIN_FEED + 8);
      expect(feedBox.height).toBeGreaterThan(MIN_FEED - 8);
    }
    await expect(chip).toBeInViewport();
    await expect(box).toBeInViewport();

    await box.fill('');
    const oneLine = await measure();
    expect(oneLine.height).toBe(empty.height); // deleting it all puts the one-line box back
    await assertItCaps(oneLine);

    // and it still shrinks back at this size
    await box.fill('');
    expect((await measure()).height).toBe(empty.height);
  });

  // #716 review. The composer's cap is what the panel can SPARE, and until #716
  // that was recomputed on every keystroke — so anything docking into this
  // column was noticed by the next character the user typed. It is now measured
  // only when something says the room changed, which makes this the one case
  // the fix could plausibly have broken: a bar that arrives on its own, with no
  // keystroke behind it and no change to the box's width or the panel's height.
  //
  // A permission handoff is the honest way to produce one — it is the same bar
  // `approval.spec.ts` docks, it arrives from the CLI rather than from the test
  // touching the composer, and it is the app's core loop rather than a corner.
  test('a bar docking on its own gives the composer its room back, and the conversation keeps its floor (#716, #981)', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    const title = folder.split(/[\\/]/).pop()!;
    await expect(w.getByText(title).first()).toBeVisible({ timeout: 25_000 });

    /** MIN_FEED_PX in FeedView.tsx — the conversation's floor */
    const MIN_FEED = 60;
    // ⚠️ THE WINDOW IS FOUND, NOT CHOSEN, AND THAT IS THE THIRD ATTEMPT (#972).
    //
    // This test needs a pane in a NARROW BAND: tall enough that the conversation's
    // floor is achievable once the bar docks, short enough that the panel — and not
    // the composer's twelve-line cap — is what stops the box growing. Outside the band
    // the test is impossible in one direction and meaningless in the other.
    //
    // It was a hardcoded number, and the number moved every time anything in this
    // column changed height: 460 while the bar was #125's handoff bar, 580 when #972
    // replaced it with the approval bar, and 580 was wrong again the moment that bar
    // became a flex column and got SHORTER. Each of those was a red CI run for a
    // reason that had nothing to do with the behaviour under test. Measured at 580:
    // the panel is 318, the bar 100, and the composer stops at its twelve-line cap
    // (186px) rather than at the panel — precondition violated, feed 12px.
    //
    // So it SEARCHES. Grow the window until filling the composer leaves the feed at
    // its floor, which states the precondition as code instead of as arithmetic in a
    // comment that goes stale. If no height in the range reaches it, the test says so
    // rather than asserting something that would mean nothing.
    const box = w.getByPlaceholder(/Prompt this session/);
    const chip = w.getByTestId('composer-autonomy');
    const feed = w.locator('[data-feed-region]').first();
    const boxHeight = (): Promise<number> =>
      box.evaluate((el) => (el as HTMLTextAreaElement).clientHeight);
    const feedHeight = async (): Promise<number> => (await feed.boundingBox())!.height;

    const setHeight = async (px: number): Promise<void> => {
      await a.app.evaluate(({ BrowserWindow }, h) => {
        const win = BrowserWindow.getAllWindows()[0];
        win.unmaximize();
        win.setContentSize(win.getContentSize()[0], h);
      }, px);
      await w.waitForTimeout(250);
    };

    // A long draft, once: the box has to be trying to take everything it can before
    // any measurement below means anything.
    await box.fill('lorem ipsum dolor sit amet '.repeat(120));

    /**
     * `MIN_FEED_PX`'s contract, as one question the geometry cannot dodge (#981):
     * the conversation keeps its floor, UNLESS the room for it does not exist — in
     * which case the box is down to its one line and has nothing left to give.
     *
     * ⚠️ WHY NOT JUST THE FLOOR. The search below deliberately finds the SHORTEST
     * window where the panel is in charge, which is the tightest geometry the
     * machine offers, and on Linux CI text renders about 5% wider (#885) — the
     * bar's wrapping five-button row or its command line can take an extra line
     * there. A bare floor assertion would then go red for the runner's fonts rather
     * than for the behaviour, while this one holds on any geometry and still fails
     * the bug: #981's box sat at 127px, nowhere near its 32px minimum, with the
     * conversation at 12.
     */
    const columnState = (): Promise<{ feed: number; box: number; min: number }> =>
      box.evaluate((el) => {
        const t = el as HTMLTextAreaElement;
        const panel = t.parentElement!.parentElement!.parentElement!;
        const cs = getComputedStyle(t);
        const px = (v: string): number => Number.parseFloat(v) || 0;
        return {
          feed: (panel.querySelector('[data-feed-region]') as HTMLElement).offsetHeight,
          box: t.clientHeight,
          // clientHeight is content + padding, so the minimum it can report is
          // one line plus the same padding
          min: px(cs.minBlockSize) + px(cs.paddingBlockStart) + px(cs.paddingBlockEnd),
        };
      });
    const expectFloorOrMinimum = async (when: string): Promise<void> => {
      // SETTLE, don't sample. `expect.poll` passes on the first sample that passes
      // and the bug's own sequence is a transient — the box shrinks (feed briefly
      // large), then the bar springs back (feed 12). A poll landing in that window
      // would pass against the broken code. #952 taught this file the same lesson
      // 60 lines up and this assertion is not allowed to unlearn it.
      await w.waitForTimeout(600);
      const s = await columnState();
      expect(
        s.feed >= MIN_FEED - 8 || s.box <= s.min + 1,
        `${when}: the conversation was ${s.feed}px against a floor of ${MIN_FEED}, and ` +
          `the composer was ${s.box}px with a minimum of ${s.min} — so the box was ` +
          `holding room it had been told it could not have`
      ).toBe(true);
    };

    let found = 0;
    for (const height of [560, 600, 640, 680, 720, 760, 800]) {
      await setHeight(height);
      // SETTLE, don't sample: the box grows over several frames, and an early read was
      // worth about a coin flip (#952 found that the hard way).
      await w.waitForTimeout(400);
      // `MIN_FEED + 8` is the ±8 this file uses for the floor throughout: the cap is
      // `Math.floor`ed and the feed's border box is read to a fraction of a pixel, so
      // a held floor lands a few px either side of 60 rather than on it. It is slack
      // for rounding, not for a violation — 8px is under half a rendered line.
      if ((await feedHeight()) < MIN_FEED + 8) {
        found = height;
        break;
      }
    }
    expect(
      found,
      'no window height in the search range put the PANEL, rather than the ' +
        'twelve-line cap, in charge of the composer — the precondition this test needs ' +
        'cannot be reached here, so its result would mean nothing'
    ).toBeGreaterThan(0);

    const tall = await boxHeight();

    // A bar arrives. Nothing is typed, the window does not move, the box keeps
    // its width — so nothing the composer watches for itself has changed.
    //
    // BOTH ENDS OF THIS CHANGED, AND FOR THE SAME REASON (#952). The stimulus was a
    // `Notification` hook with `notification_type: 'permission_prompt'`, and the bar
    // it docked was the TERMINAL HANDOFF bar — `data-handoff`, #125's "your session
    // is waiting in the Terminal tab". Both are gone: a permission `Notification` is
    // dropped before it can move anything (#313), and there is no terminal to hand
    // off to.
    //
    // The APPROVAL bar is the honest replacement and is a better fit for the
    // paragraph above: it arrives from a real `can_use_tool` the CLI issued, it docks
    // below the scroller exactly as the handoff bar did (FeedView's own probe note
    // says so), and it is the app's core loop rather than a corner.
    //
    // ⚠️ A BASH PERMISSION, NOT A WRITE, AND THE REASON IS THIS TEST'S SUBJECT (#972).
    // `!perm` raises a `Write`, which is DIFFABLE — so the bar arrives with a Monaco
    // editor in it and ~250px of docked chrome, and on CI's 1024×768 desktop the pane
    // is then genuinely too short for MIN_FEED plus that bar plus one line of
    // composer. The feed lands at 12px and this assertion fails, on both platforms,
    // for a reason that has nothing to do with #716: that is correct fail-open
    // behaviour when the room does not exist, and it was already written down in
    // `APPROVAL_DIFF_BLOCK_SIZE`'s docblock.
    //
    // What #716 is about is a bar ARRIVING WITHOUT A KEYSTROKE and the box giving its
    // room back. Any bar does that, and a `Bash` permission is the smallest one: not
    // diffable, so the body is the plain command pane, and the geometry stops being a
    // function of how tall a diff editor happens to be. The diff's own behaviour in a
    // short window is `approval-diff.spec.ts`'s to assert, and it asserts the thing
    // that actually matters there — that Allow and Deny stay reachable.
    await permissionHolderBash(a)(title, 'npm run build');
    await expect(w.getByText('Allow Bash?')).toBeVisible({ timeout: 15_000 });

    // THE ASSERTION: the box gave the height back. Without it the cap is stale,
    // the box keeps a size the column no longer has, and the feed — the only
    // flexible item here — is squeezed under its floor to pay for it.
    await expect.poll(boxHeight, { timeout: 10_000 }).toBeLessThan(tall);
    // ⭐ AND IT GAVE BACK THE RIGHT AMOUNT (#981). `< tall` passes with a cap fifty
    // pixels too generous, and for six weeks that is exactly what shipped: the box
    // rendered ~49px TALLER than the room `roomForBox` had offered it and the
    // conversation absorbed the difference, 12px against a floor of 60.
    //
    // The cause is not arithmetic, it is WHEN the arithmetic ran. The approval bar is
    // `flex: 0 1 auto` with `minBlockSize: 0` (#972, so Allow stays reachable), so it
    // is SQUEEZED while the composer is still tall and springs back once the composer
    // lets go. Measured on Windows at this geometry: the same bar reports 50px with
    // the box tall and 122px once it has shrunk. `roomForBox` read the squeezed
    // number, subtracted it, and handed the box a cap that assumed a bar 72px shorter
    // than the one about to exist. `roomForBox` now collapses the box for that
    // measurement, which is the only state where "what this panel can spare" has an
    // answer that does not depend on the answer.
    //
    // This assertion is therefore the one that would fail again: it measures the
    // OUTCOME (what the conversation was left with) rather than the direction of
    // travel. Measured on Windows at this geometry — panel 298, strip 21, bar 122 —
    // the conversation goes from 12px to 62px; those numbers are this machine's and
    // are here to say what the failure looked like, not as thresholds.
    //
    // ⚠️ IT PROVES THE PAIR, NOT EACH HALF. #981 landed two changes — `roomForBox`
    // collapses the box to measure, and the composer observes the docked bars —
    // and either one alone passes this line, because a wrong measurement followed
    // by the bar springing back fires the observer and converges on the right
    // answer. The collapse's own contribution is that the FIRST commit is already
    // correct rather than corrected a frame later, and a frame is not something
    // this test can see. Removing the observation, on the other hand, fails below.
    await expectFloorOrMinimum('a bar docked under a long prompt');
    await expect(chip).toBeInViewport();
    await expect(box).toBeInViewport();

    // ⭐ THE SECOND DOOR: A BAR THAT GROWS WHERE IT STANDS (#981). "Deny with
    // feedback" opens an objection field inside the bar already docked — measured
    // here at 122px → 194px. Nothing about WHICH bars are docked changes, so
    // `dockedChrome` does not move; the box keeps its width, the panel keeps its
    // height and the options row keeps its wrap. Before #981 the composer watched
    // exactly those three things and therefore saw nothing at all, and held a cap
    // for a column 72px shorter than the one it was in.
    //
    // THE SAME CONTRACT ANSWERS THIS ONE TOO, and it has to: at this geometry the
    // grown bar leaves no 60px to hold (measured on Windows — panel 298, bar 194,
    // composer minimum 72), so the honest claim is the fail-open half. The box
    // gives back everything it has rather than most of it, and the answers stay
    // reachable — `approval-diff.spec.ts`'s claim one door along.
    const beforeField = await boxHeight();
    // The button is the last child of a row that WRAPS in a narrow card (#974), in a
    // bar that may be squeezed, in a window this test made deliberately short. If it
    // has been pushed off the panel the click would time out on the placeholder
    // below and read as a behaviour failure, which is #972's own lesson.
    await expect(w.locator('[data-approval-deny-feedback]')).toBeInViewport();
    await w.locator('[data-approval-deny-feedback]').click();
    await expect(w.getByPlaceholder(/^Why not\?/)).toBeVisible();
    await expect.poll(boxHeight, { timeout: 10_000 }).toBeLessThan(beforeField);
    await expectFloorOrMinimum('the objection field opened inside a docked bar');
    await expect(w.getByRole('button', { name: 'Allow', exact: true })).toBeInViewport();
    await expect(box).toBeInViewport();
  });

  // P2-E10-11 (#477). The one thing only the real app can settle: a click on the
  // copy button reaches the SYSTEM clipboard. Everything else about the
  // affordance — what the button says, which fence it belongs to, that a forged
  // one cannot hijack it — is pinned in the unit tests; this is the round trip,
  // read back through Electron's own `clipboard` in the main process.
  test('copying code from the conversation reaches the system clipboard (#477)', async () => {
    const NL = String.fromCharCode(10); // this file's idiom for a newline in a fixture
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    await expect(w.getByText(folder.split(/[\\/]/).pop()!).first()).toBeVisible({ timeout: 25_000 });

    // two lines, so "it copied the whole fence" is a different answer from "it
    // copied the line you could see"
    const FENCE = ['npm run build', 'npm test', ''].join(NL);
    // the fake's own Bash result, two lines for the same reason (#952)
    const OUT = ['STREAM_OUTPUT', 'STREAM_OUT_LINE2'].join(NL);

    // The fence arrives in a REPLY, through the echo (#952) — markdown a renderer
    // has to turn into a `.feed-code` with a language header and a Copy button. The
    // echo prefixes the FIRST line only, so the fence's own content, which is what
    // the clipboard assertion compares against, is byte-identical either way.
    await arrive(a, path.basename(folder), ['Run this:', '', '```bash', FENCE + '```', ''].join(NL));
    // `!tools` is the fake's TOOL TURN, and it replaces a hand-written transcript
    // (#952). It emits the measured stream shape — one `assistant` message per
    // content block, each arriving mid-stream — for a Bash call with a two-line
    // command ('Stream check'), an Edit (STREAM_OLD → STREAM_NEW), a plain Read
    // row, a TodoWrite checklist, a `tool_result` for the Bash call, and prose
    // (STREAM_PROSE) AFTER the tools so block order is observable.
    //
    // The literals below are its, not this file's: the old fixtures spelled the
    // same structure BOX_/KEYS_/RICH_. Nothing about what is being claimed moved.
    await arrive(a, path.basename(folder), '!tools');

    // start from a clipboard we know is not the answer
    await a.app.evaluate(({ clipboard }) => clipboard.writeText('CLIPBOARD_UNTOUCHED'));
    // Read back through Electron's own clipboard, with line endings normalised:
    // the Windows clipboard stores CRLF, so the text that comes back is not
    // byte-identical to the text that went in and never can be. Measured, not
    // assumed — this test failed on exactly that difference first.
    const pasted = async (): Promise<string> =>
      (await a.app.evaluate(({ clipboard }) => clipboard.readText())).replace(/\r\n/g, String.fromCharCode(10));

    // 1. the fence in the reply carries a header with its language and a Copy
    // scoped to the assistant block: the prompt that provoked this reply carries
    // the same fence, so `.feed-code` alone would be ambiguous (#952)
    const fence = w.locator('[data-feed-block="assistant"] .feed-code').first();
    await expect(fence).toBeVisible({ timeout: 20_000 });
    await expect(fence.locator('.feed-code-lang')).toHaveText('bash');
    await fence.locator('[data-feed-copy]').click();
    // ⚠️ THE "Copied" FLASH IS NOT ASSERTED HERE ANY MORE, and it is not a gap
    // (#952). `runCopy` sets the label synchronously and reverts it after
    // COPIED_MS — 1200ms — so catching it needs a Playwright round trip inside
    // that window, and a loaded Windows runner does not guarantee one: it went red
    // on CI with 24 consecutive polls all reading "Copy", the flash having come and
    // gone before the first probe. A 1200ms window is not something an out-of-process
    // assertion can be held to.
    //
    // It is pinned where it is deterministic, including the exact number:
    // `lib/feed-code.test.ts` → "writes the exact text and flashes the button" sets
    // the label, fires the timer and reads it back as "Copy", and asserts
    // `COPIED_MS === 1200`. What only the real app can settle is the line below.
    //
    // POLLED, not read once: the write is a promise, so a bare read races the
    // clipboard by a millisecond or two — it failed exactly that way the first time
    // this test ran.
    await expect.poll(pasted, { timeout: 5_000 }).toBe(FENCE);

    // 2. a Bash section offers one too, once it is open — and copies the WHOLE
    //    section, not the one line a collapsed section shows
    await expect(w.locator('[data-feed-box="bash"]')).toBeVisible();
    await w.locator('[data-feed-box="bash"]').click({ position: { x: 3, y: 2 } });
    const out = w.locator('[data-feed-code]', { hasText: 'STREAM_OUT_LINE2' }).last();
    await out.locator('[data-feed-copy]').click();
    await expect.poll(pasted, { timeout: 5_000 }).toBe(OUT);

    // …and the button is back to "Copy" by now, which is the revert half of the
    // flash and is the one end of it a poll can be trusted with: it is a state the
    // button STAYS in.
    await expect(fence.locator('[data-feed-copy]')).toHaveText('Copy');
  });
  //
  // #788 shipped captioned, separated subagent runs. Every bit of it was fed by
  // the transcript watcher adopting `<native-id>/subagents/agent-<id>.jsonl` —
  // and `deriveFeed: false` for a stream session switched that off along with
  // the main conversation it was actually aimed at. So the feature went
  // invisible on the default transport from #381, and everywhere after #952,
  // with the renderer (`.agent-divider`, the caption rule, the grouping) intact
  // and unit-tested the whole time.
  //
  // ⚠️ THIS TEST IS BACK, NOT REWRITTEN. The fixture below is the one the `fixme`
  // left in place, and #977's probe re-confirmed its layout on CLI 2.1.280 —
  // subagent turns live in their own files, `isSidechain: true` appears zero
  // times in the parent, and the `assistant` line carries `agentId` and
  // `attributionAgent`. The CLAIMS are unchanged: three runs, two ids, one
  // shared name, and the session's own voice never captioned.
  //
  // WHAT DID CHANGE is where the session's OWN voice comes from. It used to be a
  // hand-written line in the main transcript; on this transport the main
  // conversation is the STREAM's, so it is prompted for real. That is the
  // difference the item made concrete: one file excluded, the other included.
  test('names and separates two concurrent subagents (#788)', async () => {
    test.setTimeout(120_000);
    const folder = tempProjectFolder();
    const title = path.basename(folder);
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    await expect(w.getByText(title).first()).toBeVisible({ timeout: 25_000 });

    // the session's own voice, off the stream
    await streamPrompter(a)(title, 'dispatching two agents');
    await expect(w.getByText('dispatching two agents').first()).toBeVisible({ timeout: 30_000 });

    // ⚠️ WAIT FOR THE TURN TO FINISH BEFORE COUNTING. The fake echoes the prompt
    // (`--replay-user-messages`) and then replies `FAKE-REPLY: <prompt>`, so the
    // count goes 1 → 2 across two messages. Snapshotting between them made this
    // assertion read "2 became 4" on the Linux runner — a GROWTH reported as a
    // failure, which is the wrong bug and the wrong direction.
    await expect(w.getByText(/FAKE-REPLY/)).toBeVisible({ timeout: 30_000 });

    // How much of the session's OWN voice is on screen, before anything else
    // writes into this conversation. See the assertion at the bottom.
    const ownBlocksBefore = await w.getByText('dispatching two agents').count();
    expect(ownBlocksBefore).toBeGreaterThan(1);

    // …and the subagents' voices, from the files the CLI writes. Found rather
    // than reconstructed, for `stream-approval.spec.ts`'s reason: the slug rule
    // is a fold the app owns and a fourth hand-copy of it would turn any
    // disagreement into a 30s poll blaming the renderer for a fixture bug.
    const main = await pollAsync(
      () => Promise.resolve(findFile(a.home, `${FAKE_SESSION_ID}.jsonl`)),
      'the fake never wrote its transcript',
      30_000
    );
    const subs = path.join(path.dirname(main), FAKE_SESSION_ID, 'subagents');
    fs.mkdirSync(subs, { recursive: true });
    const line = (o: Record<string, unknown>) =>
      JSON.stringify({
        sessionId: FAKE_SESSION_ID,
        cwd: folder,
        timestamp: new Date().toISOString(),
        isSidechain: true,
        ...o,
      }) + '\n';
    const say = (text: string, extra: Record<string, unknown> = {}) =>
      line({ type: 'assistant', message: { content: [{ type: 'text', text }] }, ...extra });

    // Two agents, INTERLEAVED across two files the way concurrent ones arrive,
    // and sharing a name — the case a label alone cannot separate.
    fs.writeFileSync(
      path.join(subs, 'agent-aaaaaa11.jsonl'),
      say('AGENT A FIRST', { agentId: 'aaaaaa11', attributionAgent: 'digger' })
    );
    await expect(w.getByText('AGENT A FIRST')).toBeVisible({ timeout: 25_000 });
    fs.writeFileSync(
      path.join(subs, 'agent-bbbbbb22.jsonl'),
      say('AGENT B FIRST', { agentId: 'bbbbbb22', attributionAgent: 'digger' })
    );
    await expect(w.getByText('AGENT B FIRST')).toBeVisible({ timeout: 25_000 });
    fs.appendFileSync(
      path.join(subs, 'agent-aaaaaa11.jsonl'),
      say('AGENT A SECOND', { agentId: 'aaaaaa11' })
    );
    await expect(w.getByText('AGENT A SECOND')).toBeVisible({ timeout: 25_000 });

    // Three runs, because A was interrupted by B and came back. Each captioned
    // with the agent's name AND the id fragment that tells the two
    // identically-named agents apart.
    const captions = w.locator('.agent-divider');
    await expect(captions).toHaveCount(3);
    await expect(captions.nth(0)).toHaveText('Subagent \u00b7 digger \u00b7 aaaaaa');
    await expect(captions.nth(1)).toHaveText('Subagent \u00b7 digger \u00b7 bbbbbb');
    // The THIRD run carries no `attributionAgent` of its own and is named
    // anyway: a name belongs to the agent, not to the line that happened to
    // mention it.
    await expect(captions.nth(2)).toHaveText('Subagent \u00b7 digger \u00b7 aaaaaa');

    // ...and the session's own voice is never captioned.
    await expect(captions.nth(0)).not.toHaveText(/dispatching/);

    // ⚠️ AND THE SESSION'S OWN BLOCKS ARE ALL STILL THERE. Counted BEFORE the
    // subagent files were written and compared, rather than asserted against a
    // literal: the number is a property of the fake's echo plus its reply and is
    // not the claim. The claim is that it did not GO DOWN.
    //
    // This is what the first draft of this feature would have failed. It gave
    // the watcher its own `FeedBuffer`, and two buffers feeding one renderer
    // both number their blocks from seq 1 while the renderer UPSERTS on seq — so
    // the first subagent block REPLACED the session's first block rather than
    // joining it. Every presence assertion above sails straight through that.
    expect(await w.getByText('dispatching two agents').count()).toBe(ownBlocksBefore);

    // ⚠️ AND IT SURVIVES A REMOUNT, which is the other half the two-buffer draft
    // got wrong: `transcripts:blocks` serves the STREAM Feed's backlog, so
    // blocks the watcher kept to itself were never in it and vanished the moment
    // the view re-read it. Switching tabs away and back is the cheapest way to
    // make the view do exactly that.
    await w.getByRole('tab', { name: 'Changes' }).first().click();
    await w.getByRole('tab', { name: 'Session' }).first().click();
    await expect(w.getByText('AGENT A FIRST')).toBeVisible({ timeout: 15_000 });
    await expect(w.locator('.agent-divider')).toHaveCount(3);
  });
});
