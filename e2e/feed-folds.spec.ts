// #1130 — a burst of Read / Grep / Glob calls is one row in the conversation.
//
// The owner's screenshot was about twenty consecutive one-line boxes for one
// burst of looking around. The rules (what folds, where a run ends) are unit
// tested in `lib/feed-folds.test.ts` and the wiring in
// `FeedView.folds.test.tsx`. What is left for the real app is what jsdom cannot
// see: that the burst really takes one row's height, that opening it leaves the
// row you clicked WHERE IT WAS rather than carrying it off the top, and that
// following the newest message survives a fold being opened and shut.
//
// The blocks are injected on `sessions:feedBlock` — the channel a live session's
// blocks arrive on — rather than produced by the fake provider, because the
// claim is about the Feed's handling of a run, not about any tool being run.
import { test, expect, Page } from '@playwright/test';
import path from 'path';
import { launchApp, LaunchedApp, pollAsync, tempProjectFolder } from './fixtures/app';

const DIRECT = { SWITCHBOARD_FAKE_PROVIDER: 'stream' };

interface Block {
  seq: number;
  kind: string;
  sidechain: boolean;
  text?: string;
  tool?: {
    name: string;
    category: string;
    summary: string;
    description?: string;
    detail?: string;
    out?: string;
    failed?: boolean;
  };
}

const say = (seq: number, text: string, kind = 'assistant'): Block => ({ seq, kind, sidechain: false, text });
const call = (seq: number, name: string, summary: string): Block => ({
  seq,
  kind: 'tool',
  sidechain: false,
  tool: { name, category: 'read', summary, detail: `{"target":"${summary}"}`, out: 'ok' },
});

/** the screenshot's shape: a long burst, then the sentence that came of it */
function burst(from: number, count: number): Block[] {
  const names = ['Grep', 'Grep', 'Glob', 'Grep', 'Read'];
  return Array.from({ length: count }, (_, i) =>
    call(from + i, names[i % names.length], `C:\\Projects\\demo\\src\\file-${i}.ts`)
  );
}

