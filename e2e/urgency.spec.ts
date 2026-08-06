// P2-E9-04 — the urgency strip and its delayed urgency reset (§5.8).
//
// Driven through the REAL hook listener, exactly as attention.spec.ts does: the
// test plays the CLI's part (Notification / Stop POSTs with each session's own
// token), so what the lamps show is the real status machine and not a mock.
//
// The four things the item promises, one test each: the strip reflects live
// status for every session (suspended included), a click focuses, the lamp you
// jumped to lingers and then goes out, and the strip survives every layout
// state the app has.
import { test, expect, Page } from '@playwright/test';
import path from 'path';
import { launchApp, LaunchedApp, showTerminal, tempProjectFolder, hookPoster } from './fixtures/app';
// the ramp itself, not a copy of it (the csp spec sets the precedent for
// importing from src/): a seventh status must be measured by #267's audit
// below without anybody remembering to add it here
import { STATUS_TOKENS } from '../src/renderer/src/lib/rail-view';

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

const strip = (w: Page) => w.getByTestId('urgency-strip');
const lamps = (w: Page) => strip(w).locator('[data-urgency-lamp]');
const lamp = (w: Page, title: string) => strip(w).locator(`[data-urgency-lamp][title^="${title}"]`);
const activeTab = (w: Page) => w.locator('.dv-active-tab');
const tabs = (w: Page) => w.locator('.dv-tabs-container .dv-tab');

/** Popouts need a real window manager; CI's Linux runner is headless-xvfb and
 *  the popped-out BrowserWindow never materialises there (see #112 / E8 specs). */
function skipPopoutOnLinux(): void {
  test.skip(process.platform === 'linux', 'popout windows are unreliable under xvfb');
}

/** where the freeze below parks the real clock while it is stopped */
interface ClockStash {
  __realDateNow?: () => number;
}

/**
 * Run `body` with the RENDERER's wall clock STOPPED (#284).
 *
 * The urgency lamp's `data-lit` is a ~1.5s transient computed from `Date.now()`
 * at RENDER time: `markUrgency` stamps `now + URGENCY_LINGER_MS` and the render
 * compares the map against a fresh reading. A render delayed past that deadline
 * therefore never paints the lamp lit AT ALL, and no amount of Playwright
 * retrying can observe a state that was never painted — an assertion whose
 * budget is wall-clock rather than the deadline every other `expect` here gets.
 * Measured margin on an idle box is ~10x; under three parallel e2e workers it
 * is a flake, and one that would present exactly like the renderer race #251
 * spent a forensics pass distinguishing. This makes the beat last as long as
 * the block does.
 *
 * With the clock stopped, `markUrgency` stamps `frozen + 1500` and every render
 * reads the same `frozen`, so the lamp is unconditionally lit — and the expiry
 * timer, which runs on the REAL monotonic clock, prunes nothing when it fires
 * (`frozen + 1500 > frozen`) and re-arms instead of ending the chain. So the
 * attribute is stable for as long as we need rather than merely likely.
 *
 * Nothing about the jump is faked: the keypress, the queue, the store write,
 * the component and the paint are all the shipped article — only the reading of
 * the clock they consult is pinned, and only for the length of this block. It
 * is the renderer's OWN `Date.now` (`page.evaluate` runs in the page's main
 * world), and the only other renderer code that reads it is FeedView's
 * scroll-gesture heuristic, which this spec never touches.
 */
async function withStoppedClock(w: Page, body: () => Promise<void>): Promise<void> {
  await w.evaluate(() => {
    const stash = window as unknown as ClockStash;
    const real = Date.now;
    stash.__realDateNow = real;
    const frozen = real();
    Date.now = () => frozen;
  });
  try {
    await body();
  } finally {
    // Always, so a failed assertion inside the block cannot leave the page's
    // clock stopped for whatever the test does afterwards — and NEVER throwing,
    // for the same reason killTree doesn't: this runs on the failure path, and
    // an evaluate against a page that has closed or crashed would replace the
    // assertion error that actually explains the failure with "Target page
    // closed". Restoring is best-effort; the app is torn down per-test anyway.
    try {
      await w.evaluate(() => {
        const stash = window as unknown as ClockStash;
        if (stash.__realDateNow) Date.now = stash.__realDateNow;
        delete stash.__realDateNow;
      });
    } catch {
      /* the page is gone; its clock went with it */
    }
  }
}

