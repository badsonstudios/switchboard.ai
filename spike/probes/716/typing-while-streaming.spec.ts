// PROBE (#716, #1013). What does typing cost while a reply is streaming?
//
// The owner, 2026-10-05, on the current build and the DESKTOP: *"if I have a
// session going and Claude is busy, typing into the prompt can be sluggish."*
//
// #1062 lists what was never measured: "what ONE feed render costs in the
// renderer at 400+ turns". This measures it from the outside, in the real app:
// a conversation of REAL blocks (the app's own `blocksFrom` over transcripts on
// this machine), one reply streaming into it as growing partials every 50ms —
// exactly what `STREAM_COALESCE_MS` lets through — while a key is typed into the
// prompt box every 100ms.
//
// Read off the page's own instruments, nothing of ours on the keystroke path:
//
//   * Event Timing (`PerformanceObserver` type `event`): for each keydown, how
//     long until the frame that showed it (`duration`), and how long it waited
//     before its handler even started (`processingStart - startTime`);
//   * long tasks: how many, and how much of the window they took;
//   * frames: the gaps between animation frames.
//
// ⚠️ Parked under `spike/probes/716/`; copy into `e2e/` to run it.
//   PROBE_BACKLOG=980 PROBE_STREAM=1 PROBE_THROTTLE=1 npx playwright test e2e/typing-while-streaming.spec.ts
import { test, expect } from '@playwright/test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { launchApp, LaunchedApp, preparedStreamPrompt, registerTempDir, pollAsync } from './fixtures/app';
import { DISPLAY_CAPS, FeedBlock } from '../src/main/feed/blocks';
import { blocksFrom } from '../src/main/sessions/transcript-blocks';

const BACKLOG = Number(process.env.PROBE_BACKLOG ?? 980);
const STREAM = (process.env.PROBE_STREAM ?? '1') !== '0';
const THROTTLE = Number(process.env.PROBE_THROTTLE ?? 1);
const SECONDS = Number(process.env.PROBE_SECONDS ?? 12);
/** how many replies stream at once into the ONE visible session */
const LABEL = process.env.PROBE_LABEL ?? '';
/**
 * `PROBE_PROFILE=1`: a sampling CPU profile of the renderer over the measured
 * window, printed as the functions with the most SELF time. Only readable
 * against an unminified build — add `minify: false` to the renderer's `build`
 * in `electron.vite.config.ts` for the run, and take it out again.
 */
const PROFILE = process.env.PROBE_PROFILE === '1';

function realBlocks(want: number): FeedBlock[] {
  const dir = path.join(os.homedir(), '.claude', 'projects', 'C--Projects-Switchboard-ai');
  const files = fs
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
    if (out.length >= want) break;
  }
  return out.slice(-want);
}

interface Rec {
  keys: Array<[number, number]>;
  long: number[];
  frames: number[];
  stop: boolean;
}

const pct = (xs: number[], p: number): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]);
};

let a: LaunchedApp | null = null;
test.afterEach(async () => {
  await a?.cleanup();
  a = null;
});

