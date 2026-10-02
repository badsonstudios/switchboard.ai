// The conversation skips what you cannot see, and still knows how tall it is (#740).
//
// ── WHY THIS IS AN E2E AND NOT A UNIT TEST ──────────────────────────────────
//
// Because the claim is about LAYOUT, and the only honest place to ask whether
// `scrollHeight` is right is a real Chromium with real fonts. The rules behind
// it — when a stored height is a lie, which resize reports are real — are unit
// tested in `src/renderer/src/lib/feed-skipping.test.ts`; what is left is the
// one thing those cannot reach.
//
// ── AND WHY IT HAS TO RUN ON LINUX ──────────────────────────────────────────
//
// The FIRST attempt at this feature was green on Windows and red on Linux CI.
// It skipped blocks using a single global `contain-intrinsic-size: auto 80px`,
// which made `scrollHeight` read +85% at 60 blocks and +127% at 400 — and this
// app has a pixel-exact scroll-restore contract (#442's tail pin, #555's
// reading position, and Dan's own 2026-07-26 bug). It was reverted. So the
// assertion below is not a nicety: it is the specific thing that went wrong,
// written down so it cannot go wrong again unnoticed. Linux fonts are also
// about 5% wider than this desktop's, which is exactly the kind of difference
// a measured height absorbs and a guessed one does not.
import { test, expect, Page } from '@playwright/test';
import path from 'path';
import { launchApp, LaunchedApp, streamPrompter, tempProjectFolder } from './fixtures/app';

/** the dual-capable fake, asked for nothing — i.e. the app's own default */
const DIRECT = { SWITCHBOARD_FAKE_PROVIDER: 'stream' };

/**
 * Prose, not `BLOCK_1`.
 *
 * A nine-character block does not rewrap at any width this window can reach,
 * so a fixture made of them would make the narrowing case below pass for the
 * wrong reason — it would be asserting that heights which cannot change have
 * not changed. The #740 probe shipped exactly that bug on its first run and
 * reported "a 954px -> 525px narrowing changes the content height by 0.0%".
 */
const PROSE =
  'the quick brown fox jumps over the lazy dog while the sun sets behind a ' +
  'row of quiet houses and somebody somewhere is still typing into a box ';

interface Exactness {
  /** `scrollHeight` as the app has it, with off-screen blocks skipped */
  skipped: number;
  /** `scrollHeight` with every block laid out for real */
  truth: number;
  /** how many blocks the app is standing on a measured height */
  styled: number;
  total: number;
  /** the feed's own width — how this test knows a resize has actually arrived */
  width: number;
  /**
   * The worst gap, over all blocks, between the height the feed WROTE for a
   * block and the height that block actually has.
   *
   * ⚠️ THIS IS THE CLAIM. `skipped === truth` is a consequence of it, and a
   * consequence can be true for other reasons — `contain-intrinsic-size: auto
   * <length>` prefers the engine's own last remembered size when it has one,
   * so a block that was rendered with the property before it was ever skipped
   * never consults the length at all. Measured: putting the reverted global
   * `80px` back DOES fail the totals here, by 3,409px, because `!bulk` appends
   * most blocks below the fold where they are styled while off screen and the
   * length is the only thing standing in for them. But that depends on the
   * fixture, and this does not.
   */
  worstBlockErrorPx: number;
}

/**
 * Read `scrollHeight` both ways and put the feed back as it was.
 *
 * The truth is taken by stripping the two inline properties the feed writes
 * and reading again — one forced layout with everything rendered, which is
 * precisely the number the skipped feed is claiming to reproduce.
 */
const exactness = (w: Page): Promise<Exactness> =>
  w.evaluate(() => {
    // Exactly one feed on screen, or "the first scroller that looks like one"
    // is picking a card arbitrarily and the numbers below belong to whichever
    // it happened to find.
    const regions = document.querySelectorAll<HTMLDivElement>('[data-feed-region]');
    if (regions.length !== 1) throw new Error(`expected one feed region, found ${regions.length}`);
    const scroller = regions[0];
    const blocks = [...scroller.querySelectorAll<HTMLElement>('[data-feed-block]')];

    const skipped = scroller.scrollHeight;
    const saved = blocks.map((b) => [b.style.contentVisibility, b.style.containIntrinsicSize]);
    const styled = saved.filter(([cv]) => cv === 'auto').length;

    for (const b of blocks) {
      b.style.contentVisibility = '';
      b.style.containIntrinsicSize = '';
    }
    // One forced layout with everything rendered — and, in the same pass, what
    // each block REALLY is, so the written lengths can be checked one by one
    // rather than only in aggregate. Content-box, because that is the unit
    // `contain-intrinsic-size` speaks; handing it a border box would double
    // each block's padding.
    const truth = scroller.scrollHeight;
    let worstBlockErrorPx = 0;
    blocks.forEach((b, i) => {
      const written = saved[i][1];
      if (written) {
        const cs = getComputedStyle(b);
        const pad =
          parseFloat(cs.paddingBlockStart) +
          parseFloat(cs.paddingBlockEnd) +
          parseFloat(cs.borderBlockStartWidth) +
          parseFloat(cs.borderBlockEndWidth);
        const real = Math.max(0, b.getBoundingClientRect().height - pad);
        const length = parseFloat(written.replace('auto', '').trim());
        if (Number.isFinite(length)) {
          worstBlockErrorPx = Math.max(worstBlockErrorPx, Math.abs(length - real));
        }
      }
      b.style.contentVisibility = saved[i][0]!;
      b.style.containIntrinsicSize = saved[i][1]!;
    });

    return {
      skipped,
      truth,
      styled,
      total: blocks.length,
      width: Math.round(scroller.clientWidth),
      worstBlockErrorPx,
    };
  });