/** open one more session, in its own folder (so nothing auto-groups) */
async function addSession(a: LaunchedApp): Promise<string> {
  const dir = tempProjectFolder();
  await a.app.evaluate(({ dialog }, d) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [d] });
  }, dir);
  await a.window.getByRole('button', { name: '+ session' }).click();
  const name = path.basename(dir);
  await expect(lamp(a.window, name)).toBeVisible({ timeout: 25_000 });
  return name;
}

test.describe('urgency strip (E9-04)', () => {
  let a: LaunchedApp;
  test.afterEach(async () => a?.cleanup());

  test('one lamp per session, colored by LIVE status', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    const first = path.basename(folder);
    await expect(lamp(w, first)).toBeVisible({ timeout: 25_000 });

    const second = await addSession(a);
    await expect(lamps(w)).toHaveCount(2);

    // a calm session is calm: no attention treatment until something asks
    await expect(lamp(w, first)).toHaveAttribute('data-needs-you', 'false');

    const post = await hookPoster(a, 2);
    await post(first, {
      hook_event_name: 'Notification',
      message: 'Claude needs your permission to use Bash',
    });
    await expect(lamp(w, first)).toHaveAttribute('data-status', 'needs-permission', {
      timeout: 15_000,
    });
    await expect(lamp(w, first)).toHaveAttribute('data-needs-you', 'true');
    // and ONLY that one — the strip is a readout, not an alarm for everybody
    await expect(lamp(w, second)).toHaveAttribute('data-needs-you', 'false');
    await expect(w.getByTestId('urgency-count')).toHaveAttribute('data-needing', '1');

    // answering it takes the lamp back down, live
    await post(first, { hook_event_name: 'UserPromptSubmit' });
    await expect(lamp(w, first)).toHaveAttribute('data-needs-you', 'false', { timeout: 15_000 });
    await expect(w.getByTestId('urgency-count')).toHaveAttribute('data-needing', '0');
  });

  test('clicking a lamp focuses that session', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    const first = path.basename(folder);
    await expect(lamp(w, first)).toBeVisible({ timeout: 25_000 });
    const second = await addSession(a);
    await expect(activeTab(w)).toContainText(second); // the new card took focus

    await lamp(w, first).click();
    await expect(activeTab(w)).toContainText(first);
    // the strip marks where you are, so it doubles as a "you are here"
    await expect(lamp(w, first)).toHaveAttribute('data-active', 'true');
    await expect(lamp(w, second)).toHaveAttribute('data-active', 'false');

    await lamp(w, second).click();
    await expect(activeTab(w)).toContainText(second);
  });

  test('the arrived-at lamp stays lit after a jump, then goes out on its own', async () => {
    const folders = [tempProjectFolder(), tempProjectFolder()];
    a = await launchApp({ seedFolder: folders[0] });
    const w = a.window;
    const names = folders.map((f) => path.basename(f));
    await expect(lamp(w, names[0])).toBeVisible({ timeout: 25_000 });
    await a.app.evaluate(({ dialog }, d) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [d] });
    }, folders[1]);
    await w.getByRole('button', { name: '+ session' }).click();
    await expect(lamps(w)).toHaveCount(2, { timeout: 25_000 });

    const post = await hookPoster(a, 2);
    await post(names[1], {
      hook_event_name: 'Notification',
      message: 'Claude needs your permission to use Bash',
    });
    await expect(lamp(w, names[1])).toHaveAttribute('data-status', 'needs-permission', {
      timeout: 15_000,
    });

    // stand somewhere else, then let the queue send us
    await w.keyboard.press(`${MOD}+1`);
    await expect(activeTab(w)).toContainText(names[0]);
    await expect(lamp(w, names[1])).toHaveAttribute('data-lit', 'false');

    // The jump and everything it lights up, with the page's clock stopped, so
    // the beat cannot expire out from under the assertions (#284 — see
    // withStoppedClock). These three used to be racing a 1.5s wall clock, which
    // is why the lit one had to go first; the order is kept because it still
    // reads best, but nothing now depends on it.
    await withStoppedClock(w, async () => {
      await w.keyboard.press(`${MOD}+Space`);
      await expect(lamp(w, names[1])).toHaveAttribute('data-lit', 'true');
      // ...and only the one you were sent to
      await expect(lamp(w, names[0])).toHaveAttribute('data-lit', 'false');
      // the jump did land where the lamp says it did
      await expect(activeTab(w)).toContainText(names[1]);
    });

    // Clock running again: it puts itself out — no click, no second key, just
    // the beat passing. This is now a transition that was WATCHED rather than
    // merely found: the assertion above proved the lamp was lit, so a lamp that
    // never lit can no longer satisfy this one on arrival.
    await expect(lamp(w, names[1])).toHaveAttribute('data-lit', 'false', { timeout: 6_000 });
    // the status itself is untouched by the beat: it is still blocked
    await expect(lamp(w, names[1])).toHaveAttribute('data-status', 'needs-permission');
  });

  test('the strip stays visible in every layout state the app has', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    const title = path.basename(folder);
    await expect(lamp(w, title)).toBeVisible({ timeout: 25_000 });

    // rail hidden (Mod+B) — the rail is the OTHER place every session is listed
    await w.keyboard.press(`${MOD}+B`);
    await expect(w.locator('nav')).toHaveCount(0);
    await expect(strip(w)).toBeVisible();
    await expect(lamp(w, title)).toBeVisible();
    await w.keyboard.press(`${MOD}+B`);
    await expect(w.locator('nav')).toHaveCount(1);

    // the card showing its Terminal instead of the Session view
    await showTerminal(w);
    await expect(w.locator('.xterm-screen').first()).toBeVisible({ timeout: 15_000 });
    await expect(strip(w)).toBeVisible();

    // the card taken OUT of the workspace entirely (§5.8's ladder): "the
    // session lives on in the rail, its lamp, and the events list" — so this is
    // the state that would break a strip drawn by the grid
    await w.keyboard.press(`${MOD}+Shift+P`);
    await w.getByPlaceholder('Type a command or a session name…').fill('hide session');
    await w.keyboard.press('Enter');
    await expect(tabs(w)).toHaveCount(0);
    await expect(strip(w)).toBeVisible();
    await expect(lamp(w, title)).toBeVisible();

    // and the lamp is a reveal trigger like any other click
    await lamp(w, title).click();
    await expect(tabs(w)).toHaveCount(1);
  });

  test('a SUSPENDED session keeps its lamp', async () => {
    skipPopoutOnLinux();
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const { app, window: w } = a;
    const title = path.basename(folder);
    await expect(lamp(w, title)).toBeVisible({ timeout: 25_000 });

    // pop out, then close the OS window: the card docks back SUSPENDED (E8-04)
    await w.getByTitle('Pop out into its own window').click();
    await expect.poll(() => app.windows().length, { timeout: 15_000 }).toBe(2);
    const popout = app.windows().find((x) => x !== w)!;
    await popout.evaluate(() => window.close());
    await expect.poll(() => app.windows().length, { timeout: 15_000 }).toBe(1);
    await expect(w.getByText('Session suspended')).toBeVisible({ timeout: 15_000 });

    // still one lamp, flagged suspended rather than silently reading "idle"
    await expect(lamps(w)).toHaveCount(1);
    await expect(lamp(w, title)).toHaveAttribute('data-suspended', 'true', { timeout: 15_000 });
    await expect(lamp(w, title)).toHaveAttribute('data-needs-you', 'false');
    await expect(lamp(w, title)).toHaveAttribute('title', `${title} — suspended`);
    // the rail says the same thing about the same session: both read one
    // `sessions:cards` list through one presentStatus, and this is the
    // assertion that would catch them drifting apart
    await expect(
      w.locator('nav [draggable="true"]', { hasText: title }).first()
    ).toHaveAttribute('data-session-status', 'idle');
  });

  // #170 — the post-Resume half of the test above, which E9-04 deliberately
  // left out because it did not pass: resuming produced no status CHANGE, so
  // nothing refreshed the one `sessions:cards` list both of these read, and the
  // card went on calling itself suspended indefinitely. The fake provider is
  // the honest case — it posts no hooks, so nothing else comes along to refresh
  // the list by accident, exactly like a real PTY session nobody has prompted.
  test('resuming a suspended session refreshes the rail AND the strip (#170)', async () => {
    skipPopoutOnLinux();
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const { app, window: w } = a;
    const title = path.basename(folder);
    const row = w.locator('nav [draggable="true"]', { hasText: title }).first();
    await expect(lamp(w, title)).toBeVisible({ timeout: 25_000 });

    // suspend it the way a user does: pop out, close the OS window (E8-04)
    await w.getByTitle('Pop out into its own window').click();
    await expect.poll(() => app.windows().length, { timeout: 15_000 }).toBe(2);
    const popout = app.windows().find((x) => x !== w)!;
    await popout.evaluate(() => window.close());
    await expect.poll(() => app.windows().length, { timeout: 15_000 }).toBe(1);
    await expect(lamp(w, title)).toHaveAttribute('data-suspended', 'true', { timeout: 15_000 });
    await expect(row).toContainText('suspended', { timeout: 15_000 });

    // ONE click, on the card's own Resume — and then nothing else. No refresh,
    // no navigation, no second interaction: whatever moves next moved by
    // itself, which is the entire done-when.
    await w.getByRole('button', { name: 'Resume' }).click();

    // both surfaces, because the bug was in neither of them: they read one
    // list, and the list was what went stale
    await expect(lamp(w, title)).toHaveAttribute('data-suspended', 'false', { timeout: 20_000 });
    await expect(row).not.toContainText('suspended');
  });

  // --- #267: the lamp's contrast, as Chromium actually paints it -------------
  //
  // tokens.drift.test.ts computes these ratios from the files. This is the half
  // only a real window can settle, and it matters more here than anywhere else
  // the tokens are checked: four of the lamp's states paint a `color-mix` of a
  // status hue into the strip, so the colour behind the word exists nowhere as
  // a token — and WHICH rule supplies the ink is a cascade across five rules,
  // which is exactly what shipped wrong. The lit state's colour was never
  // written by the lit rule; it fell through to the base rule's `--muted`,
  // 2.77:1 on nordic under the pointer.
  //
  // The states are driven by FLIPPING THE ATTRIBUTES ON THE REAL LAMP rather
  // than by producing each one for real. That is deliberate, and it is the
  // honest choice here: `data-lit` is a ~1.5s transient (URGENCY_LINGER_MS), so
  // reaching it four times per theme would be a wall-clock race — the shape of
  // #284 — and would be testing the timer rather than the paint. Everything
  // that decides a colour is still the shipped article: the real element, the
  // real class, the real inline pair the component gave it, the real
  // stylesheet, the real strip underneath, and a real pointer for the hover
  // states. Only the three booleans are ours, and the first assertion below
  // fails if the pair the component hands a lamp ever stops matching the status
  // it says it is in.
  test('every lamp state is legible in every theme, as painted (#267)', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    const title = path.basename(folder);
    const el = lamp(w, title);
    await expect(el).toBeVisible({ timeout: 25_000 });

    const walk = { statuses: [...STATUS_TOKENS], states: LAMP_STATES };
    for (const [label, id] of THEMES) {
      await w.getByRole('button', { name: label, exact: true }).click();
      await expect(w.locator('html')).toHaveAttribute('data-theme-id', id);

      // no pointer on the lamp — the theme button just took it
      const off = await el.evaluate(auditLampStates, walk);
      assertLamp(id, 'off the pointer', off, false);

      await el.hover();
      const under = await el.evaluate(auditLampStates, walk);
      assertLamp(id, 'under the pointer', under, true);

      // the pointer really DEEPENS a signalling lamp, which only a comparison
      // ACROSS the two passes can say. Comparing two states inside one pass
      // (the first cut of this) passes with the whole hover rule deleted.
      expect(
        under.states['needs-input needs you'].bg,
        `${id}: the pointer must deepen a signalling lamp's wash`
      ).not.toBe(off.states['needs-input needs you'].bg);
    }
  });
});

