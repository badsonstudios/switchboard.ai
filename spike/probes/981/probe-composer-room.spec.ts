// PROBE (#981). Dumps the composer column's real geometry around a docking
// approval bar, so the overshoot could be measured instead of reasoned about.
// Findings: `spike/findings/981-composer-offer-vs-render.md`.
//
// ⚠️ HOW TO RUN IT: copy this file into `e2e/` and
// `npx playwright test e2e/probe-composer-room.spec.ts`. It is parked here
// rather than left in the suite because it ASSERTS NOTHING — it prints. The
// claims it produced are pinned in `e2e/feed.spec.ts` → "a bar docking on its
// own gives the composer its room back, and the conversation keeps its floor".
// `spike/**` is outside every tsconfig and eslint ignores it, which is why the
// import below does not resolve from this directory.
import { test, expect } from '@playwright/test';
import { launchApp, permissionHolderBash, LaunchedApp, tempProjectFolder } from './fixtures/app';

let a: LaunchedApp | null = null;
test.afterEach(async () => {
  await a?.close();
  a = null;
});

test('probe: where the composer overshoots its offer (#981)', async () => {
  const folder = tempProjectFolder();
  a = await launchApp({ seedFolder: folder });
  const w = a.window;
  const title = folder.split(/[\\/]/).pop()!;
  await expect(w.getByText(title).first()).toBeVisible({ timeout: 25_000 });

  const box = w.getByPlaceholder(/Prompt this session/);
  const feed = w.locator('[data-feed-region]').first();

  const dump = (label: string): Promise<unknown> =>
    box.evaluate((el, tag) => {
      const t = el as HTMLTextAreaElement;
      const row = t.parentElement!;
      const own = row.parentElement!; // composer root
      const panel = own.parentElement!;
      const cs = getComputedStyle(t);
      const kids = Array.from(panel.children).map((c) => {
        const e = c as HTMLElement;
        const k = getComputedStyle(e);
        return {
          who:
            e === own
              ? 'COMPOSER'
              : e.hasAttribute('data-feed-region')
                ? 'FEED'
                : (e.getAttribute('data-approval-bar') ??
                  e.getAttribute('data-testid') ??
                  e.tagName.toLowerCase()),
          h: e.offsetHeight,
          flex: k.flex,
          minB: k.minBlockSize || k.minHeight,
        };
      });
      const MIN_FEED = 60;
      const chrome = own.offsetHeight - row.offsetHeight;
      const sibs = kids.filter((k) => k.who !== 'COMPOSER' && k.who !== 'FEED').reduce((s, k) => s + k.h, 0);
      return {
        tag,
        panel: panel.clientHeight,
        ownH: own.offsetHeight,
        rowH: row.offsetHeight,
        chrome,
        sibs,
        offer: Math.max(0, panel.clientHeight - (MIN_FEED + chrome + sibs)),
        boxClient: t.clientHeight,
        boxOffset: t.offsetHeight,
        maxB: cs.maxBlockSize,
        minB: cs.minBlockSize,
        pad: Number.parseFloat(cs.paddingBlockStart) + Number.parseFloat(cs.paddingBlockEnd),
        border:
          Number.parseFloat(cs.borderBlockStartWidth) + Number.parseFloat(cs.borderBlockEndWidth),
        boxSizing: cs.boxSizing,
        fieldSizing: cs.getPropertyValue('field-sizing'),
        kids,
      };
    }, label);

  const setHeight = async (px: number): Promise<void> => {
    await a!.app.evaluate(({ BrowserWindow }, h) => {
      const win = BrowserWindow.getAllWindows()[0];
      win.unmaximize();
      win.setContentSize(win.getContentSize()[0], h);
    }, px);
    await w.waitForTimeout(250);
  };

  await box.fill('lorem ipsum dolor sit amet '.repeat(120));

  let found = 0;
  for (const height of [560, 600, 640, 680, 720, 760, 800]) {
    await setHeight(height);
    await w.waitForTimeout(400);
    if ((await feed.boundingBox())!.height < 68) {
      found = height;
      break;
    }
  }
  console.log('PROBE981 window search ->', found);
  console.log('PROBE981', JSON.stringify(await dump('before the bar'), null, 1));

  await permissionHolderBash(a)(title, 'npm run build');
  await expect(w.getByText('Allow Bash?')).toBeVisible({ timeout: 15_000 });

  // the first frame the bar is on screen, then again once everything settles
  console.log('PROBE981', JSON.stringify(await dump('bar just visible'), null, 1));
  await w.waitForTimeout(1500);
  console.log('PROBE981', JSON.stringify(await dump('settled'), null, 1));
  console.log('PROBE981 feed height ->', (await feed.boundingBox())!.height);

  // Does a forced re-measure heal it? Nudging the window by one pixel changes
  // the panel's height, which IS a signal the composer watches.
  await setHeight(found - 1);
  await w.waitForTimeout(800);
  console.log('PROBE981', JSON.stringify(await dump('after a 1px window nudge'), null, 1));
  console.log('PROBE981 feed height after nudge ->', (await feed.boundingBox())!.height);

  // ── THE SECOND DOOR: a bar that GROWS IN PLACE ─────────────────────────────
  // "Deny with feedback" opens an objection field inside the bar. Nothing about
  // which bars are docked changes, so `dockedChrome` does not move.
  const beforeDeny = await box.evaluate((el) => (el as HTMLTextAreaElement).clientHeight);
  await w.locator('[data-approval-deny-feedback]').click();
  await w.waitForTimeout(800);
  console.log('PROBE981 box before deny-feedback ->', beforeDeny);
  console.log('PROBE981', JSON.stringify(await dump('objection field open'), null, 1));
  console.log('PROBE981 feed with field open ->', (await feed.boundingBox())!.height);
  console.log(
    'PROBE981 allow in viewport ->',
    await w.getByRole('button', { name: /^Allow$/ }).isVisible()
  );

  // ── THE TRANSIENT, REPLAYED ────────────────────────────────────────────────
  // `maxB` above says the offer was computed against `available ≈ 78`, i.e. 121px
  // of siblings — but the bar SETTLES at 122 and the strip is 21, which is 143.
  // So at measurement time the bar was ~100: squeezed, because the composer was
  // still tall. Put the box back to its pre-bar height and read the siblings.
  const replay = await box.evaluate((el) => {
    const t = el as HTMLTextAreaElement;
    const row = t.parentElement!;
    const own = row.parentElement!;
    const panel = own.parentElement!;
    const before = t.style.maxBlockSize;
    const read = (tag: string): unknown => {
      void own.offsetHeight; // force layout
      return {
        tag,
        ownH: own.offsetHeight,
        rowH: row.offsetHeight,
        kids: Array.from(panel.children).map((c) => {
          const e = c as HTMLElement;
          return {
            who:
              e === own
                ? 'COMPOSER'
                : e.hasAttribute('data-feed-region')
                  ? 'FEED'
                  : (e.getAttribute('data-approval-bar') ?? 'strip'),
            off: e.offsetHeight,
            scroll: e.scrollHeight,
          };
        }),
      };
    };
    const out = [read('as it settled')];
    t.style.maxBlockSize = '162px'; // the cap it had BEFORE the bar docked
    out.push(read('composer tall again — what roomForBox would have seen'));
    t.style.maxBlockSize = '0px';
    out.push(read('composer collapsed — the siblings at their natural size'));
    t.style.maxBlockSize = before;
    out.push(read('restored'));
    return out;
  });
  console.log('PROBE981 replay', JSON.stringify(replay, null, 1));
});
