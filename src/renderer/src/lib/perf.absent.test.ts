// @vitest-environment jsdom
/**
 * "Off means genuinely ABSENT, not a flag checked on every keystroke."
 *
 * That is owner decision 2 of E21 and it is the one requirement in #923 that a
 * comment cannot discharge, because the thing it forbids — instrumentation that
 * taxes the path it is measuring — looks exactly like instrumentation that does
 * not, right up until you measure. So it is pinned here three ways:
 *
 * 1. the tier-2 module is not evaluated at all until the switch is thrown;
 * 2. nothing in the composer's render path imports it, or tier 1, or anything
 *    else from this family — asserted against the SOURCE, because that is the
 *    property that would rot first;
 * 3. switching off restores the patched prototypes to the very descriptor
 *    objects that were there before, so a renderer that has been measured is
 *    indistinguishable from one that never was.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  FLUSH_MS,
  detailLoaded,
  flushPerf,
  installPerf,
  resetPerfForTests,
  setDetailEnabled,
  uninstallPerf,
} from './perf';
import type { PerfBatch } from '../../../shared/perf';

const WATCHED = [
  ['Element', 'scrollHeight'],
  ['Element', 'clientHeight'],
  ['Element', 'scrollTop'],
  ['HTMLElement', 'offsetHeight'],
] as const;

const protoFor = (name: string): object =>
  name === 'Element' ? Element.prototype : HTMLElement.prototype;

/**
 * The ACCESSOR FUNCTIONS, not the descriptor objects.
 *
 * `getOwnPropertyDescriptor` allocates a fresh wrapper on every call, so
 * comparing those by identity compares nothing. The getter inside it is the
 * thing that either is or is not the browser's own implementation, and that is
 * the whole question.
 */
function accessors(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [proto, key] of WATCHED) {
    const d = Object.getOwnPropertyDescriptor(protoFor(proto), key);
    // `unbound-method` (#255 T4) does not apply: these are compared by identity
    // and never called, which is the entire assertion.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    out[`${proto}.${key}`] = d?.get ?? d?.value;
  }
  // Read through a descriptor lookup rather than as `window.getComputedStyle`:
  // pulling a method off its object is `unbound-method` (#255 T4), and here we
  // only ever compare it by identity — it is never called.
  const gcs = Object.getOwnPropertyDescriptor(window, 'getComputedStyle');
  out['window.getComputedStyle'] = gcs?.get ? gcs.get.call(window) : gcs?.value;
  return out;
}

/**
 * The accessors as they are before a single line of this file's body runs —
 * i.e. after tier 1 has been imported and before anything has been switched on.
 * Importing the recorder must not itself patch anything.
 */
const PRISTINE = accessors();

let batches: PerfBatch[];
let box: HTMLTextAreaElement;
let realRaf: typeof requestAnimationFrame;

/** Let the rAF → task → sample chain run to completion. */
async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

function typeOneKey(): void {
  box.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
}

beforeEach(() => {
  batches = [];
  realRaf = globalThis.requestAnimationFrame;
  // jsdom's rAF, where it exists at all, is tied to a paint clock this test has
  // no use for. Run the callback as a task instead — the ORDER is what the
  // recorder depends on, not the frame timing.
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback): number => {
    setTimeout(() => cb(0), 0);
    return 0;
  });

  document.body.innerHTML = '';
  const root = document.createElement('div');
  root.setAttribute('data-perf-blocks', '412');
  root.setAttribute('data-perf-rendered', '120');
  box = document.createElement('textarea');
  box.className = 'composer-box';
  root.append(box);
  document.body.append(root);

  resetPerfForTests();
  installPerf({
    record: (b) => batches.push(b),
    mainStats: () => Promise.resolve(null),
  });
});

afterEach(async () => {
  await setDetailEnabled(false);
  uninstallPerf();
  resetPerfForTests();
  globalThis.requestAnimationFrame = realRaf;
});

