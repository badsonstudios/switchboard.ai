// #555 — where the conversation is when you come back to it.
//
// THE REPORT: after updating and restarting, every session was present but
// scrolled to the TOP, and clicking into a card did not bring it down.
//
// WHAT THE ISSUE GUESSED, AND WHAT IT ACTUALLY WAS. The issue blamed #395's
// hydrate: a replayed backlog arriving before the view mounts, so the tail-pin
// never gets an event to pin on. Measured, that is innocent — a restored Direct
// session lands dead on the tail with the owner's own 533-block transcript
// (46,386px of conversation, gap 1), and so does the PTY watcher path with a
// 628-block backlog, on one card, on three, and on a two-group split. The first
// two tests below are that measurement, kept.
//
// The defect is a DOCKVIEW PANEL MOVE, and it is the third test. Activating a
// group re-runs dockview's `openPanel`, which detaches the panel's DOM subtree
// and appends it again; the browser drops the scrollTop of every scroll
// container inside it on the way through. React never re-renders — the same
// elements come back — and nothing in the feed hears about it:
//
//   * no scroll event fires for a detach;
//   * the panel returns at exactly the size it left, so the ResizeObserver
//     never delivers — and the feed's detach BACKSTOP lives inside that
//     observer's callback, so the one branch written for this case is
//     unreachable in it;
//   * `props.visible` never changes, because the panel was visible throughout;
//   * an IntersectionObserver on the scroller fires once at startup and never
//     again (measured — this was the first fix attempted, and it does not work).
//
// `pinned` therefore stayed true, so `offTail` stayed false and #442's "jump to
// latest" never appeared either: the conversation sat at its first message with
// nothing on screen admitting it. Measured against the unfixed build, this
// file's own harness: scrollTop 1491 -> 0, gap 1490, chips 0.
//
// That is the whole of the owner's report. The restart is not the cause — it is
// when all eight of his cards get clicked. The fix is `PanelContext.dockEpoch`:
// the card hears the dockview event and the feed reconciles.
//
// WINDOW SIZE IS STATED, not inherited, for `feed-tail-pin.spec.ts`'s reason —
// none of this exists unless the conversation overflows its pane, which on a
// dev machine's desktop it rarely does.
import { test, expect, Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import {
  launchApp,
  LaunchedApp,
  tempProjectFolder,
  readWorkspaceFile,
  writeWorkspaceFile,
  persistedLayout,
  gridLeafViews,
  skipPopoutOnLinux,
} from './fixtures/app';

/** the dual-capable fake asked for nothing — i.e. Direct, the app's default */
const DIRECT = { SWITCHBOARD_FAKE_PROVIDER: 'stream' };
const WINDOW = { x: 0, y: 0, width: 1400, height: 900 };
/** the same 40px slack the pin rule itself uses */
const TAIL = 40;

const slugForCwd = (cwd: string): string => cwd.replace(/[\\/:. ]/g, '-');
const composer = (w: Page): ReturnType<Page['getByPlaceholder']> =>
  w.getByPlaceholder(/Prompt this session/);

/**
 * How far one feed is from the bottom of its conversation.
 *
 * By LANDMARK NAME rather than "the one scrollable div" (#196 gave every feed
 * its session's title), because the test that matters has two cards on screen
 * and has to name which one it is asking about.
 */
const tailGap = (w: Page, name?: string): Promise<number> =>
  w.evaluate((wanted) => {
    const els = [...document.querySelectorAll('[data-feed-region]')] as HTMLElement[];
    const el = wanted
      ? els.find((e) => (e.getAttribute('aria-label') ?? '').includes(wanted))
      : els[0];
    return el ? Math.round(el.scrollHeight - el.scrollTop - el.clientHeight) : -1;
  }, name);

/**
 * Is the LAST block actually on screen — the done-when's own words, and a
 * stronger claim than the gap: a feed can sit within 40px of the bottom of a
 * scroller whose last child is clipped by it.
 */
const lastBlockInView = (w: Page, name?: string): Promise<boolean> =>
  w.evaluate((wanted) => {
    const els = [...document.querySelectorAll('[data-feed-region]')] as HTMLElement[];
    const el = wanted
      ? els.find((e) => (e.getAttribute('aria-label') ?? '').includes(wanted))
      : els[0];
    const blocks = el?.querySelectorAll('[data-feed-block]');
    const last = blocks?.[blocks.length - 1] as HTMLElement | undefined;
    if (!el || !last) return false;
    const view = el.getBoundingClientRect();
    const box = last.getBoundingClientRect();
    return box.bottom <= view.bottom + 2 && box.bottom > view.top;
  }, name);

/** a conversation several screens tall, through the stream fake's `!bulk` */
async function converse(w: Page, tag: string): Promise<void> {
  const box = composer(w).filter({ visible: true }).first();
  await box.click();
  await box.fill(`!bulk 60 ${tag}`);
  await box.press('Enter');
  await expect(w.getByText(`${tag}60`, { exact: true })).toBeAttached({ timeout: 60_000 });
  await w.waitForTimeout(800);
}

async function sized(a: LaunchedApp): Promise<void> {
  await a.app.evaluate(({ BrowserWindow }, box) => {
    BrowserWindow.getAllWindows()[0]?.setBounds(box);
  }, WINDOW);
  await a.window.waitForTimeout(400);
}

/** the fake's durable `--resume` identity, once it has reached disk (#404) */
async function nativeIdPersisted(home: string): Promise<void> {
  await expect(() => {
    const card = readWorkspaceFile(home).sessions?.[0];
    expect(card?.nativeSessionId).toBe('00000000-fake-4000-8000-000000000000');
  }).toPass({ timeout: 20_000 });
}

test.describe('a conversation you come back to is at its newest message (#555)', () => {
  let a: LaunchedApp | undefined;
  test.afterEach(async () => {
    const launched = a;
    a = undefined;
    await launched?.cleanup();
  });

  test('a Direct session restored from a restart opens at the tail', async () => {
    test.setTimeout(180_000);
    const folder = tempProjectFolder();
    const name = path.basename(folder);
    const first = await launchApp({ seedFolder: folder, env: DIRECT });
    a = first;
    await expect(first.window.getByText(name).first()).toBeVisible({ timeout: 25_000 });
    await sized(first);
    await converse(first.window, 'R_');
    await nativeIdPersisted(first.home);
    await first.close();

    // fresh process, same profile, NO seedFolder — seeding again would make a
    // second card and land the assertions on the wrong one
    a = await launchApp({ home: first.home, env: DIRECT });
    await sized(a);
    const w = a.window;
    await expect(w.getByText('R_60', { exact: true })).toBeAttached({ timeout: 60_000 });

    // the replayed history is on screen AND the newest of it is what you see —
    // no scrolling, no click, nothing typed into this launch
    await expect.poll(() => tailGap(w), { timeout: 15_000 }).toBeLessThan(TAIL);
    expect(await lastBlockInView(w)).toBe(true);
  });

  test('[pty] a Terminal session restored from a restart opens at the tail', async () => {
    test.setTimeout(180_000);
    // The OTHER conversation pipeline, and the one most of a real workspace is
    // on: a stream session's Feed is built by `feed/stream-feed.ts`, a PTY
    // session's by the transcript WATCHER adopting the JSONL on disk. The
    // backlog therefore arrives by a completely different route, which is
    // exactly why the done-when says "on both transports".
    const folder = tempProjectFolder();
    const name = path.basename(folder);
    const first = await launchApp({ seedFolder: folder }); // pty is the default
    a = first;
    await expect(first.window.getByText(name).first()).toBeVisible({ timeout: 25_000 });
    await sized(first);

    // the CLI's part, played by the test (the `feed.spec.ts` recipe)
    const dir = path.join(first.home, '.claude', 'projects', slugForCwd(folder));
    fs.mkdirSync(dir, { recursive: true });
    const line = (o: Record<string, unknown>): string =>
      JSON.stringify({
        sessionId: 'native-e2e',
        cwd: folder,
        timestamp: new Date().toISOString(),
        ...o,
      }) + '\n';
    let jsonl = line({ type: 'user', message: { role: 'user', content: 'a long conversation' } });
    for (let i = 1; i <= 60; i++) {
      jsonl += line({
        type: 'assistant',
        message: { content: [{ type: 'text', text: `PTY_${i}` }] },
      });
    }
    fs.writeFileSync(path.join(dir, 'native-e2e.jsonl'), jsonl);
    await expect(first.window.getByText('PTY_60', { exact: true })).toBeAttached({ timeout: 60_000 });
    await first.window.waitForTimeout(1_000);
    await first.close();

    // The card has to come back on the SAME conversation, or the watcher will
    // not touch the file: `watcher.ts` refuses every pre-existing transcript
    // except "our own resumed conversation" (`<nativeId>.jsonl`), which is the
    // rule that gives a resumed PTY card its history back at all. The real CLI
    // reports the id through a hook; the fake does not, so the persisted card
    // is doctored to carry it — the same supported entry point the split and
    // suspend cases below use.
    const ws = readWorkspaceFile(first.home);
    expect(ws.sessions?.[0], 'the card should have reached disk').toBeTruthy();
    ws.sessions![0].nativeSessionId = 'native-e2e';
    writeWorkspaceFile(first.home, ws);

    a = await launchApp({ home: first.home });
    await sized(a);
    const w = a.window;
    await expect(w.getByText('PTY_60', { exact: true })).toBeAttached({ timeout: 60_000 });
    await expect.poll(() => tailGap(w), { timeout: 15_000 }).toBeLessThan(TAIL);
    expect(await lastBlockInView(w)).toBe(true);
  });

  test('a suspended card resuming opens at the tail', async () => {
    test.setTimeout(240_000);
    // SUSPENDED IS NOT A PERSISTED STATE, so this cannot be seeded into the
    // workspace file the way the split below is: `session-store` calls it a
    // reflected-only field and deliberately keeps it out of the blob ("dockview's
    // layout JSON already round-trips popout location; a second copy is two
    // authorities waiting to disagree"). The one gesture that really produces it
    // is the one the copy on screen describes — the window was closed — so that
    // is the gesture this makes.
    skipPopoutOnLinux();
    const folder = tempProjectFolder();
    const name = path.basename(folder);
    a = await launchApp({ seedFolder: folder, env: DIRECT });
    const { app, window: w } = a;
    await expect(w.getByText(name).first()).toBeVisible({ timeout: 25_000 });
    await sized(a);
    await converse(w, 'S_');

    await w.getByTitle('Pop out into its own window').click();
    await expect
      .poll(() => app.windows().filter((p) => p.url().includes('popout.html')).length, {
        timeout: 15_000,
      })
      .toBe(1);
    const popout = app.windows().find((p) => p.url().includes('popout.html'))!;
    await expect(popout.getByText('S_60', { exact: true })).toBeAttached({ timeout: 30_000 });

    // closed, not docked back: closing the WINDOW is what suspends the session
    // and keeps the card (E8-04)
    await popout.evaluate(() => window.close());
    await expect.poll(() => app.windows().length, { timeout: 20_000 }).toBe(1);

    await expect(w.getByTestId('card-overlay').getByText('Session suspended')).toBeVisible({
      timeout: 25_000,
    });
    await w.getByRole('button', { name: 'Resume' }).click();

    // it resumes, replays the conversation it had — and lands on the end of it
    await expect(w.getByText('S_60', { exact: true })).toBeAttached({ timeout: 60_000 });
    await expect.poll(() => tailGap(w), { timeout: 15_000 }).toBeLessThan(TAIL);
    expect(await lastBlockInView(w)).toBe(true);
  });

  test('a card dockview MOVES keeps following its conversation', async () => {
    test.setTimeout(240_000);
    // THE DEFECT. Two docked groups, because that is what makes a rail click
    // change the ACTIVE GROUP and therefore re-run dockview's `openPanel` on a
    // panel that is already mounted and already visible. One group cannot
    // reproduce it: switching tabs there UNMOUNTS the outgoing card, so the
    // incoming one mounts fresh and pins at the tail like any new card.
    const f1 = tempProjectFolder();
    const f2 = tempProjectFolder();
    const [n1, n2] = [f1, f2].map((f) => path.basename(f));
    const first = await launchApp({ seedFolder: f1, env: DIRECT });
    a = first;
    await expect(first.window.getByText(n1).first()).toBeVisible({ timeout: 25_000 });
    await sized(first);
    await converse(first.window, 'C1_');

    await first.app.evaluate(({ dialog }, d) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [d] });
    }, f2);
    await first.window.getByRole('button', { name: '+ session' }).click();
    await expect(first.window.locator('nav').getByText(n2).first()).toBeVisible({ timeout: 25_000 });
    await converse(first.window, 'C2_');
    await first.window.waitForTimeout(1_500); // let the layout reach disk
    await first.close();

    // Split the saved layout into two side-by-side leaves — `split.spec.ts`'s
    // recipe, and its argument applies here too: dockview's own drag-and-drop
    // state is not producible from a synthetic `dragstart`, and a real user's
    // workspace restores from exactly this blob anyway.
    const ws = readWorkspaceFile(first.home);
    const layout = persistedLayout(ws);
    const views = gridLeafViews(layout.grid.root.data[0]);
    expect(views.length, 'need two panels to split').toBeGreaterThan(1);
    const half = Math.floor(layout.grid.width / 2);
    layout.grid.root.data = [
      { type: 'leaf', data: { views: views.slice(0, 1), activeView: views[0], id: '1' }, size: half },
      { type: 'leaf', data: { views: views.slice(1), activeView: views[1], id: '2' }, size: half },
    ];
    writeWorkspaceFile(first.home, ws);

    a = await launchApp({ home: first.home, env: DIRECT });
    const w = a.window;
    await expect(w.locator('.dv-groupview')).toHaveCount(2, { timeout: 25_000 });
    await sized(a);
    await expect(w.getByText('C1_60', { exact: true })).toBeAttached({ timeout: 60_000 });
    await expect(w.getByText('C2_60', { exact: true })).toBeAttached({ timeout: 60_000 });

    // both cards restored onto their tails — the state the click then breaks
    await expect.poll(() => tailGap(w, n1), { timeout: 15_000 }).toBeLessThan(TAIL);
    await expect.poll(() => tailGap(w, n2), { timeout: 15_000 }).toBeLessThan(TAIL);

    // ...and now the click. Its own rail row, the gesture the owner made eight
    // times in a row after the update. Against the unfixed build this leaves
    // gap 1490 of 1491, permanently, with no jump-to-latest to get back.
    for (const name of [n1, n2]) {
      await w.locator('nav [draggable="true"]').filter({ hasText: name }).first().click();
      await w.waitForTimeout(1_200);
      expect(await tailGap(w, name), `${name} was left behind by a dockview move`).toBeLessThan(TAIL);
      expect(await lastBlockInView(w, name)).toBe(true);
    }

    // the pin is intact rather than merely re-scrolled once: the way back is a
    // control that exists only while the feed is unpinned AND overflowing, so
    // its absence is the assertion that nothing silently unpinned (#442)
    await expect(w.locator('[data-feed-jump-latest]')).toHaveCount(0);
  });
});