/** [picker label, the id it paints] — the shipped set, as a user meets it.
 *  NOTE: this, `lum()` and the opaque-ancestor walk below are duplicated from
 *  e2e/theme.spec.ts, deliberately and temporarily — #246 (PR #265) is rewriting
 *  that file's copies right now, and extracting a shared fixture from under it
 *  would be a merge conflict for no behavioural gain. Extract them the moment
 *  #265 lands; they are the load-bearing measurement primitives and two copies
 *  of a luminance function is exactly how one audit quietly stops measuring. */
const THEMES: Array<[string, string]> = [
  ['nordic', 'nordic'],
  ['daylight', 'daylight'],
  ['high contrast', 'high-contrast'],
  ['soft contrast', 'soft-contrast'],
];

/** the three booleans tokens.css keys the lamp's colour off, and every state
 *  they make. `data-suspended` is not one of them: it moves the DOT's ring and
 *  nothing a word sits on.
 *
 *  All EIGHT combinations, not the five that look interesting: `[data-active]`
 *  and the wash rule both write a `color`, both at (0,2,0), so which one a lamp
 *  that is here AND signalling gets is decided by nothing but their order in
 *  the file — and "arrived at a session that needs you" is what every jump
 *  produces (App.tsx's jumpToNextAttention focuses AND marks urgency). */
