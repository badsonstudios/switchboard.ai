/**
 * E21 tier 2 — the detailed keystroke recorder (#923).
 *
 * ## This module does not exist unless the switch is on
 *
 * It is reached only through the dynamic `import()` in `setDetailEnabled`, so
 * with the switch off it is never evaluated in the renderer at all. That is the
 * literal reading of the owner's rule: *"off must mean the detailed
 * instrumentation is genuinely ABSENT, not a flag checked on every keystroke —
 * I don't want the diagnostics to become the reason it's slow."*
 *
 * ## Everything attaches from OUTSIDE the React tree
 *
 * There is not one perf call anywhere in `FeedView` or `Composer`. This module
 * finds what it needs by itself:
 *
 * - **the keystroke** — one capture-phase listener on `document`, filtered to
 *   `.composer-box`. One listener covers every open card, and adding a card
 *   costs nothing.
 * - **the block counts** — read from `data-perf-blocks` / `data-perf-rendered`
 *   on the feed's root. React writes an attribute only when its value changes,
 *   so with tier 2 off those two numbers cost zero JavaScript. They are not a
 *   registry, a hook or a context, because all three would be code running in
 *   the render path whether or not anyone was measuring.
 * - **the layout reads** — counting descriptors over the layout-forcing
 *   accessors, installed once here and restored on uninstall.
 *
 * The consequence worth stating plainly: turning this on cannot change how the
 * composer renders, because the composer does not know it exists.
 *
 * ## What it does NOT measure, and why
 *
 * **React render counts.** The item's "done when" lists #741's four
 * measurements and render counts are not among them — and counting React
 * renders is impossible from outside the tree, so it would mean a hook or a
 * `<Profiler>` in the render path. That is the one thing rule 2 forbids, and it
 * would tax the exact path E21 exists to measure. #716's suspicion ("draft
 * state lives high, so every keystroke re-renders far more than the textarea")
 * is answered here by `blockedMs` and `layoutReads` instead: a keystroke that
 * re-rendered the world shows up as main-thread time and as forced layout,
 * which is the cost the owner actually feels.
 */
import type { PerfKeystroke } from '../../../shared/perf';
import type { DetailSource } from './perf';

/** How many keystroke samples the summary screen keeps. The file keeps them all. */
const MAX_RECENT = 2_000;

/** The composer's textarea, as `FeedView` classes it. */
const COMPOSER_SELECTOR = '.composer-box';

/**
 * How long a keystroke's frame may take before the sample is abandoned.
 *
 * Generous on purpose: this is not a budget, it is the line past which the
 * number stops being about typing. The worst honest keystroke #740 ever
 * measured was 152ms under a 4x throttle at 400 turns; 2s means the window was
 * not being painted.
 */
const SAMPLE_TIMEOUT_MS = 2_000;

/** Where `FeedView` publishes its counts. */
const BLOCKS_ATTR = 'data-perf-blocks';
const RENDERED_ATTR = 'data-perf-rendered';

export interface PerfDetailDeps {
  /** tier 1's long-task buffer, so a keystroke can be correlated with the block that ate it */
  blockedMsBetween: (from: number, to: number) => number;
}

/**
 * The accessors that force a synchronous layout when read after a write.
 *
 * This list is deliberately the same shape as the one
 * `FeedView.composer.test.tsx` counts at build time. PR #739's guarantee is
 * that typing reads NONE of these; a non-zero count in a capture is therefore
 * not merely a slow number, it is that fix having regressed — which is exactly
 * the thing we could not check on the laptop before now.
 */
const ELEMENT_GETTERS = [
  'scrollHeight',
  'scrollWidth',
  'scrollTop',
  'scrollLeft',
  'clientHeight',
  'clientWidth',
] as const;

const HTML_ELEMENT_GETTERS = ['offsetHeight', 'offsetWidth', 'offsetTop', 'offsetLeft'] as const;

const ELEMENT_METHODS = ['getBoundingClientRect', 'getClientRects'] as const;

interface Restore {
  target: object;
  key: string;
  descriptor: PropertyDescriptor;
}

