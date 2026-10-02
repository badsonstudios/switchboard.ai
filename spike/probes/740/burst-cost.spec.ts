// #740 follow-up: what does feed skipping cost the ARRIVAL path, not the
// keystroke path?
//
// Why this exists: the docs-only close-out PR for #740 failed
// `e2e/feed-tail-pin.spec.ts` on Windows CI — on its own premise assertion,
// "the first block landed after the 500ms gesture window had closed". That
// test measures the time for a 200-block `!bulk` burst to render, and the same
// code had passed the same job forty minutes earlier, so it is
// nondeterministic. But `useFeedSkipping` DOES add work to that path, and the
// shape of it is bad: a `MutationObserver` runs `sync()` on every childList
// change, and `sync()` is O(blocks). If React commits per block, a burst of n
// blocks is O(n²).
//
// "Probably a flake" is not an answer when the change under suspicion is a
// perf change. This measures it.
//
// Run: copy into e2e/, `npm run build`,
//      `npx playwright test e2e/burst-cost.spec.ts --reporter=list --workers=1`
import { test } from '@playwright/test';
import path from 'path';
import { launchApp, streamPrompter, tempProjectFolder } from './fixtures/app';

test('#740 — the cost of a burst of blocks arriving', async () => {
  test.setTimeout(600_000);
  const folder = tempProjectFolder();
  const a = await launchApp({ seedFolder: folder, env: { SWITCHBOARD_FAKE_PROVIDER: 'stream' } });
  const title = path.basename(folder);

  try {
    const w = a.window;
    await w.getByText(title).first().waitFor({ timeout: 25_000 });
    await w.getByPlaceholder(/Prompt this session/).first().waitFor({ timeout: 25_000 });

    /**
     * Time one `!bulk 200` from submit to the last block being on screen.
     *
     * This is exactly what `feed-tail-pin.spec.ts` measures against its 500ms
     * gesture window, so the number here is directly comparable to the thing
     * that went red.
     */
    const burst = async (tag: string): Promise<number> => {
      const t0 = Date.now();
      await streamPrompter(a)(title, `!bulk 200 ${tag}`);
      await w.getByText(`${tag}200`, { exact: true }).waitFor({ timeout: 120_000 });
      return Date.now() - t0;
    };

    /** strip the hook's styling AND stop it reapplying, by detaching nothing —
     *  the honest off-switch is the one the probe cannot reach, so instead this
     *  reports how many blocks the hook is managing, which is the load it is
     *  under rather than an on/off. */
    const managed = (): Promise<number> =>
      w.evaluate(
        () =>
          [...document.querySelectorAll<HTMLElement>('[data-feed-block]')].filter(
            (b) => getComputedStyle(b).contentVisibility === 'auto'
          ).length
      );

    const rows: { n: number; ms: number; managed: number }[] = [];
    // Growing feed: the quadratic term, if there is one, shows up as the burst
    // time rising with how much conversation is ALREADY there.
    for (let i = 0; i < 6; i += 1) {
      const ms = await burst(`BURST${i}_`);
      const total = await w.evaluate(
        () => document.querySelectorAll('[data-feed-block]').length
      );
      rows.push({ n: total, ms, managed: await managed() });
    }

    /* eslint-disable no-console -- a probe's entire output */
    console.log('\n#740 — 200 blocks arriving, against how much is already there\n');
    console.log('blocks after'.padStart(14) + 'burst ms'.padStart(10) + 'managed'.padStart(9));
    for (const r of rows) {
      console.log(
        String(r.n).padStart(14) + String(r.ms).padStart(10) + String(r.managed).padStart(9)
      );
    }
    console.log(
      '\nA flat column is linear. A column that climbs with the first one is the\n' +
        'O(n^2) the MutationObserver path would produce.\n'
    );
    /* eslint-enable no-console */
  } finally {
    await a.app.close();
  }
});