type LampState = [state: string, needsYou: boolean, lit: boolean, active: boolean];
const LAMP_STATES: LampState[] = [
  ['at rest', false, false, false],
  ['"you are here"', false, false, true],
  ['needs you', true, false, false],
  ['lit', false, true, false],
  ['needs you, and lit', true, true, false],
  ['needs you, and "you are here"', true, false, true],
  ['lit, and "you are here"', false, true, true],
  ['needs you, lit, and "you are here"', true, true, true],
];

interface LampSeen {
  /** what supplied the colour behind the word: the lamp's own fill, or the
   *  first opaque thing above it */
  from: string;
  bg: string;
  /** the ring — `border-color`, the whole of the lit signal since #267 */
  ring: string;
  /** the word's own colour, which the ring is supposed to match */
  ink: string;
  ratio: number;
}

interface LampWalk {
  /** what the COMPONENT gave this lamp, before the walk touched anything */
  pair: { status: string; hue: string; ink: string };
  /** `<status> <state>` -> what Chromium painted for it */
  states: Record<string, LampSeen>;
}

/**
 * Runs IN THE PAGE. Walks the lamp through every (status × state) pair and
 * reports what Chromium painted, restoring the element before it returns — the
 * whole walk is one synchronous task, so React never observes the mutation.
 */