describe('with the switch OFF, tier 2 is absent (#923)', () => {
  it('has not loaded the detailed module at all', () => {
    expect(detailLoaded()).toBe(false);
  });

  it('has patched nothing — the layout accessors are the ones we started with', () => {
    // `PRISTINE` was captured at module load, before anything in this file ran.
    // This catches a patch applied at IMPORT time rather than at enable time,
    // which every runtime assertion below would happily pass.
    const native = accessors();
    for (const key of Object.keys(PRISTINE))
      expect(native[key], `${key} was touched by merely importing tier 1`).toBe(PRISTINE[key]);
    expect(detailLoaded()).toBe(false);
  });

  it('records no keystroke sample, because no listener exists to record one', async () => {
    typeOneKey();
    await settle();
    flushPerf();
    expect(batches.flatMap((b) => b.keystrokes)).toHaveLength(0);
  });

  it('sends nothing to main — there is no flush timer while the switch is off', async () => {
    // Tier 1 keeps its buffers for the summary screen, but the capture file
    // does not exist, so an IPC message would be a message about nothing.
    //
    // FAKE TIMERS, and they are the assertion. The first version of this test
    // waited two macrotasks against a 5-SECOND flush interval, so starting the
    // timer unconditionally in `installPerf` left it green — it proved only
    // that nothing flushed synchronously. Advancing past `FLUSH_MS` is what
    // makes the name true.
    typeOneKey();
    await settle();

    vi.useFakeTimers();
    try {
      vi.advanceTimersByTime(FLUSH_MS * 4);
    } finally {
      vi.useRealTimers();
    }
    expect(batches).toHaveLength(0);
  });
});

describe('with the switch ON, tier 2 measures (#923)', () => {
  it('loads the module and records a keystroke with its block counts', async () => {
    await setDetailEnabled(true);
    expect(detailLoaded()).toBe(true);

    typeOneKey();
    await settle();
    flushPerf();

    const [sample] = batches.flatMap((b) => b.keystrokes);
    expect(sample).toBeDefined();
    // Read off `data-perf-*` by `closest()` — the composer was never asked.
    expect(sample.blocks).toBe(412);
    expect(sample.rendered).toBe(120);
  });

  it('counts a layout read taken during the keystroke — #739 says this is 0', async () => {
    await setDetailEnabled(true);
    // Stand in for the regression: something reads a layout-forcing property
    // while the frame is in flight. `FeedView.composer.test.tsx` asserts this
    // cannot happen; THIS is the runtime form, on the machine that struggles.
    box.addEventListener('keydown', () => void box.scrollHeight);

    typeOneKey();
    await settle();
    flushPerf();

    expect(batches.flatMap((b) => b.keystrokes)[0]?.layoutReads).toBeGreaterThan(0);
  });

  it('counts nothing outside a keystroke window', async () => {
    // NOTE, because the name over-promises if read quickly: the counter is also
    // zeroed when a window OPENS, so this passes whether or not the `sampling`
    // guard exists. The guard's real job is pinned by the test below, which
    // reads the count of a sample that has already closed.
    await setDetailEnabled(true);
    void box.scrollHeight;
    void box.scrollHeight;

    typeOneKey();
    await settle();
    flushPerf();

    expect(batches.flatMap((b) => b.keystrokes)[0]?.layoutReads).toBe(0);
  });

  it('reads taken BETWEEN keystrokes never land on the next sample', async () => {
    // The property that keeps the layout-read number honest, and the reason a
    // false reading here matters: any non-zero count makes the summary claim
    // PR #739's fix has regressed, which the dogfood tracker tells the owner to
    // stop and report.
    //
    // TWO mechanisms deliver it and EITHER ALONE IS SUFFICIENT — the counter is
    // reset when a window opens, and the patched accessors only count while one
    // is open. Verified by mutation: removing either one leaves this green,
    // removing BOTH turns it red. That is stated rather than hidden, because a
    // reviewer asked exactly the right question of the `sampling` flag and the
    // answer is that it is a cost guard which happens to be redundant here.
    await setDetailEnabled(true);
    typeOneKey();
    await settle();
    flushPerf(); // drain the first sample, so what follows is only the second
    batches = [];

    for (let i = 0; i < 25; i += 1) void box.scrollHeight;

    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', bubbles: true }));
    await settle();
    flushPerf();

    const samples = batches.flatMap((b) => b.keystrokes);
    expect(samples).toHaveLength(1);
    expect(samples[0].layoutReads).toBe(0);
  });

  it('a second key inside the same frame does not open a second sample', async () => {
    // The overlap guard. Timing the second key from its own keydown would
    // report the tail of the first frame as if it were a whole keystroke.
    await setDetailEnabled(true);
    typeOneKey();
    typeOneKey();
    typeOneKey();
    await settle();
    flushPerf();

    expect(batches.flatMap((b) => b.keystrokes)).toHaveLength(1);
  });

  it('records the draft LENGTH and nothing that could spell it', async () => {
    await setDetailEnabled(true);
    box.value = 'delete the production database';

    typeOneKey();
    await settle();
    flushPerf();

    const sample = batches.flatMap((b) => b.keystrokes)[0];
    expect(sample.draftLength).toBe('delete the production database'.length);
    expect(JSON.stringify(batches)).not.toContain('production');
  });

  it('says -1, not 0, when the feed published no count', async () => {
    // A real zero-block feed and a missing attribute must not average together
    // in the findings note E21-03 writes from this file.
    document.body.innerHTML = '';
    const bare = document.createElement('textarea');
    bare.className = 'composer-box';
    document.body.append(bare);

    await setDetailEnabled(true);
    bare.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    await settle();
    flushPerf();

    expect(batches.flatMap((b) => b.keystrokes)[0]?.blocks).toBe(-1);
  });
});

