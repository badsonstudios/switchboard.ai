// PROBE (#1111). Can the tail pin be made to fail from the outside?
//
// Both earlier rounds (#967, #1079) were reasoned from the code. This one replays
// REAL conversation blocks — derived from a transcript on this machine by the
// app's own `blocksFrom` — into a running app over the real `sessions:feedBlock`
// channel, PACED over ticks (partials growing, tool results landing late), while
// a seeded fuzzer does the things a person does that are NOT scrolling up:
// clicking in the conversation, toggling expanders, wheeling DOWN, pressing a
// modifier with focus in the feed, typing in the composer, resizing the window.
//
// Two things are watched from the page, without touching `FeedView`:
//
//   * FALSE UNPIN — "Jump to latest" appears. The fuzzer never scrolls up, so
//     any appearance is the feed deciding the user left when they did not.
//   * STRANDED — the view sits more than 40px short of the tail with no
//     "Jump to latest" for longer than a few frames: pinned, and not following.
//
// ⚠️ Parked under `spike/probes/1111/`; copy into `e2e/` to run it.
//   PROBE_SEED=3 PROBE_FUZZ=gutter PROBE_SAMPLER=0 npx playwright test e2e/replay-and-fuzz.spec.ts
//
// PROBE_FUZZ: all | click | gutter | wheel | none. PROBE_BACKLOG (980) + PROBE_LIVE
// (260) decide whether the view is at its 1,000-block cap, which is the whole
// finding — see `spike/findings/1111-tail-pin-at-the-cap.md` for the numbers.
import { test, expect } from '@playwright/test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { launchApp, LaunchedApp, preparedStreamPrompt, registerTempDir, pollAsync } from './fixtures/app';
import { DISPLAY_CAPS, FeedBlock } from '../src/main/feed/blocks';
import { blocksFrom } from '../src/main/sessions/transcript-blocks';

const SEED = Number(process.env.PROBE_SEED ?? 1);
const FUZZ = process.env.PROBE_FUZZ ?? 'all';
const BACKLOG = Number(process.env.PROBE_BACKLOG ?? 980);
const LIVE = Number(process.env.PROBE_LIVE ?? 260);
const SPEED = Number(process.env.PROBE_SPEED ?? 1);
// 0 = no 100ms sampler: it reads geometry from a timer, i.e. forces a layout
// between frames, which is itself a way to provoke the bug
const SAMPLER = (process.env.PROBE_SAMPLER ?? '1') !== '0';
const OUT_DIR = path.join(__dirname, '..', '.claude', 'work_files', 'probe-1111');

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function realBlocks(): FeedBlock[] {
  const dir = path.join(os.homedir(), '.claude', 'projects', 'C--Projects-Switchboard-ai');
  // several conversations end to end, mid-sized first: the very largest files
  // are a handful of enormous lines and yield almost no blocks
  const files = process.env.PROBE_TRANSCRIPT
    ? [process.env.PROBE_TRANSCRIPT]
    : fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => path.join(dir, f))
        .filter((f) => {
          const s = fs.statSync(f).size;
          return s > 300_000 && s < 8_000_000;
        })
        .sort();
  const out: FeedBlock[] = [];
  for (const file of files) {
    const entries: Record<string, unknown>[] = [];
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      try {
        entries.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        /* a fragment */
      }
    }
    out.push(...blocksFrom(entries, DISPLAY_CAPS));
    if (out.length >= BACKLOG + LIVE) break;
  }
  return out;
}

interface Ev {
  at: number;
  block: FeedBlock;
}

/** live pacing: partials grow, tool results land late, bursts and pauses */
function schedule(blocks: FeedBlock[], r: () => number): Ev[] {
  const evs: Ev[] = [];
  let t = 0;
  for (const b of blocks) {
    const roll = r();
    t += roll < 0.15 ? 0 : roll < 0.9 ? 30 + r() * 350 : 900 + r() * 1200;
    if ((b.kind === 'assistant' || b.kind === 'thinking') && (b.text?.length ?? 0) > 120) {
      const text = b.text!;
      const steps = Math.min(14, Math.ceil(text.length / 60));
      for (let s = 1; s < steps; s++) {
        evs.push({ at: t, block: { ...b, text: text.slice(0, Math.floor((text.length * s) / steps)) } });
        t += 50;
      }
      evs.push({ at: t, block: b });
    } else if (b.kind === 'tool' && b.tool?.out !== undefined) {
      const { out, ...bare } = b.tool;
      void out;
      evs.push({ at: t, block: { ...b, tool: bare } });
      evs.push({ at: t + 80 + r() * 1400, block: b });
    } else {
      evs.push({ at: t, block: b });
    }
  }
  return evs.map((e) => ({ ...e, at: e.at / SPEED })).sort((x, y) => x.at - y.at);
}