test(`probe #716: backlog ${BACKLOG}, stream ${STREAM}, throttle ${THROTTLE}x ${LABEL}`, async () => {
  test.setTimeout(300_000);
  const backlog = realBlocks(BACKLOG).map((b, i) => ({ ...b, seq: 10_000 + i }));

  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-probe716-'));
  registerTempDir(folder);
  fs.writeFileSync(path.join(folder, 'README.md'), '# probe\n');
  a = await launchApp({ seedFolder: folder, env: { SWITCHBOARD_FAKE_PROVIDER: 'stream' } });
  const w = a.window;
  const title = path.basename(folder);
  await expect(w.getByText(title).first()).toBeVisible({ timeout: 25_000 });
  await a.app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setBounds({ x: 40, y: 40, width: 1300, height: 900 });
  });
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

  // the conversation, all at once
  await a.app.evaluate(
    ({ BrowserWindow }, { id, blocks }) => {
      const wc = BrowserWindow.getAllWindows()[0].webContents;
      for (const block of blocks) wc.send('sessions:feedBlock', { sessionId: id, block });
    },
    { id: liveId, blocks: backlog }
  );
  await w.waitForTimeout(4_000);

  const cdp = await w.context().newCDPSession(w);
  if (THROTTLE > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });

  const box = w.getByPlaceholder(/Prompt this session/);
  await box.click();

  await w.evaluate(() => {
    const rec: Rec = { keys: [], long: [], frames: [], stop: false };
    (window as unknown as { __p716: Rec }).__p716 = rec;
    new PerformanceObserver((list) => {
      for (const e of list.getEntries() as PerformanceEventTiming[]) {
        if (e.name === 'keydown') rec.keys.push([e.duration, e.processingStart - e.startTime]);
      }
    }).observe({ type: 'event', durationThreshold: 16, buffered: false } as PerformanceObserverInit);
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) rec.long.push(e.duration);
    }).observe({ type: 'longtask' });
    let last = performance.now();
    const tick = (now: number): void => {
      rec.frames.push(now - last);
      last = now;
      if (!rec.stop) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  // the reply: one block, growing by ~12 characters every 50ms — 60 tokens/sec
  // through `STREAM_COALESCE_MS`, which is what the shipped code lets through
  const words = 'the quick brown fox jumps over the lazy dog and keeps on running through the field ';
  let streamed = Promise.resolve();
  if (STREAM) {
    streamed = a.app.evaluate(
      ({ BrowserWindow }, { id, text, ms, still }) =>
        new Promise<void>((done) => {
          const wc = BrowserWindow.getAllWindows()[0].webContents;
          const t0 = Date.now();
          let n = 0;
          const timer = setInterval(() => {
            n += 12;
            let body = '';
            while (body.length < n) body += text;
            wc.send('sessions:feedBlock', {
              sessionId: id,
              // `still`: the same text in a new object — React re-renders, the DOM does not change
              block: { seq: 900_000, kind: 'assistant', text: still ? body.slice(0, 600) : body.slice(0, n) },
            });
            if (Date.now() - t0 > ms) {
              clearInterval(timer);
              done();
            }
          }, 50);
        }),
      { id: liveId, text: words, ms: SECONDS * 1000, still: process.env.PROBE_STILL === '1' }
    );
  }

  if (PROFILE) {
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.setSamplingInterval', { interval: 500 });
    await cdp.send('Profiler.start');
  }
  const until = Date.now() + SECONDS * 1000;
  let typed = 0;
  while (Date.now() < until) {
    await w.keyboard.type('x');
    typed += 1;
    await w.waitForTimeout(100);
  }
  await streamed;
  if (PROFILE) {
    const { profile } = await cdp.send('Profiler.stop');
    const self = new Map<number, number>();
    const deltas = profile.timeDeltas ?? [];
    (profile.samples ?? []).forEach((id, i) => self.set(id, (self.get(id) ?? 0) + (deltas[i] ?? 0)));
    const byFn = new Map<string, number>();
    let total = 0;
    for (const node of profile.nodes) {
      const us = self.get(node.id) ?? 0;
      const f = node.callFrame;
      const where = `${f.functionName || '(anonymous)'} ${f.url.split('/').pop() ?? ''}:${f.lineNumber + 1}`;
      byFn.set(where, (byFn.get(where) ?? 0) + us);
      if (f.functionName !== '(idle)' && f.functionName !== '(program)') total += us;
    }
    const top = [...byFn.entries()].sort((x, y) => y[1] - x[1]).slice(0, 40);
    console.log(`probe716 profile: ${Math.round(total / 1000)} ms of script in the window (throttled clock)`);
    for (const [where, us] of top) console.log(`probe716 profile: ${String(Math.round(us / 1000)).padStart(6)} ms  ${where}`);
  }
  await w.waitForTimeout(500);

  const rec = await w.evaluate(() => {
    const p = (window as unknown as { __p716: Rec }).__p716;
    p.stop = true;
    return p;
  });
  const dur = rec.keys.map((k) => k[0]);
  const delay = rec.keys.map((k) => k[1]);
  const longTotal = Math.round(rec.long.reduce((x, y) => x + y, 0));
  const slowFrames = rec.frames.filter((f) => f > 50).length;
  const blocks = await w.locator('[data-perf-blocks]').first().getAttribute('data-perf-blocks');
  console.log(
    `probe716 ${LABEL} | blocks ${blocks} stream ${STREAM} throttle ${THROTTLE}x | typed ${typed}, ` +
      `slow keydowns(>=16ms) ${rec.keys.length} | key->paint p50 ${pct(dur, 50)} p95 ${pct(dur, 95)} max ${pct(dur, 100)} ms | ` +
      `input delay p50 ${pct(delay, 50)} p95 ${pct(delay, 95)} max ${pct(delay, 100)} ms | ` +
      `long tasks ${rec.long.length}, ${longTotal} ms of ${SECONDS * 1000} (worst ${pct(rec.long, 100)}) | ` +
      `frames ${rec.frames.length}, p95 gap ${pct(rec.frames, 95)} ms, >50ms: ${slowFrames}`
  );
});