describe('the switch cannot be raced (#923 review, blocker 1)', () => {
  // The dynamic import is what makes "off means absent" true, and it is also
  // what makes the switch racy: turning ON awaits a chunk fetch while turning
  // OFF is synchronous. Both cases below shipped in the first draft.

  it('on-then-off before the import lands installs NOTHING', async () => {
    // A mis-click. Without a generation counter the off-path saw `detail` still
    // null, uninstalled nothing, and the import then installed the listener and
    // the prototype patches for the life of the renderer — while the checkbox,
    // workspace.json and getPerfCapture() all said OFF.
    const on = setDetailEnabled(true);
    const off = setDetailEnabled(false);
    await Promise.all([on, off]);

    expect(detailLoaded()).toBe(false);
    const after = accessors();
    for (const key of Object.keys(PRISTINE))
      expect(after[key], `${key} was left patched by a switch nobody left on`).toBe(PRISTINE[key]);

    batches = [];
    typeOneKey();
    await settle();
    flushPerf();
    expect(batches.flatMap((b) => b.keystrokes)).toHaveLength(0);
  });

  it('on-off-on installs exactly once, and switching off still restores the ORIGINALS', async () => {
    // The worse ordering. Two installs left the first source orphaned with its
    // listener attached, and the second captured the ALREADY-PATCHED accessors
    // as its originals — so switching off restored them to the orphan's
    // wrapper, an unremovable tax for the rest of the session.
    const a = setDetailEnabled(true);
    const b = setDetailEnabled(false);
    const c = setDetailEnabled(true);
    await Promise.all([a, b, c]);
    expect(detailLoaded()).toBe(true);

    batches = [];
    typeOneKey();
    await settle();
    flushPerf();
    // Two listeners would record the same keystroke twice.
    expect(batches.flatMap((k) => k.keystrokes)).toHaveLength(1);

    await setDetailEnabled(false);
    const after = accessors();
    for (const key of Object.keys(PRISTINE))
      expect(after[key], `${key} was restored to a wrapper, not the original`).toBe(PRISTINE[key]);
  });
});

describe('a frame that never arrives (#923 review, blocker 2)', () => {
  // Chromium throttles rAF to nothing when a window is minimised or occluded.
  // "Type a character, then Alt-Tab" therefore strands the sample in flight.

  it('does not wedge the recorder — the next keystroke is still measured', async () => {
    // The silent-capture failure: the overlap guard returns early while a
    // sample is open, so ONE stranded frame would cost the rest of the working
    // day P2-E21-02 exists to record.
    const stranded: FrameRequestCallback[] = [];
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback): number => {
      stranded.push(cb); // never called
      return 0;
    });

    await setDetailEnabled(true);
    typeOneKey();
    await settle();

    // The watchdog is the backstop; hiding the window is the direct path, and
    // it is the one a person actually takes.
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    });
    document.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });

    // Frames work again; the recorder must too.
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback): number => {
      setTimeout(() => cb(0), 0);
      return 0;
    });
    batches = [];
    typeOneKey();
    await settle();
    flushPerf();
    expect(batches.flatMap((k) => k.keystrokes)).toHaveLength(1);
  });

  it('never files the stranded frame as a keystroke — no fabricated stall, no false #739 alarm', async () => {
    // The cry-wolf failure. `layoutReads` keeps counting app-wide while the
    // window is hidden, so a stale sample lands with a huge `ms` and a large
    // read count — and the summary turns amber saying layout was measured while
    // you typed, which the dogfood tracker tells the owner to STOP and report.
    // Held in a box: TypeScript narrows a bare `let` assigned only inside a
    // callback to `never` at the use site, because it cannot see the callback
    // run.
    const frame: { held: FrameRequestCallback | null } = { held: null };
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback): number => {
      frame.held = cb;
      return 0;
    });

    await setDetailEnabled(true);
    typeOneKey();
    await settle();

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    });
    document.dispatchEvent(new Event('visibilitychange'));
    // Time passes with the window hidden; other code reads layout.
    for (let i = 0; i < 40; i += 1) void box.scrollHeight;
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });

    // The window comes back and the stale frame finally fires.
    frame.held?.(0);
    await settle();
    flushPerf();
    expect(batches.flatMap((k) => k.keystrokes)).toHaveLength(0);
  });
});

