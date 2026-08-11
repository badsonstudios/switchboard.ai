// @vitest-environment jsdom
// The component half of the urgency lamp's contrast promise (#267).
//
// tokens.drift.test.ts measures the RULES — `color: var(--lamp-ink)` over 12%
// (15% under the pointer) of `var(--lamp-hue)` mixed into `var(--panel2)`, for
// every ramp position in every shipped theme. Two things it cannot see are
// decided here:
//
//   1. WHICH pair each lamp receives. Swap the two lines in UrgencyStrip and a
//      needing lamp writes the raw hue on a wash of itself — the #221 defect
//      verbatim — with the whole drift suite still green.
//   2. WHAT IS BEHIND THE WASH. The rules mix into `var(--panel2)` because the
//      strip paints `--panel2`; move the strip onto some other surface and
//      every ratio the drift test computes becomes a fiction while staying
//      perfectly green. Same guard, and the same reason, as CollapsedStrip's.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { act, useCallback, useEffect, useState, type ReactElement, type ReactNode } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { initI18nForTests } from '../i18n/test-i18n';
import { UrgencyStrip } from './UrgencyStrip';
import { RailSession } from '../model/types';
import { presentStatus, STATUS_TOKENS } from '../lib/rail-view';
import { markLit, pruneLit, startBeat, URGENCY_LINGER_MS, type UrgencyMarks } from '../lib/urgency';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

// ALL of them, not just the last: a test that mounts twice would otherwise
// leave a live root behind, and this component arms a setTimeout for the lamp
// beat — so a stray timer would outlive the test that created it the day one of
// these passes a non-empty urgency map.
let roots: Root[] = [];
const noop = (): void => {};

/** Mount anything into a tracked root, so the teardown above reaches it, and
 *  hand back the way to render into that SAME root again. */
async function mountNode(node: ReactNode): Promise<{
  host: HTMLElement;
  render: (next: ReactNode) => Promise<void>;
}> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  const render = async (next: ReactNode): Promise<void> => {
    await act(async () => {
      root.render(next);
    });
  };
  await render(node);
  return { host, render };
}

/** Mount the real strip over whatever sessions and beats a test needs, and hand
 *  back the host so a test can read any lamp by card id. */
async function mountStrip(opts: {
  sessions: RailSession[];
  urgency?: UrgencyMarks;
  onExpire?: () => void;
  onBeatStart?: (cardIds: readonly string[]) => void;
}): Promise<HTMLElement> {
  const { host } = await mountNode(
    <UrgencyStrip
      sessions={opts.sessions}
      urgency={opts.urgency ?? new Map<string, number>()}
      activeCardId={opts.sessions[0]?.id ?? null}
      onFocus={noop}
      onExpire={opts.onExpire ?? noop}
      onBeatStart={opts.onBeatStart ?? noop}
    />
  );
  return host;
}

/** one session in whatever status is under test, and the lamp it produces */
async function mountLamp(status: string): Promise<HTMLElement> {
  const host = await mountStrip({ sessions: [{ id: 'c1', title: 'switchboard', status }] });
  return host.querySelector<HTMLElement>('[data-urgency-lamp]')!;
}

beforeAll(async () => {
  await initI18nForTests();
});

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  const mounted = roots;
  roots = [];
  await act(async () => {
    for (const r of mounted) r.unmount();
  });
  document.body.innerHTML = '';
});