test.describe('a burst of looking around folds into one row (#1130)', () => {
  let a: LaunchedApp | undefined;

  test.afterEach(async () => {
    await a?.cleanup();
    a = undefined;
  });

  async function open(): Promise<{
    w: Page;
    title: string;
    inject: (blocks: Block[]) => Promise<void>;
  }> {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder, env: DIRECT });
    const app = a;
    const w = app.window;
    const title = path.basename(folder);
    await expect(w.getByText(title).first()).toBeVisible({ timeout: 25_000 });
    await app.app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setBounds({ x: 40, y: 40, width: 1100, height: 760 });
    });
    const liveId = await pollAsync(async () => {
      const cards = (await w.evaluate(() => window.switchboard.sessions.cards())) as Array<{
        title: string;
        liveId?: string;
      }>;
      return cards.find((c) => c.title === title)?.liveId ?? null;
    }, 'no live session to stream into');
    await expect(w.locator('[data-feed-region]')).toBeVisible({ timeout: 25_000 });
    const inject = (blocks: Block[]): Promise<void> =>
      app.app.evaluate(
        ({ BrowserWindow }, { id, list }) => {
          const wc = BrowserWindow.getAllWindows()[0].webContents;
          for (const block of list) wc.send('sessions:feedBlock', { sessionId: id, block });
        },
        { id: liveId, list: blocks }
      );
    return { w, title, inject };
  }

  test('twenty calls take one row; opening shows all twenty; shutting puts it back', async () => {
    const { w, inject } = await open();
    await inject([say(101, 'find where the feed draws a tool row', 'user'), say(102, 'Looking around.')]);
    await inject(burst(103, 20));
    await inject([say(123, 'FOUND_IT: it is in the block renderer.')]);
    await expect(w.getByText('FOUND_IT')).toBeVisible({ timeout: 15_000 });

    const fold = w.locator('[data-feed-fold]');
    await expect(fold).toHaveCount(1);
    await expect(fold).toContainText('Explored the code');
    await expect(fold).toContainText('16 searches');
    await expect(fold).toContainText('4 files read');
    // none of the twenty is in the document
    await expect(w.locator('[data-feed-box="tool"]')).toHaveCount(0);
    // …and the burst costs about one row: the sentence before it and the
    // sentence after it are both on screen, which twenty rows never allowed
    const rowHeight = (await fold.boundingBox())!.height;
    expect(rowHeight).toBeLessThan(60);
    await expect(w.getByText('Looking around.')).toBeInViewport();
    await expect(w.getByText('FOUND_IT')).toBeInViewport();

    // open it
    const before = (await fold.boundingBox())!;
    await fold.locator('button[data-feed-expander]').click();
    await expect(w.locator('[data-feed-box="tool"]')).toHaveCount(20);
    await expect(fold.locator('button[data-feed-expander]')).toHaveAttribute('aria-expanded', 'true');
    // ⚠️ the row you clicked is still where you clicked it. The conversation
    // was following its newest message; left to that, opening twenty rows
    // would have carried this one up out of the window.
    await expect(fold).toBeInViewport();
    const after = (await fold.boundingBox())!;
    expect(Math.abs(after.y - before.y)).toBeLessThan(4);
    // the first call sits directly under it
    await expect(w.locator('[data-feed-seq="103"]')).toBeInViewport();

    // shut it again
    await fold.locator('button[data-feed-expander]').click();
    await expect(w.locator('[data-feed-box="tool"]')).toHaveCount(0);
    await expect(w.getByText('FOUND_IT')).toBeInViewport();
  });

  // #1200: runs of COMMANDS fold too. The owner: "I just had about 12 in a row
  // and they weren't grouped at all."
  const cmd = (seq: number, n: number, over: Partial<NonNullable<Block['tool']>> = {}): Block => ({
    seq,
    kind: 'tool',
    sidechain: false,
    tool: {
      name: 'Bash',
      category: 'shell',
      summary: `npm run step-${n}`,
      description: `Step ${n}`,
      out: `STEP_${n}_OUTPUT`,
      ...over,
    },
  });

  test('twelve commands in a row take one row, and open onto all twelve (#1200)', async () => {
    const { w, inject } = await open();
    await inject([say(301, 'build it', 'user'), say(302, 'Running the steps.')]);
    await inject(Array.from({ length: 12 }, (_, i) => cmd(303 + i, i + 1)));
    await inject([say(315, 'ALL_STEPS_DONE')]);
    await expect(w.getByText('ALL_STEPS_DONE')).toBeVisible({ timeout: 15_000 });

    const fold = w.locator('[data-feed-fold]');
    await expect(fold).toHaveCount(1);
    await expect(fold).toHaveAttribute('data-feed-fold-kind', 'shell');
    await expect(fold).toContainText('Ran');
    await expect(fold).toContainText('12 commands');
    // the newest one, by what it was FOR
    await expect(fold).toContainText('latest: Step 12');
    await expect(w.locator('[data-feed-box="bash"]')).toHaveCount(0);
    expect((await fold.boundingBox())!.height).toBeLessThan(60);

    await fold.locator('button[data-feed-expander]').click();
    await expect(w.locator('[data-feed-box="bash"]')).toHaveCount(12);
    await fold.locator('button[data-feed-expander]').click();
    await expect(w.locator('[data-feed-box="bash"]')).toHaveCount(0);
  });

  test('a command that FAILED is never folded away: it stands between two folds, marked (#1200)', async () => {
    const { w, inject } = await open();
    await inject([say(401, 'build it', 'user')]);
    await inject([
      ...Array.from({ length: 5 }, (_, i) => cmd(402 + i, i + 1)),
      cmd(407, 6, { out: 'Exit code 1\nSTEP_6_BROKE', failed: true }),
      ...Array.from({ length: 6 }, (_, i) => cmd(408 + i, i + 7)),
      say(414, 'ONE_STEP_FAILED'),
    ]);
    await expect(w.getByText('ONE_STEP_FAILED')).toBeVisible({ timeout: 15_000 });

    // two folds, and they say how many each holds
    const folds = w.locator('[data-feed-fold]');
    await expect(folds).toHaveCount(2);
    await expect(folds.nth(0)).toContainText('5 commands');
    await expect(folds.nth(1)).toContainText('6 commands');

    // THE FAILED ONE IS ON SCREEN WITHOUT OPENING ANYTHING, in full, and says
    // "failed" in words. It is the only command box drawn.
    const boxes = w.locator('[data-feed-box="bash"]');
    await expect(boxes).toHaveCount(1);
    await expect(boxes).toContainText('Step 6');
    await expect(boxes.locator('[data-feed-failed]')).toHaveText('failed');
    await expect(boxes).toBeInViewport();
    // ...and it sits BETWEEN the two folds, where it happened
    const y = async (l: ReturnType<typeof w.locator>): Promise<number> => (await l.boundingBox())!.y;
    expect(await y(folds.nth(0))).toBeLessThan(await y(boxes));
    expect(await y(boxes)).toBeLessThan(await y(folds.nth(1)));

    // a command that succeeded carries no such mark, even once opened
    await folds.nth(0).locator('button[data-feed-expander]').click();
    await expect(w.locator('[data-feed-box="bash"]')).toHaveCount(6);
    await expect(w.locator('[data-feed-failed]')).toHaveCount(1);
  });

  test('prose in the middle makes two folds; an edit and a lone Read are left alone', async () => {
    const { w, inject } = await open();
    await inject([
      say(201, 'go', 'user'),
      ...burst(202, 4),
      say(206, 'MIDDLE_SENTENCE between two bursts'),
      ...burst(207, 3),
      {
        seq: 210,
        kind: 'tool',
        sidechain: false,
        tool: { name: 'Bash', category: 'shell', summary: 'npm test', out: 'ok' },
      },
      call(211, 'Read', 'C:\\Projects\\demo\\LONE_READ.ts'),
      say(212, 'TAIL_SENTENCE'),
    ]);
    await expect(w.getByText('TAIL_SENTENCE')).toBeVisible({ timeout: 15_000 });
    await expect(w.locator('[data-feed-fold]')).toHaveCount(2);
    await expect(w.getByText('MIDDLE_SENTENCE')).toBeVisible();
    await expect(w.locator('[data-feed-box="bash"]')).toHaveCount(1);
    // the lone Read is an ordinary row
    await expect(w.locator('[data-feed-box="tool"]')).toHaveCount(1);
    await expect(w.locator('[data-feed-box="tool"]')).toContainText('LONE_READ');
  });

  test('the keyboard reaches the row and opens it', async () => {
    const { w, inject } = await open();
    await inject([say(301, 'go', 'user'), ...burst(302, 6), say(308, 'KEYBOARD_DONE')]);
    await expect(w.getByText('KEYBOARD_DONE')).toBeVisible({ timeout: 15_000 });
    const button = w.locator('[data-feed-fold] button[data-feed-expander]');
    await w.locator('[data-feed-region]').focus();
    // walk the conversation's stops until the fold's row has focus
    for (let i = 0; i < 6; i++) {
      await w.keyboard.press('ArrowDown');
      if (await button.evaluate((el) => el === document.activeElement)) break;
    }
    await expect(button).toBeFocused();
    await w.keyboard.press('Enter');
    await expect(w.locator('[data-feed-box="tool"]')).toHaveCount(6);
    await expect(button).toBeFocused();
    await w.keyboard.press('Enter');
    await expect(w.locator('[data-feed-box="tool"]')).toHaveCount(0);
  });

  // a burst still running: the row grows by count, the conversation keeps
  // following, and nothing is left behind when the run turns into prose
  test('a burst arriving one call at a time is one row throughout', async () => {
    const { w, inject } = await open();
    await inject([say(401, 'go', 'user')]);
    const calls = burst(402, 8);
    // one IPC round trip each, so they arrive as separate updates
    for (const c of calls) await inject([c]);
    const fold = w.locator('[data-feed-fold]');
    await expect(fold).toHaveCount(1);
    await expect(fold).toContainText('7 searches');
    await expect(fold).toContainText('1 file read');
    await expect(w.locator('[data-feed-box="tool"]')).toHaveCount(0);
    await inject([say(410, 'LIVE_DONE')]);
    await expect(w.getByText('LIVE_DONE')).toBeInViewport();
    await expect(fold).toHaveCount(1);
  });

  // ── following the newest message, through a fold (found in review) ────────
  //
  // Opening a fold stops the conversation following its tail, so the row you
  // clicked stays put. All three of these are about that not costing anything
  // it should not, and each needs a conversation long enough to scroll — the
  // tests above never are, which is how the first draft passed with two of
  // these broken.
  const jump = (w: Page) => w.locator('[data-feed-jump-latest]');
  /** forty paragraphs, then a burst, then the sentence it led to */
  const long = (from: number): Block[] => [
    say(from, 'go', 'user'),
    ...Array.from({ length: 40 }, (_, i) => say(from + 1 + i, `filler paragraph ${i}\n\nsecond line`)),
    ...burst(from + 41, 12),
    say(from + 53, 'TAIL_OF_THE_BACKLOG'),
  ];

  test('open a fold at the tail and shut it again: the conversation is following', async () => {
    const { w, inject } = await open();
    await inject(long(1000));
    await expect(w.getByText('TAIL_OF_THE_BACKLOG')).toBeInViewport({ timeout: 15_000 });
    await expect(jump(w)).toHaveCount(0);
    const fold = w.locator('[data-feed-fold]');
    const button = fold.locator('button[data-feed-expander]');

    await button.click();
    await expect(w.locator('[data-feed-box="tool"]')).toHaveCount(12);
    // twelve rows pushed the tail out of the window: not following, and it says so
    await expect(fold).toBeInViewport();
    await expect(jump(w)).toHaveCount(1);

    await button.click();
    await expect(w.locator('[data-feed-box="tool"]')).toHaveCount(0);
    // back on the newest message: following again, and no offer to jump to
    // where we already are
    await expect(w.getByText('TAIL_OF_THE_BACKLOG')).toBeInViewport();
    await expect(jump(w)).toHaveCount(0);
    await inject([say(1100, 'NEWEST_AFTER_SHUT\n\nsecond line\n\nthird line')]);
    await expect(w.getByText('NEWEST_AFTER_SHUT')).toBeInViewport();
    await expect(jump(w)).toHaveCount(0);
  });

  test('an open fold is where you left it after looking at another session', async () => {
    const { w, title, inject } = await open();
    await inject(long(2000));
    await expect(w.getByText('TAIL_OF_THE_BACKLOG')).toBeInViewport({ timeout: 15_000 });
    const fold = w.locator('[data-feed-fold]');
    await fold.locator('button[data-feed-expander]').click();
    await expect(w.locator('[data-feed-box="tool"]')).toHaveCount(12);
    await expect(fold).toBeInViewport();
    const before = (await fold.boundingBox())!;

    // A second session opens as a tab over this one, which hides this card
    // without unmounting it — the case `restore()` exists for (#555).
    const other = tempProjectFolder();
    await a!.app.evaluate(({ dialog }, d) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [d] });
    }, other);
    await w.getByRole('button', { name: '+ session' }).click();
    await expect(w.locator('nav').getByText(path.basename(other)).first()).toBeVisible({
      timeout: 25_000,
    });
    await expect(fold).toBeHidden();

    // …and back. The view is put where it was being read. Before the fix that
    // was "wherever the last scroll EVENT left it" — and a session followed
    // from its tail never raises one, so it was the top of the conversation.
    await w.locator('nav [draggable="true"]').filter({ hasText: title }).first().click();
    await expect(fold).toBeInViewport({ timeout: 15_000 });
    await expect
      .poll(async () => Math.abs((await fold.boundingBox())!.y - before.y), { timeout: 10_000 })
      .toBeLessThan(4);
    await expect(w.getByText('filler paragraph 0', { exact: false }).first()).not.toBeInViewport();
  });

  test('a row you opened is still open, in place, when the burst grows past it', async () => {
    const { w, inject } = await open();
    await inject([say(3001, 'go', 'user'), call(3002, 'Grep', 'first'), call(3003, 'Read', 'SECOND_TARGET')]);
    const second = w.locator('[data-feed-seq="3003"]');
    await second.locator('button[data-feed-expander]').click();
    await expect(second.locator('pre')).toBeVisible();
    const before = (await second.boundingBox())!;

    await inject([call(3004, 'Glob', 'third')]);
    // the three are one burst now, and it formed OPEN
    await expect(w.locator('[data-feed-fold] button[data-feed-expander]')).toHaveAttribute(
      'aria-expanded',
      'true'
    );
    await expect(second.locator('pre')).toBeVisible();
    // moved down by the one row that appeared above it, and no further
    const after = (await second.boundingBox())!;
    expect(after.y - before.y).toBeGreaterThan(0);
    expect(after.y - before.y).toBeLessThan(60);
  });
});