export function installPerfDetail(deps: PerfDetailDeps): DetailSource {
  const recent: PerfKeystroke[] = [];
  let pending: PerfKeystroke[] = [];
  const restores: Restore[] = [];

  /**
   * Counting only happens inside a keystroke's window.
   *
   * This flag is a COST guard rather than a correctness one, and it is worth
   * being precise about that: the counter is also zeroed when a window opens,
   * so reads taken between keystrokes could not land on the next sample even
   * without it. What it buys is not incrementing a counter on every
   * layout-forcing read in the whole app while the detailed tier is on. The two
   * together are belt and braces — `perf.absent.test.ts` verifies by mutation
   * that removing either leaves the behaviour correct and removing both does
   * not.
   *
   * The patch itself stays installed for as long as tier 2 is on, rather than
   * being applied and removed per keystroke: `defineProperty` is far more
   * expensive than the boolean this closure reads, so patching per keystroke
   * would put real cost on the exact path we are trying to price. The residual
   * cost — one function call and one boolean test per layout read, app-wide —
   * is what the owner opted into when he turned the detailed tier on.
   */
  let sampling = false;
  let layoutReads = 0;

  /**
   * Which object in the chain actually DECLARES `key`.
   *
   * `getComputedStyle` is the case that forces this: it is not an own property
   * of `window`, it lives on `Window.prototype`. Patching the instance would
   * have silently done nothing while every runtime assertion still passed —
   * which is how an instrument ends up reporting zero layout reads because it
   * is not watching, rather than because there were none.
   */
  function ownerOf(target: object, key: string): object | null {
    let o: object | null = target;
    while (o) {
      if (Object.getOwnPropertyDescriptor(o, key)) return o;
      o = Object.getPrototypeOf(o) as object | null;
    }
    return null;
  }

  function patchGetter(from: object, key: string): void {
    const target = ownerOf(from, key);
    if (!target) return;
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    if (!descriptor?.get) return;
    // Pulling a getter off its descriptor is `unbound-method` (#255 T4), and the
    // rule's own remedy is what the next ten lines do: `original.call(this)`
    // supplies the receiver explicitly, because the receiver is whichever
    // element was measured and cannot be bound here.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const original = descriptor.get;
    restores.push({ target, key, descriptor });
    Object.defineProperty(target, key, {
      ...descriptor,
      get(this: unknown): unknown {
        if (sampling) layoutReads += 1;
        return original.call(this);
      },
    });
  }

  /**
   * Wrap a callable, however the platform chose to expose it.
   *
   * `getComputedStyle` is a plain method on `Window.prototype` in Chromium and
   * an ACCESSOR returning a bound function in jsdom, so a patcher that only
   * understood `descriptor.value` would work in the app and quietly do nothing
   * under test — the worst possible split, because the test would then be
   * asserting that an uninstalled probe counts no layout reads. Resolving the
   * property through `from[key]` gets the function either way; the original
   * descriptor is what we put back.
   */
  function patchMethod(from: object, key: string): void {
    const target = ownerOf(from, key);
    if (!target) return;
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    if (!descriptor) return;
    const original = (from as unknown as Record<string, unknown>)[key];
    if (typeof original !== 'function') return;
    const call = original as (...args: unknown[]) => unknown;
    restores.push({ target, key, descriptor });
    Object.defineProperty(target, key, {
      configurable: true,
      enumerable: descriptor.enumerable ?? false,
      writable: true,
      value: function patched(this: unknown, ...args: unknown[]): unknown {
        if (sampling) layoutReads += 1;
        return call.apply(this, args);
      },
    });
  }

  for (const key of ELEMENT_GETTERS) patchGetter(Element.prototype, key);
  for (const key of HTML_ELEMENT_GETTERS) patchGetter(HTMLElement.prototype, key);
  for (const key of ELEMENT_METHODS) patchMethod(Element.prototype, key);
  // `getComputedStyle` is the other half of #739's story — it was the call that
  // made the composer's re-measure document-wide.
  patchMethod(window, 'getComputedStyle');

  function countOn(el: Element | null, attr: string): number {
    const holder = el?.closest(`[${attr}]`);
    const raw = holder?.getAttribute(attr);
    const n = raw === null || raw === undefined ? Number.NaN : Number(raw);
    // -1 rather than 0 for "the feed did not say". A real zero-block feed and a
    // missing attribute must not average together in the findings note.
    return Number.isFinite(n) ? n : -1;
  }

  /**
   * Abandon the sample in flight, if there is one.
   *
   * `sampling` is cleared HERE as well as on the happy path, and that is the
   * whole point of the function existing. Chromium throttles
   * `requestAnimationFrame` to nothing when a window is minimised or fully
   * occluded, and `backgroundThrottling` is not disabled anywhere in this app —
   * so "type a character, then Alt-Tab" leaves the rAF unfired.
   *
   * Two things go wrong if nothing catches that, and both are severe for THIS
   * feature specifically:
   *
   * 1. **The capture goes silent for the rest of the day.** The overlap guard
   *    below returns early while `sampling` is true, so no further keystroke is
   *    ever recorded. P2-E21-02 is "leave it on and work a normal day"; one
   *    mid-keystroke minimise would waste the whole day, which is the same
   *    outcome the store's repair note exists to shout about.
   * 2. **It then cries wolf about the one thing it must never be wrong on.**
   *    `layoutReads` keeps counting app-wide the entire time the window is
   *    hidden, so the stale sample lands with `ms` in the hundreds of thousands
   *    and `layoutReads` in the thousands — and the summary turns amber saying
   *    layout was measured while you typed. That line means PR #739's fix has
   *    regressed, the dogfood tracker tells the owner to stop and report it, and
   *    a false alarm there is the worst possible output of this instrument.
   */
  let abandon: (() => void) | null = null;

  function onKeyDown(event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLTextAreaElement)) return;
    if (!target.matches(COMPOSER_SELECTOR)) return;
    // A keystroke already in flight means the previous frame has not landed.
    // Timing the second one from here would report the tail of the first.
    if (sampling) return;

    const t0 = performance.now();
    layoutReads = 0;
    sampling = true;

    let settled = false;
    const finish = (keep: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      abandon = null;
      const t1 = performance.now();
      const reads = layoutReads;
      sampling = false;
      // A frame that took longer than the watchdog allows did not measure
      // typing; it measured a window that was not being painted. Recording it
      // would put a fabricated stall in the file and a false #739 regression on
      // the screen.
      if (!keep || t1 - t0 > SAMPLE_TIMEOUT_MS || document.visibilityState === 'hidden') return;
      const sample: PerfKeystroke = {
        at: t0,
        ms: t1 - t0,
        blockedMs: deps.blockedMsBetween(t0, t1),
        layoutReads: reads,
        blocks: countOn(target, BLOCKS_ATTR),
        rendered: countOn(target, RENDERED_ATTR),
        // A LENGTH. The one place a character of the draft could have
        // reached the file, and it does not.
        draftLength: target.value.length,
      };
      recent.push(sample);
      if (recent.length > MAX_RECENT) recent.shift();
      pending.push(sample);
      if (pending.length > MAX_RECENT) pending.shift();
    };

    const watchdog = setTimeout(() => finish(false), SAMPLE_TIMEOUT_MS);
    abandon = () => finish(false);
    requestAnimationFrame(() => {
      setTimeout(() => finish(true), 0);
    });
  }

  /**
   * Hiding the window is the common way to strand a frame, so it is caught
   * directly rather than left to the watchdog — the watchdog is the backstop for
   * whatever else can starve a rAF.
   */
  function onVisibility(): void {
    if (document.visibilityState === 'hidden') abandon?.();
  }

  // ⚠️ KNOWN BLIND SPOT: A POPPED-OUT SESSION IS NOT MEASURED.
  //
  // A popout is its OWN document (the JS stays in the opener's realm), so a
  // capture-phase listener here never sees a keydown dispatched in its tree —
  // and that document has its own `Element.prototype`, outside the patches
  // above. A popped-out composer therefore records zero keystroke samples,
  // silently, which is indistinguishable from "you did not type".
  //
  // Not fixed here, deliberately: `subscribePopoutWindows` already exists and
  // three other features use it, so the fix is real work rather than a line,
  // and this item is explicitly scoped to #741's four measurements. It is
  // recorded in `docs/manual/19-performance.md` and in the findings note so the
  // owner does not spend a working day typing into a popout and conclude the
  // instrument is broken. If E21-02 needs popout coverage, that is its own item.
  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('visibilitychange', onVisibility);

  return {
    recent: () => recent,
    drain: () => {
      const out = pending;
      pending = [];
      return out;
    },
    uninstall: () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('visibilitychange', onVisibility);
      abandon?.();
      abandon = null;
      sampling = false;
      // Restored in reverse, so a key patched twice (it is not, but a future
      // edit could) unwinds to the original rather than to the first patch.
      for (const r of restores.reverse()) Object.defineProperty(r.target, r.key, r.descriptor);
      restores.length = 0;
    },
  };
}