function auditLampStates(
  el: SVGElement | HTMLElement,
  walk: { statuses: string[]; states: LampState[] }
): LampWalk {
  const lum = (c: string): number => {
    // rgb()/rgba() come back 0-255; anything that went through color-mix()
    // arrives as color(srgb r g b) in 0-1 floats, and reading the second as
    // 0-255 scores every mixed colour as black — a false PASS for dark ink,
    // which is every state this test exists for.
    const n = c
      .match(/[\d.]+/g)!
      .slice(0, 3)
      .map(Number);
    const [r, g, b] = c.startsWith('color(') ? n : n.map((v) => v / 255);
    const f = (s: number): number => (s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const word = el.querySelector<HTMLElement>('.urgency-name')!;
  const restore = {
    needs: el.getAttribute('data-needs-you'),
    lit: el.getAttribute('data-lit'),
    active: el.getAttribute('data-active'),
    hue: el.style.getPropertyValue('--lamp-hue'),
    ink: el.style.getPropertyValue('--lamp-ink'),
    transition: el.style.transition,
  };
  const out: LampWalk = {
    // the pair the COMPONENT gave this lamp, read before anything below touches
    // it: every measurement after this substitutes the same two names for
    // another ramp position, so this is what ties them to the shipped
    // convention rather than to a naming rule spelled in a test
    pair: { status: el.getAttribute('data-status') ?? '', hue: restore.hue, ink: restore.ink },
    states: {},
  };

  try {
    // The lamp cross-fades its background over 0.11s and its border over 0.35s.
    // Every state below is entered and read in the same task, so without this
    // the computed values are one frame of an interpolation between the state
    // before and the state asked for — a colour that exists for a fraction of a
    // second and is nobody's promise. What is audited is where a state SETTLES.
    // (Suppressed rather than waited out: waiting would be eight states × six
    // statuses × two pointer positions × four themes of 350ms, and it would
    // make this test a clock again — the thing the comment above says it must
    // not be.)
    el.style.transition = 'none';

    for (const status of walk.statuses) {
      el.style.setProperty('--lamp-hue', `var(--status-${status})`);
      el.style.setProperty('--lamp-ink', `var(--status-${status}-ink)`);
      for (const [state, needsYou, lit, active] of walk.states) {
        el.setAttribute('data-needs-you', String(needsYou));
        el.setAttribute('data-lit', String(lit));
        el.setAttribute('data-active', String(active));

        // the first OPAQUE background at or above the word. A wash mixed into
        // var(--panel2) is itself opaque, so any state that fills stops on the
        // lamp — reported back, because a walk that had to climb to the strip
        // would mean the rule stopped matching and the ratio below would be
        // scoring the rest state over and over.
        let from = 'nothing';
        let bg = 'rgb(255, 255, 255)';
        for (let n: Element | null = el; n; n = n.parentElement) {
          const c = getComputedStyle(n).backgroundColor;
          const parts = c.match(/[\d.]+/g);
          if (parts && (parts.length < 4 || Number(parts[3]) >= 0.99)) {
            bg = c;
            from = n === el ? 'lamp' : (n.getAttribute('data-testid') ?? 'ancestor');
            break;
          }
        }
        const written = getComputedStyle(word).color;
        const [ink, fill] = [lum(written), lum(bg)];
        out.states[`${status} ${state}`] = {
          from,
          bg,
          ring: getComputedStyle(el).borderColor,
          ink: written,
          ratio: (Math.max(ink, fill) + 0.05) / (Math.min(ink, fill) + 0.05),
        };
      }
    }
  } finally {
    for (const [name, value] of [
      ['data-needs-you', restore.needs],
      ['data-lit', restore.lit],
      ['data-active', restore.active],
    ] as const) {
      if (value === null) el.removeAttribute(name);
      else el.setAttribute(name, value);
    }
    el.style.setProperty('--lamp-hue', restore.hue);
    el.style.setProperty('--lamp-ink', restore.ink);
    el.style.transition = restore.transition;
  }
  return out;
}

/** the verdicts, out here where a failure can name the theme and the state */
function assertLamp(id: string, pointer: string, walk: LampWalk, hovering: boolean): void {
  const { pair, states } = walk;
  expect(
    `${pair.hue} / ${pair.ink}`,
    `${id}: the component must hand a lamp its own status's pair`
  ).toBe(`var(--status-${pair.status}) / var(--status-${pair.status}-ink)`);

  for (const status of STATUS_TOKENS) {
    for (const [state, needsYou, lit, active] of LAMP_STATES) {
      const s = states[`${status} ${state}`];
      // a filled state must be measured against its OWN fill. Off the pointer
      // and carrying nothing, the lamp is deliberately unfilled, so the strip
      // is the right answer there and nowhere else.
      const filled = hovering || needsYou || lit || active;
      expect(s.from, `${id}, ${pointer}: ${status} ${state} — what is behind the word`).toBe(
        filled ? 'lamp' : 'urgency-strip'
      );
      expect(s.ratio, `${id}, ${pointer}: ${status} ${state} on ${s.bg}`).toBeGreaterThanOrEqual(
        4.5
      );
    }
  }

  // and the states are really different paints — otherwise a rule that quietly
  // stopped matching would score the same passing colour eight times
  const seen = (state: string): LampSeen => states[`needs-input ${state}`];
  expect(seen('needs you').bg, `${id}, ${pointer}: a signalling lamp must wash its hue`).not.toBe(
    seen('at rest').bg
  );
  expect(seen('lit').bg, `${id}, ${pointer}: lit is a signal too, and the same wash`).toBe(
    seen('needs you').bg
  );
  // the wash is the same, so the RING is the whole of "you were just sent
  // here". If it ever stops being drawn, or goes back to a colour the lit lamp
  // shares with its neighbours, this is the only thing that says so.
  expect(seen('lit').ring, `${id}, ${pointer}: the lit ring must be the lit signal`).not.toBe(
    seen('needs you').ring
  );
  // ...and it is the ink, so it is the colour of the word it rings
  expect(seen('lit').ring, `${id}, ${pointer}: the ring is drawn in the lamp's ink`).toBe(
    seen('lit').ink
  );

  // Being where you are must never SUPPRESS a signal. `[data-active]` and the
  // wash rule both write a background and a colour, both at (0,2,0), so only
  // their order in the file decides — and if the chip fill won, the one card
  // you are looking at would be the one whose "needs you" you cannot see. It
  // would still be perfectly legible (--text on --chip is 8.4:1), so every
  // ratio above would stay green: this is the assertion that notices.
  // Spelled as pairs rather than derived from the names: a lookup that misses
  // would compare a state with itself and pass, which is the failure this whole
  // function is written to avoid.
  const HERE_TOO: Array<[signalling: string, andHere: string]> = [
    ['needs you', 'needs you, and "you are here"'],
    ['lit', 'lit, and "you are here"'],
    ['needs you, and lit', 'needs you, lit, and "you are here"'],
  ];
  for (const [alone, andHere] of HERE_TOO) {
    expect(seen(andHere).bg, `${id}, ${pointer}: "${alone}" must survive being where you are`).toBe(
      seen(alone).bg
    );
    expect(seen(andHere).ink, `${id}, ${pointer}: "${alone}" keeps its ink where you are`).toBe(
      seen(alone).ink
    );
  }
}