/**
 * ⚠️ ASSERT THE PREMISE, OR THIS TEST CAN STOP TESTING ANYTHING.
 *
 * If the feed ever stops applying the skip styling — the hook throws, the
 * selector drifts, someone reverts it — then `skipped` and `truth` are the same
 * measurement of the same fully-rendered feed and every assertion below passes.
 * Green, silently, for ever. So the count comes first: every block must be
 * standing on a measured height before its exactness means anything.
 */
function expectExact(r: Exactness, blocks: number): void {
  expect(r.total).toBe(blocks);
  expect(r.styled).toBe(r.total);
  // THE CLAIM: every block is standing on its own height, not a guess and not
  // a neighbour's. Half a pixel is `HEIGHT_EPSILON_PX`, the same slack the
  // module uses to decide a report is not news.
  expect(r.worstBlockErrorPx).toBeLessThanOrEqual(0.5);
  // ...and the consequence: "within a pixel or two of the fully-laid-out
  // truth" (#740's done-when). The budget SCALES, because the error does:
  // `toFixed(2)` caps per-block rounding at 0.005px and Chromium's LayoutUnit
  // snapping adds about 0.008px, so a flat 2px is a count-proportional error
  // measured against a constant — fine at 60 blocks, and a coin toss at 4,000.
  // Signed errors mostly cancel, so in practice this lands near zero.
  expect(Math.abs(r.skipped - r.truth)).toBeLessThanOrEqual(Math.max(2, blocks * 0.02));
}

test.describe.configure({ mode: 'serial' });

let a: LaunchedApp;
let folder: string;

test.beforeAll(async () => {
  folder = tempProjectFolder();
  a = await launchApp({ seedFolder: folder, env: DIRECT });
  await a.window.getByText(path.basename(folder)).first().waitFor({ timeout: 25_000 });
  await a.window.getByPlaceholder(/Prompt this session/).first().waitFor({ timeout: 25_000 });
});

test.afterAll(async () => {
  await a?.cleanup();
});

test.describe('the feed skips what is off screen (#740)', () => {
  test('at 60 blocks, scrollHeight is the fully-laid-out truth', async () => {
    const title = path.basename(folder);
    await streamPrompter(a)(title, `!bulk 60 ${PROSE}A #`);
    await a.window.getByText(`${PROSE}A #60`, { exact: true }).waitFor({ timeout: 60_000 });
    // the measuring pass is observer-driven, so give it frames rather than
    // reading on the same tick the last block landed
    await expect.poll(async () => (await exactness(a.window)).styled, { timeout: 15_000 }).toBe(61);

    expectExact(await exactness(a.window), 61);
  });

  test('at 400 blocks — the size the first attempt was out by +127% — it is still exact', async () => {
    const title = path.basename(folder);
    for (let i = 0; i < 2; i += 1) {
      await streamPrompter(a)(title, `!bulk 170 ${PROSE}B${i} #`);
      await a.window
        .getByText(`${PROSE}B${i} #170`, { exact: true })
        .waitFor({ timeout: 90_000 });
    }
    await expect
      .poll(async () => (await exactness(a.window)).styled, { timeout: 25_000 })
      .toBe(403);

    expectExact(await exactness(a.window), 403);
  });

  test('a NARROWER window re-measures, because a height is only true at one width', async () => {
    // The failure this catches, measured in `spike/probes/740/`: keeping the
    // stored heights across a 954px -> 525px narrowing left `scrollHeight`
    // reading -27.5% against the truth, because prose rewraps and a remembered
    // height does not. Nothing throws; the scroll bar is just wrong, which is
    // the same silent shape as the bug that reverted the first attempt.
    const before = await exactness(a.window);
    expect(before.styled).toBe(before.total);

    await a.app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      const b = win.getBounds();
      // 0.6 of 1280 is below the app's 800px minimum, so this lands at 800 —
      // which still takes the feed itself from 954px to 459px, and at 459px
      // the fixture prose wraps. The clamp is why the assertion below is on
      // the measured width and not on the number asked for.
      win.setBounds({ ...b, width: Math.round(b.width * 0.6) });
    });

    // ⚠️ WAIT FOR THE RESIZE TO ARRIVE BEFORE ASKING WHETHER IT WAS HANDLED.
    //
    // The first version of this test went straight to polling "is it exact
    // again", and passed instantly on the state BEFORE the resize: nothing had
    // relayouted yet, so the skipped and laid-out readings were the same stale
    // number and the condition was already true. Then the premise assertion at
    // the bottom caught it — `after.truth` was identical to `before.truth` —
    // which is the only reason this is not a test that always passes.
    await expect
      .poll(async () => (await exactness(a.window)).width, { timeout: 25_000 })
      .toBeLessThan(before.width);

    // Only now: the re-measure is a full relayout driven by observers, so poll
    // for it rather than guessing a number of frames.
    await expect
      .poll(
        async () => {
          const r = await exactness(a.window);
          return r.styled === r.total && Math.abs(r.skipped - r.truth) <= 2;
        },
        { timeout: 25_000 }
      )
      .toBe(true);

    const after = await exactness(a.window);
    // ASSERT THE PREMISE AGAIN: if the window did not actually get narrower,
    // or the prose did not rewrap, nothing above was tested. A conversation
    // that reflows is a conversation that got TALLER.
    expect(after.truth).toBeGreaterThan(before.truth);
    expectExact(after, after.total);
  });
});
