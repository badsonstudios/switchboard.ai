// PROBE (#981, raised as a review blocker). Does collapsing the composer for a
// measurement clamp the CONVERSATION's scrollTop? The feed is the only `flex: 1`
// child, so every pixel the box gives up transiently goes to it — and a scroller
// whose clientHeight grows has its scrollTop clamped down.
//
// ANSWER, measured: the clamp is real DURING the collapse (1883 → 1692 with
// 223px of box to give up) and undone exactly by the restore (1883), with no
// `scroll` event dispatched at all — the net change across the synchronous block
// is zero and nothing is delivered in between. See `roomForBox`'s docblock.
//
// ⚠️ Copy into `e2e/` to run it; see the sibling probe's header for why it is
// parked here.
import { test, expect } from '@playwright/test';
import { launchApp, LaunchedApp, tempProjectFolder } from './fixtures/app';

let a: LaunchedApp | null = null;
test.afterEach(async () => {
  await a?.close();
  a = null;
});

test('probe: does the collapse clamp the feed (#981)', async () => {
  const folder = tempProjectFolder();
  a = await launchApp({ seedFolder: folder });
  const w = a.window;
  await expect(w.getByText(folder.split(/[\\/]/).pop()!).first()).toBeVisible({ timeout: 25_000 });

  const box = w.getByPlaceholder(/Prompt this session/);
  await box.fill('lorem ipsum dolor sit amet '.repeat(120));
  await w.waitForTimeout(500);

  // Instrument the real scroller rather than wait for a long conversation: a
  // spacer makes it scrollable, which is the only precondition a clamp needs.
  const out = await box.evaluate((el) => {
    const t = el as HTMLTextAreaElement;
    const own = t.parentElement!.parentElement!;
    const panel = own.parentElement!;
    const feed = panel.querySelector('[data-feed-region]') as HTMLElement;
    const spacer = document.createElement('div');
    spacer.style.blockSize = '2000px';
    feed.appendChild(spacer);
    const events: number[] = [];
    const onScroll = (): void => void events.push(feed.scrollTop);
    feed.addEventListener('scroll', onScroll);

    feed.scrollTop = feed.scrollHeight; // pinned to the tail, as the app keeps it
    void feed.offsetHeight;
    const before = {
      scrollTop: feed.scrollTop,
      clientHeight: feed.clientHeight,
      scrollHeight: feed.scrollHeight,
      boxH: t.clientHeight,
    };

    // exactly what `roomForBox` does
    const held = t.style.maxBlockSize;
    t.style.maxBlockSize = '0px';
    void own.offsetHeight; // the forced layout, in the collapsed state
    const collapsed = { scrollTop: feed.scrollTop, clientHeight: feed.clientHeight };
    t.style.maxBlockSize = held;
    void own.offsetHeight;
    const after = { scrollTop: feed.scrollTop, clientHeight: feed.clientHeight };

    return new Promise((resolve) => {
      setTimeout(() => {
        feed.removeEventListener('scroll', onScroll);
        spacer.remove();
        resolve({ before, collapsed, after, scrollEvents: events, freed: before.boxH });
      }, 500);
    });
  });
  console.log('PROBE981B', JSON.stringify(out, null, 1));
});