interface Rec {
  t0: number;
  samples: Array<[number, number, number, number, number]>;
  scrolls: Array<[number, number, number, number]>;
  inputs: Array<[number, string, number]>;
  writes: Array<[number, number, number]>;
  stop: boolean;
}

let a: LaunchedApp | null = null;
test.afterEach(async () => {
  await a?.cleanup();
  a = null;
});

test(`probe #1111: seed ${SEED}, fuzz ${FUZZ}`, async () => {
  test.setTimeout(600_000);
  const r = rng(SEED);
  const all = realBlocks();
  const use = all.slice(-(BACKLOG + LIVE)).map((b, i) => ({ ...b, seq: 10_000 + i }));
  const backlog = use.slice(0, BACKLOG);
  const live = schedule(use.slice(BACKLOG), r);
  const lastAt = live[live.length - 1]?.at ?? 0;
  console.log(
    `probe: ${all.length} real blocks; backlog ${backlog.length}, live ${use.length - backlog.length} ` +
      `as ${live.length} messages over ${(lastAt / 1000).toFixed(1)}s`
  );

  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-probe1111-'));
  registerTempDir(folder);
  fs.writeFileSync(path.join(folder, 'README.md'), '# probe\n');
  a = await launchApp({ seedFolder: folder, env: { SWITCHBOARD_FAKE_PROVIDER: 'stream' } });
  const w = a.window;
  const title = path.basename(folder);
  await expect(w.getByText(title).first()).toBeVisible({ timeout: 25_000 });
  await a.app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setBounds({ x: 40, y: 40, width: 1300, height: 900 });
  });

  // a real turn left open, so the card is `working` and its banner is docked
  const send = await preparedStreamPrompt(a, title);
  await send('!hang');
  await expect(w.getByText('working on it')).toBeVisible({ timeout: 30_000 });
  const liveId = await pollAsync(async () => {
    const cards = (await w.evaluate(() => window.switchboard.sessions.cards())) as Array<{
      title: string;
      liveId?: string;
    }>;
    return cards.find((c) => c.title === title)?.liveId ?? null;
  }, 'no live id');

  const inject = (events: Ev[]): Promise<void> =>
    a!.app.evaluate(
      ({ BrowserWindow }, { id, evs }) =>
        new Promise<void>((res) => {
          const wc = BrowserWindow.getAllWindows()[0].webContents;
          const t0 = Date.now();
          let i = 0;
          const tick = (): void => {
            const now = Date.now() - t0;
            while (i < evs.length && evs[i].at <= now) {
              wc.send('sessions:feedBlock', { sessionId: id, block: evs[i].block });
              i += 1;
            }
            if (i >= evs.length) res();
            else setTimeout(tick, 4);
          };
          tick();
        }),
      { id: liveId, evs: events }
    );

  await inject(backlog.map((block) => ({ at: 0, block })));
  await w.waitForTimeout(2_500);

  // the recorder: a passive scroll listener and a 100ms sampler
  await w.evaluate((sampler) => {
    const feed = document.querySelector<HTMLElement>('[data-feed-region]')!;
    const rec: Rec = { t0: Date.now(), samples: [], scrolls: [], inputs: [], writes: [], stop: false };
    (window as unknown as { __p1111: Rec }).__p1111 = rec;
    const now = (): number => Date.now() - rec.t0;
    feed.addEventListener(
      'scroll',
      () => rec.scrolls.push([now(), feed.scrollTop, feed.scrollHeight, feed.clientHeight]),
      { passive: true, capture: true }
    );
    feed.addEventListener('wheel', (e) => rec.inputs.push([now(), 'wheel', e.deltaY]), {
      passive: true,
      capture: true,
    });
    feed.addEventListener('pointerdown', () => rec.inputs.push([now(), 'down', 0]), { capture: true });
    feed.addEventListener('keydown', () => rec.inputs.push([now(), 'key', 0]), { capture: true });
    // every programmatic scrollTop write: [t, asked for, was]
    const desc = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop')!;
    Object.defineProperty(feed, 'scrollTop', {
      configurable: true,
      get() {
        return desc.get!.call(this) as number;
      },
      set(v: number) {
        rec.writes.push([now(), v, desc.get!.call(this) as number]);
        desc.set!.call(this, v);
      },
    });
    // a stray click must never follow a link out of the app
    feed.addEventListener(
      'click',
      (e) => {
        if ((e.target as HTMLElement).closest?.('a')) e.preventDefault();
      },
      { capture: true }
    );
    const id = setInterval(() => {
      if (rec.stop) return clearInterval(id);
      if (!sampler) return;
      rec.samples.push([
        now(),
        feed.scrollTop,
        feed.scrollHeight,
        feed.clientHeight,
        document.querySelector('[data-feed-jump-latest]') ? 1 : 0,
      ]);
    }, 100);
  }, SAMPLER);

  const start = await w.evaluate(() => {
    const f = document.querySelector<HTMLElement>('[data-feed-region]')!;
    return {
      gap: f.scrollHeight - f.scrollTop - f.clientHeight,
      sh: f.scrollHeight,
      ch: f.clientHeight,
      blocks: f.querySelectorAll('[data-feed-block]').length,
      chip: !!document.querySelector('[data-feed-jump-latest]'),
    };
  });
  console.log(`probe: before the stream ${JSON.stringify(start)}`);

  let done = false;
  const streaming = inject(live).then(() => {
    done = true;
  });

  const box = w.getByPlaceholder(/Prompt this session/);
  const region = w.locator('[data-feed-region]');
  const actions: string[] = [];
  const t0 = await w.evaluate(() => (window as unknown as { __p1111: Rec }).__p1111.t0);
  const incidents: number[] = [];
  const note = (what: string): void => void actions.push(`${Date.now() - t0} ${what}`);
  const fixed = await region.boundingBox();
  while (!done) {
    if (FUZZ === 'gutter') {
      // NOTHING here reads geometry: one cached rect, one real click
      if (await w.locator('[data-feed-jump-latest]').count()) {
        incidents.push(Date.now() - t0);
        await w.waitForTimeout(700);
        await w.locator('[data-feed-jump-latest]').click();
        await w.waitForTimeout(700);
        continue;
      }
      await w.mouse.click(fixed!.x + 4, fixed!.y + 20 + r() * (fixed!.height - 80));
      note('gutter');
      await w.waitForTimeout(40 + r() * 500);
      continue;
    }
    if (FUZZ === 'none') {
      await w.waitForTimeout(250);
      continue;
    }
    if (await w.locator('[data-feed-jump-latest]').count()) {
      incidents.push(Date.now() - t0);
      await w.waitForTimeout(700);
      await w.locator('[data-feed-jump-latest]').click();
      await w.waitForTimeout(700);
      continue;
    }
    const roll = r();
    const rb = await region.boundingBox();
    if (!rb) break;
    try {
      if (roll < 0.25 && FUZZ !== 'wheel') {
        // a click that is not on anything: the gutter of whatever is there
        await w.mouse.click(rb.x + 4, rb.y + 20 + r() * (rb.height - 40));
        note('gutter');
      } else if (roll < 0.45 && FUZZ !== 'wheel') {
        const spots = await w.evaluate(() => {
          const f = document.querySelector<HTMLElement>('[data-feed-region]')!;
          const fr = f.getBoundingClientRect();
          return [...f.querySelectorAll<HTMLElement>('[aria-expanded]')]
            .map((e) => e.getBoundingClientRect())
            .filter((q) => q.top > fr.top + 4 && q.bottom < fr.bottom - 4 && q.width > 0)
            .map((q) => [q.left + Math.min(12, q.width / 2), q.top + q.height / 2]);
        });
        if (spots.length) {
          const s = spots[Math.floor(r() * spots.length)];
          await w.mouse.click(s[0], s[1]);
          note('expander');
        }
      } else if (roll < 0.62 && FUZZ !== 'click') {
        await w.mouse.move(rb.x + rb.width / 2, rb.y + rb.height / 2);
        await w.mouse.wheel(0, 100 + r() * 500);
        note('wheel-down');
      } else if (roll < 0.72 && FUZZ === 'all') {
        await region.focus();
        await w.keyboard.press(r() < 0.5 ? 'Shift' : 'Control');
        note('modifier');
      } else if (roll < 0.84 && FUZZ === 'all') {
        await box.fill(r() < 0.5 ? '' : 'draft line\n'.repeat(1 + Math.floor(r() * 6)));
        note('composer');
      } else if (roll < 0.9 && FUZZ === 'all') {
        const hgt = 820 + Math.floor(r() * 160);
        const wid = 1200 + Math.floor(r() * 200);
        await a.app.evaluate(
          ({ BrowserWindow }, s) => {
            BrowserWindow.getAllWindows()[0]?.setBounds({ x: 40, y: 40, width: s[0], height: s[1] });
          },
          [wid, hgt]
        );
        note('resize');
      }
    } catch (e) {
      actions.push(`ERR ${String(e).slice(0, 80)}`);
    }
    await w.waitForTimeout(40 + r() * 500);
  }
  await streaming;
  await w.waitForTimeout(1_500);

  const rec = await w.evaluate(() => {
    const p = (window as unknown as { __p1111: Rec }).__p1111;
    p.stop = true;
    return p;
  });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outFile = path.join(OUT_DIR, `seed${SEED}-${FUZZ}.json`);
  fs.writeFileSync(outFile, JSON.stringify({ rec, actions, incidents }));

  // ── the verdict ────────────────────────────────────────────────────────────
  const firstChip = rec.samples.find((s) => s[4] === 1);
  let strandedMs = 0;
  let worst = 0;
  let worstAt = 0;
  let runStart = -1;
  for (const [t, top, sh, ch, chip] of rec.samples) {
    const gap = sh - top - ch;
    if (gap > 40 && chip === 0) {
      if (runStart < 0) runStart = t;
      if (t - runStart > worst) {
        worst = t - runStart;
        worstAt = runStart;
      }
    } else runStart = -1;
  }
  strandedMs = worst;
  const end = await w.evaluate(() => {
    const f = document.querySelector<HTMLElement>('[data-feed-region]')!;
    return [f.scrollHeight - f.scrollTop - f.clientHeight, document.querySelector('[data-feed-jump-latest]') ? 1 : 0];
  });
  const last = [0, 0, 0, 0, end[1]];
  const endGap = end[0];
  const upward = rec.inputs.filter((i) => i[1] === 'wheel' && i[2] < 0).length;
  const counts: Record<string, number> = {};
  for (const x of actions) counts[x.split(' ')[1]] = (counts[x.split(' ')[1]] ?? 0) + 1;
  console.log(
    `probe verdict: seed ${SEED} fuzz ${FUZZ} | actions ${JSON.stringify(counts)} | upward wheels ${upward} | ` +
      `jump-chip first seen ${firstChip ? `${firstChip[0]}ms` : 'never'} | ` +
      `longest pinned-but-short run ${strandedMs}ms (from ${worstAt}ms) | end gap ${endGap} chip ${last[4]} | ${outFile}`
  );
  console.log(`probe: ${incidents.length} false-unpin incidents at ${JSON.stringify(incidents)}`);
  for (const at of incidents.slice(0, 6)) {
    console.log('probe: actions before: ' + JSON.stringify(actions.filter((x) => { const t = Number(x.split(' ')[0]); return t > at - 2500 && t <= at; })));
    console.log('probe: writes before [t, asked, was]: ' + JSON.stringify(rec.writes.filter((i) => i[0] > at - 2500 && i[0] <= at).map((x) => x.map(Math.round))));
    console.log(
      'probe: inputs in the 1.5s before the chip: ' +
        JSON.stringify(rec.inputs.filter((i) => i[0] > at - 2500 && i[0] <= at))
    );
    console.log(
      'probe: scroll events in the 1.5s before the chip [t, top, sh, ch]: ' +
        JSON.stringify(rec.scrolls.filter((s) => s[0] > at - 2500 && s[0] <= at).map((x) => x.map(Math.round)))
    );
  }
});