describe('the urgency lamp hands the rules the pair they promise', () => {
  it.each(STATUS_TOKENS)('paints %s with that status’s ink, never its hue', async (token) => {
    const el = await mountLamp(token);
    expect(el.style.getPropertyValue('--lamp-ink')).toBe(`var(--status-${token}-ink)`);
    expect(el.style.getPropertyValue('--lamp-hue')).toBe(`var(--status-${token})`);
    expect(el.dataset.status).toBe(token);
  });

  it('folds the two statuses the ramp has no position for', async () => {
    // `starting` and `suspended` are real session states with no hue of their
    // own; both must still arrive as a real PAIR, or the lamp washes with an
    // undefined property and writes an undefined colour on it
    expect((await mountLamp('starting')).dataset.status).toBe(presentStatus('starting').token);
    const suspended = await mountLamp('suspended');
    expect(suspended.dataset.status).toBe('idle');
    expect(suspended.style.getPropertyValue('--lamp-ink')).toBe('var(--status-idle-ink)');
    expect(suspended.style.getPropertyValue('--lamp-hue')).toBe('var(--status-idle)');
    // suspended is not idle, and the lamp has to keep saying so — the fainter
    // dot ring is keyed off this attribute
    expect(suspended.dataset.suspended).toBe('true');
  });

  it('fails open on a status nobody has heard of', async () => {
    // §4: our blind spot reads as quiet, never as an alarm — and it is still a
    // real pair, so the lamp paints rather than resolving to nothing
    const el = await mountLamp('compacting');
    expect(el.dataset.status).toBe('idle');
    expect(el.style.getPropertyValue('--lamp-hue')).toBe('var(--status-idle)');
    expect(el.style.getPropertyValue('--lamp-ink')).toBe('var(--status-idle-ink)');
  });

  it('never writes a colour of its own — the stylesheet owns every state', async () => {
    // an inline `color` or `background` beats the :hover and state rules on
    // specificity, which is how the lamp would quietly leave the audit
    const el = await mountLamp('needs-permission');
    expect(el.style.color).toBe('');
    expect(el.style.background).toBe('');
    expect(el.style.backgroundColor).toBe('');
  });

  it('carries the session’s name, not only a colour', async () => {
    // legible before any colour is read (§5.20) — and it is what makes the lamp
    // TEXT, so its states owe 4.5:1 rather than 1.4.11's 3:1
    const el = await mountLamp('crashed');
    expect(el.querySelector('.urgency-name')?.textContent).toBe('switchboard');
  });
});

describe('the strip is the surface a lamp’s wash is measured against', () => {
  it('stays on --panel2', async () => {
    const el = await mountLamp('needs-permission');
    const strip = document.querySelector<HTMLElement>('[data-testid="urgency-strip"]')!;
    expect(strip.style.background).toBe('var(--panel2)');
    expect(strip.contains(el)).toBe(true);
  });

  it('paints nothing between itself and a lamp', async () => {
    // the lamps live in a scroller inside the strip. If that scroller ever
    // takes a background of its own, the wash sits on THAT, and `--panel2` in
    // the rules becomes a colour nobody sees through the lamp.
    const el = await mountLamp('needs-permission');
    const strip = document.querySelector<HTMLElement>('[data-testid="urgency-strip"]')!;
    for (let n = el.parentElement; n && n !== strip; n = n.parentElement) {
      expect(n.style.background, 'a layer between the strip and the lamp paints').toBe('');
      expect(n.style.backgroundColor).toBe('');
    }
  });
});