describe('switching back off leaves no trace (#923)', () => {
  it('restores the exact descriptor objects that were there before', async () => {
    // Identity, not shape. A "restored" accessor that is a fresh wrapper around
    // the original would still cost a call on every layout read for the rest of
    // the session — which is precisely the tax the rule forbids.
    const before = accessors();
    await setDetailEnabled(true);

    const during = accessors();
    for (const key of Object.keys(before))
      expect(during[key], `${key} was not patched`).not.toBe(before[key]);

    await setDetailEnabled(false);

    const after = accessors();
    for (const key of Object.keys(before))
      expect(after[key], `${key} was not restored`).toBe(before[key]);
  });

  it('stops recording, and the module is unloaded as far as the app is concerned', async () => {
    await setDetailEnabled(true);
    await setDetailEnabled(false);
    expect(detailLoaded()).toBe(false);

    batches = [];
    typeOneKey();
    await settle();
    flushPerf();
    expect(batches.flatMap((b) => b.keystrokes)).toHaveLength(0);
  });

  it('flushes the tail before it goes, so the last keystrokes are not lost', async () => {
    await setDetailEnabled(true);
    typeOneKey();
    await settle();

    batches = [];
    await setDetailEnabled(false);
    expect(batches.flatMap((b) => b.keystrokes).length).toBeGreaterThan(0);
  });
});

describe('the composer path mentions none of this (#923)', () => {
  // The structural half of "genuinely absent", and the one most likely to rot:
  // someone adds `recordKeystroke()` to the onChange handler in six months
  // because it is the obvious place to put it, and every runtime test above
  // still passes. This is what goes red.
  const read = (rel: string): string =>
    fs.readFileSync(path.join(process.cwd(), 'src/renderer/src', rel), 'utf8');

  it('FeedView — which owns both the composer and the feed — imports no perf module', () => {
    const src = read('components/FeedView.tsx');
    expect(src).not.toMatch(/from\s+['"][^'"]*lib\/perf(-detail)?['"]/);
    // It publishes two data attributes and that is the whole of its
    // involvement.
    expect(src).toContain('data-perf-blocks');
  });

  it('tier 2 is reached ONLY by dynamic import, never by a static one', () => {
    const tier1 = read('lib/perf.ts');
    expect(tier1).toMatch(/await import\(['"]\.\/perf-detail['"]\)/);
    expect(tier1).not.toMatch(/^import .*perf-detail/m);
  });

  it('nothing else in the renderer imports tier 2 directly', () => {
    // A static import anywhere would put the module in the main bundle and
    // evaluate it at boot, which is the one thing the dynamic import buys.
    const base = path.join(process.cwd(), 'src/renderer/src');
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry.name) && !entry.name.includes('.test.')) {
          if (/^import .*['"].*perf-detail['"]/m.test(fs.readFileSync(full, 'utf8')))
            offenders.push(full);
        }
      }
    };
    walk(base);
    expect(offenders).toEqual([]);
  });
});

describe('tier 1 survives a browser that cannot do what it asks (#923)', () => {
  it('an unsupported entry type costs that observer, not the renderer', () => {
    // Fail-open is a hard constraint and it applies to our own diagnostics
    // first. jsdom has no `longtask`, which makes this the honest default case.
    uninstallPerf();
    const boom = vi.fn(() => {
      throw new Error('unsupported entryType');
    });
    const original = globalThis.PerformanceObserver;
    globalThis.PerformanceObserver = boom as unknown as typeof PerformanceObserver;
    try {
      expect(() =>
        installPerf({ record: () => undefined, mainStats: () => Promise.resolve(null) })
      ).not.toThrow();
    } finally {
      globalThis.PerformanceObserver = original;
    }
  });
});