// --- #284: the lit beat, on a clock the test owns --------------------------
//
// `data-lit` was measured in exactly one place — e2e/urgency.spec.ts's "stays
// lit after a jump" — and measured there against the WALL CLOCK: the beat is
// ~1.5s and `lit` is computed from `Date.now()` at render time, so a render
// delayed past the deadline never paints it and no amount of Playwright
// retrying can observe what was never painted. The measured margin on an idle
// box was ~10x; under load it is a flake, and one that would present exactly
// like the renderer race #251 spent a forensics pass distinguishing.
//
// lib/urgency's rules are already pure and already unit-tested (urgency.test.ts
// owns `isLit` / `markLit` / `pruneLit` / `nextLitExpiry`). What had NO
// coverage at all is this component's half — that it hands the pure rule the
// clock, paints the answer, and arms the one timer that puts the lamp out — and
// that half is precisely what the e2e was standing in for. On fake timers it
// costs no wall time and cannot flake, so the e2e is left to prove only the
// wiring a unit test genuinely cannot reach.
// NOTE: the issue number stays out of the describe STRING on purpose — the
// renderer's raw-colour lint matches `#` followed by 3-8 hex digits, and `#284`
// is three of them. It reads a bug reference as a hex colour. Comments are not
// literals, so this one is fine where it is.
describe('the lit beat, on a clock the test owns (issue 284)', () => {
  /** a fixed instant; every deadline below is written relative to it, so the
   *  beat is arithmetic rather than something the test waits out */
  const T = 1_700_000_000_000;
  const two: RailSession[] = [
    { id: 'c1', title: 'alpha', status: 'idle' },
    { id: 'c2', title: 'beta', status: 'idle' },
  ];
  const litOf = (host: HTMLElement, cardId: string): string | null =>
    host.querySelector(`[data-urgency-lamp="${cardId}"]`)!.getAttribute('data-lit');

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T);
  });
  // registered after the file's unmount hook, so it runs BEFORE it: the roots
  // are torn down on real timers, the way every other test in this file does it
  afterEach(() => {
    vi.useRealTimers();
  });

  it('paints the lamp whose beat is still running, and only that one', async () => {
    const host = await mountStrip({ sessions: two, urgency: new Map([['c1', T + 1]]) });
    expect(litOf(host, 'c1')).toBe('true');
    expect(litOf(host, 'c2')).toBe('false');
  });

  it('treats a deadline of exactly now as run out', async () => {
    // `isLit` is strictly `>`, and the timer below is armed to fire 1ms PAST
    // the deadline for the same reason: the render and the timer have to agree
    // on the boundary, or a lamp can be painted lit with no timer left to put
    // it out
    const host = await mountStrip({ sessions: two, urgency: new Map([['c1', T]]) });
    expect(litOf(host, 'c1')).toBe('false');
  });

  it('asks the OS for nothing when no lamp is lit', async () => {
    // the strip promises a single timer armed at a deadline rather than a poll,
    // and most of a session has no lit lamp at all
    await mountStrip({ sessions: two });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('arms ONE timer, at the soonest deadline, and fires only past it', async () => {
    const onExpire = vi.fn();
    await mountStrip({
      sessions: two,
      urgency: new Map([
        ['c1', T + URGENCY_LINGER_MS],
        ['c2', T + 400],
      ]),
      onExpire,
    });
    expect(vi.getTimerCount(), 'one timer for the whole strip, not one per lamp').toBe(1);

    await act(async () => void vi.advanceTimersByTime(400));
    expect(onExpire, 'firing ON the deadline would prune nothing').not.toHaveBeenCalled();

    await act(async () => void vi.advanceTimersByTime(1));
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it('re-arms when the prune changes nothing, instead of leaving a lamp lit forever', async () => {
    // The clock-skew branch the effect documents and nothing measured: the
    // deadlines are WALL clock and setTimeout counts on a monotonic one, so a
    // step backwards fires the timer early, prunes nothing, publishes nothing —
    // and a strip that armed once would have no timer left. `onExpire` here is
    // the honest stand-in for that: it is called, and it changes nothing.
    const onExpire = vi.fn();
    await mountStrip({ sessions: two, urgency: new Map([['c1', T + 100]]), onExpire });

    await act(async () => void vi.advanceTimersByTime(101));
    expect(onExpire).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount(), 'the chain must not end with the lamp still lit').toBe(1);

    // the re-arm floor is 20ms, so the retry costs a wakeup per 21ms rather
    // than a 1ms spin, and it keeps retrying until the wall clock catches up
    await act(async () => void vi.advanceTimersByTime(21));
    expect(onExpire).toHaveBeenCalledTimes(2);
  });
});

// --- the beat runs from the PAINT (issue 320, Dan 2026-08-10) ---------------
//
// The keypress used to stamp `now + 1500` and every render compared it against
// a fresh clock, so a machine busy enough to take longer than a beat between
// the keydown and the paint drew NO LIT LAMP AT ALL — not late, never. §5.8
// asks for the beat so a human can see which session called them, which makes
// "the pixels existed" the only start that means anything.
//
// A mark now arrives with no deadline (`null`) and the strip starts the beat
// from the frame AFTER the one that paints it. These tests own that seam: that
// an unpainted mark is lit and expires on nothing, that the commit is not
// treated as the paint, and that a stalled paint delays the beat instead of
// eating it.
describe('the beat starts at the paint, not the keypress (issue 320)', () => {
  const T = 1_700_000_000_000;
  const two: RailSession[] = [
    { id: 'c1', title: 'alpha', status: 'idle' },
    { id: 'c2', title: 'beta', status: 'idle' },
  ];
  const litOf = (host: HTMLElement, cardId: string): string | null =>
    host.querySelector(`[data-urgency-lamp="${cardId}"]`)!.getAttribute('data-lit');

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('paints a mark that has no deadline yet, and arms nothing to take it away', async () => {
    const onExpire = vi.fn();
    const host = await mountStrip({
      sessions: two,
      urgency: new Map([['c1', null]]),
      onExpire,
    });
    expect(litOf(host, 'c1')).toBe('true');
    expect(litOf(host, 'c2')).toBe('false');
    // ten beats of clock, and nothing puts it out: an unpainted mark is waiting
    // on a frame, not on a deadline
    await act(async () => void vi.advanceTimersByTime(10 * URGENCY_LINGER_MS));
    expect(onExpire).not.toHaveBeenCalled();
    expect(litOf(host, 'c1')).toBe('true');
  });

  it('does not treat the COMMIT as the paint — it waits a frame past it', async () => {
    // The distinction the whole fix rests on. A layout effect runs after the
    // DOM is mutated and before the browser paints, and the first rAF callback
    // runs before ITS frame's pixels too; only the second is past a paint.
    const onBeatStart = vi.fn();
    await mountStrip({ sessions: two, urgency: new Map([['c1', null]]), onBeatStart });
    expect(onBeatStart, 'the DOM is mutated, the pixels are not up').not.toHaveBeenCalled();

    await act(async () => void vi.advanceTimersToNextTimer());
    expect(onBeatStart, 'a frame callback still runs BEFORE that frame paints').not.toHaveBeenCalled();

    await act(async () => void vi.advanceTimersToNextTimer());
    expect(onBeatStart).toHaveBeenCalledTimes(1);
    expect(onBeatStart).toHaveBeenCalledWith(['c1']);
  });

  it('offers up only the marks that are waiting, never one already counting down', async () => {
    // (that a beat already running is left ALONE is startBeat's rule, and
    // urgency.test.ts owns it — this is the half that decides what it is asked
    // about in the first place)
    const onBeatStart = vi.fn();
    await mountStrip({
      sessions: two,
      urgency: new Map([
        ['c1', null],
        ['c2', T + URGENCY_LINGER_MS],
      ]),
      onBeatStart,
    });
    await act(async () => void vi.advanceTimersByTime(64));
    expect(onBeatStart).toHaveBeenCalledTimes(1);
    expect(onBeatStart).toHaveBeenCalledWith(['c1']); // not c2, which is counting down
  });

  it('asks for no frame at all when nothing is waiting on one', async () => {
    // literally no frame, not merely no call: most renders of this strip have
    // nothing pending, and a rAF per render is a wakeup per render forever
    const raf = vi.spyOn(globalThis, 'requestAnimationFrame');
    const onBeatStart = vi.fn();
    await mountStrip({ sessions: two, urgency: new Map([['c1', T + 500]]), onBeatStart });
    expect(raf).not.toHaveBeenCalled();
    await act(async () => void vi.advanceTimersByTime(64));
    expect(onBeatStart).not.toHaveBeenCalled();
    raf.mockRestore();
  });

  it('fails open when there is no rAF to anchor to', async () => {
    // §4: our blind spot must not become a lamp that is lit forever. With no
    // paint signal at all, a beat that starts a frame early beats one that
    // never starts.
    vi.stubGlobal('requestAnimationFrame', undefined);
    try {
      const onBeatStart = vi.fn();
      await mountStrip({ sessions: two, urgency: new Map([['c1', null]]), onBeatStart });
      expect(onBeatStart).toHaveBeenCalledWith(['c1']);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('a jump key held down cannot starve the beat', async () => {
    // Every repeat writes a new urgency map. A chain that cancelled and
    // rescheduled itself on each one would be killed one frame short of firing,
    // every time, for as long as the key was down — Windows auto-repeat is
    // ~33ms and two frames at 60Hz is 32 — and every lamp would sit lit with no
    // beat ever started. So an in-flight chain is left to land.
    const onBeatStart = vi.fn();
    const held = (): ReactElement => (
      <UrgencyStrip
        sessions={two}
        urgency={new Map([['c1', null]])} // a NEW map each time, as a repeat makes
        activeCardId={null}
        onFocus={noop}
        onExpire={noop}
        onBeatStart={onBeatStart}
      />
    );
    const { render } = await mountNode(held());
    for (let repeat = 0; repeat < 6 && !onBeatStart.mock.calls.length; repeat += 1) {
      await act(async () => void vi.advanceTimersToNextTimer()); // one frame passes
      await render(held()); // ...and the key repeats under it
    }
    expect(onBeatStart).toHaveBeenCalledWith(['c1']);
  });

  it('a stalled paint DELAYS the beat instead of eating it', async () => {
    // The bug, end to end, with the store's own two rules standing in for the
    // store (which unit-tests them itself). The jump marks the lamp at T; the
    // machine is busy for a minute; the user still gets a whole beat of lit
    // lamp, starting from the frame they could first have seen it.
    const { host } = await mountNode(<Harness sessions={two} initial={new Map([['c1', null]])} />);
    expect(litOf(host, 'c1')).toBe('true');

    vi.setSystemTime(T + 60_000); // forty beats of stall between keydown and frame
    await act(async () => void vi.advanceTimersByTime(64)); // ...and then the paint
    expect(litOf(host, 'c1'), 'the beat cannot have expired before it started').toBe('true');

    await act(async () => void vi.advanceTimersByTime(URGENCY_LINGER_MS - 100));
    expect(litOf(host, 'c1'), 'a WHOLE beat, measured from the paint').toBe('true');

    await act(async () => void vi.advanceTimersByTime(200));
    expect(litOf(host, 'c1'), 'and it still ends by itself').toBe('false');
  });
});

// --- the pending cap: one mark waiting, the latest (issue 426) --------------
//
// Anchoring the beat to the paint (issue 320) made a jump QUEUE a mark that
// only a paint drains. `Ctrl+Space` routes through the main renderer while
// focus raises a POPOUT, so an operator working across popouts leaves the main
// window occluded and unpainted for jump after jump — and every queued ring
// used to fire at once on return, all of them stale. `markLit` now keeps only
// the newest unpainted mark.
//
// lib/urgency owns that rule; what is decided HERE is the half the rule can
// only break through this component — that a chain already in the air when a
// mark is superseded still leaves the survivor with a beat that ends.
describe('several jumps with nothing painting light exactly one lamp (issue 426)', () => {
  const T = 1_700_000_000_000;
  const three: RailSession[] = [
    { id: 'c1', title: 'alpha', status: 'idle' },
    { id: 'c2', title: 'beta', status: 'idle' },
    { id: 'c3', title: 'gamma', status: 'idle' },
  ];
  const litOf = (host: HTMLElement, cardId: string): string | null =>
    host.querySelector(`[data-urgency-lamp="${cardId}"]`)!.getAttribute('data-lit');
  const lampsLit = (host: HTMLElement): string[] =>
    [...host.querySelectorAll<HTMLElement>('[data-urgency-lamp]')]
      .filter((el) => el.dataset.lit === 'true')
      .map((el) => el.dataset.urgencyLamp!);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** mount the harness and hand back the host plus the jump */
  const mountJumpable = async (): Promise<{
    host: HTMLElement;
    jump: (cardId: string) => void;
  }> => {
    const jumpRef: { current: ((cardId: string) => void) | null } = { current: null };
    const { host } = await mountNode(
      <Harness sessions={three} initial={new Map<string, number | null>()} jumpRef={jumpRef} />
    );
    return { host, jump: (cardId) => jumpRef.current!(cardId) };
  };

  it('the fireworks: three jumps, no frames, ONE ring on return', async () => {
    const { host, jump } = await mountJumpable();
    // the window is occluded behind a popout: renders happen, frames do not
    await act(async () => {
      jump('c1');
      jump('c2');
      jump('c3');
    });
    expect(lampsLit(host), 'only the last landing answers "where am I?"').toEqual(['c3']);

    // ...and now the operator comes back and the window paints
    await act(async () => void vi.advanceTimersByTime(64));
    expect(lampsLit(host), 'one ring, not three at once').toEqual(['c3']);

    // that ring is a real beat, on the clock, and it ends
    await act(async () => void vi.advanceTimersByTime(URGENCY_LINGER_MS + 500));
    expect(lampsLit(host)).toEqual([]);
  });

  it('a mark superseded UNDER a chain in flight still gets a beat that ends', async () => {
    // The regression this cap is one line away from causing. The chain captures
    // the ids as of the commit that scheduled it; the cap can delete them
    // before the second frame arrives, and then `startBeat` has nothing to
    // start and writes NOTHING — so a strip that waited on that write to re-run
    // its effect would never schedule a chain for the mark that replaced them.
    // No beat, and `nextLitExpiry` arms no timer for the unpainted: lit forever.
    const { host, jump } = await mountJumpable();
    await act(async () => void jump('c1'));
    await act(async () => void vi.advanceTimersToNextTimer()); // one frame: chain half-way
    await act(async () => void jump('c2')); // ...and c1 is superseded under it
    expect(litOf(host, 'c1')).toBe('false');
    expect(litOf(host, 'c2')).toBe('true');

    await act(async () => void vi.advanceTimersByTime(64)); // the chain lands on nothing
    expect(litOf(host, 'c2'), 'still lit — its own chain has to reach it').toBe('true');

    await act(async () => void vi.advanceTimersByTime(URGENCY_LINGER_MS + 500));
    expect(litOf(host, 'c2'), 'a beat that never started is a lamp lit forever').toBe('false');
  });

  it('a ring you have already SEEN is not taken away by the next jump', async () => {
    // the other half of the rule, through the component: the cap is scoped to
    // marks nobody has painted. Two rings overlap exactly as they always did.
    const { host, jump } = await mountJumpable();
    await act(async () => void jump('c1'));
    await act(async () => void vi.advanceTimersByTime(64)); // c1 paints, its beat starts
    await act(async () => void jump('c2'));
    expect(lampsLit(host), 'both up together').toEqual(['c1', 'c2']);
  });
});

/** The strip wired to the THREE rules the store applies to its answers — the
 *  same `markLit` / `startBeat` / `pruneLit` calls `markUrgency`,
 *  `startUrgencyBeat` and `expireUrgency` make, so a test can watch a mark go
 *  jumped-to -> pending -> lit -> out without a store. */
function Harness(props: {
  sessions: RailSession[];
  initial: UrgencyMarks;
  /** filled with the jump `markUrgency` makes, for a test to press */
  jumpRef?: { current: ((cardId: string) => void) | null };
}): ReactElement {
  const [urgency, setUrgency] = useState(props.initial);
  const onBeatStart = useCallback((cardIds: readonly string[]) => {
    setUrgency((cur) => startBeat(cur, cardIds, Date.now()) ?? cur);
  }, []);
  const onExpire = useCallback(() => {
    setUrgency((cur) => pruneLit(cur, Date.now()) ?? cur);
  }, []);
  const jump = useCallback((cardId: string) => {
    setUrgency((cur) => markLit(cur, cardId, Date.now()));
  }, []);
  const { jumpRef } = props;
  useEffect(() => {
    if (jumpRef) jumpRef.current = jump;
  }, [jumpRef, jump]);
  return (
    <UrgencyStrip
      sessions={props.sessions}
      urgency={urgency}
      activeCardId={null}
      onFocus={noop}
      onExpire={onExpire}
      onBeatStart={onBeatStart}
    />
  );
}
