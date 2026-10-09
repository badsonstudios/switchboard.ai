// The redesigned sessions rail (design_handoff_sessions_rail).
//
// The rail's contract is "which sessions need me right now", so the attention
// treatment is driven through the REAL machinery — the test plays the CLI's part
// and asserts what a human would actually see, including the numeric contrast
// between a needy row and a calm one.
//
// TWO STIMULI, AND #952 MOVED ONE OF THEM. Plain STATUS still comes from the
// real hook listener (`hookPoster`): `Stop`, `UserPromptSubmit` and the idle nag
// have no control-channel equivalent, and that is what the hook channel is still
// for. But `needs-permission` is no longer reachable that way — #313's guard
// drops a permission `Notification` before it can move a badge, and #952 made
// that unconditional, because every real permission arrives as `can_use_tool`
// and a debounced nudge on top of it is a duplicate at best and a false alarm at
// worst.
//
// So a test that wants a needy row asks for a REAL permission: `!perm` makes the
// fake stream CLI request one, it is held by `StreamPermissions`, and the status
// comes from `stream-status.ts`. That is a better test than the one it replaced
// — it drives the path the product actually uses, rather than a nudge that
// happened to move the same attribute.
import { test, expect, Page } from '@playwright/test';
import path from 'path';
import {
  launchApp,
  LaunchedApp,
  openEventsDrawer,
  tempProjectFolder,
  hookPoster,
  streamPrompter,
  setTheme,
} from './fixtures/app';

const rail = (w: Page) => w.locator('nav');
const row = (w: Page, title: string) =>
  rail(w).locator('[draggable="true"]', { hasText: title }).first();

test.describe('sessions rail', () => {
  let a: LaunchedApp;
  test.afterEach(async () => a?.cleanup());

  /**
   * One session inside one real group — the design's actual shape, and the
   * only arrangement that has a group header to summarize. (A workspace with
   * no groups at all renders the loose sessions headerless on purpose; the
   * footer is what carries the count there.)
   */
  async function oneSessionInAGroup(): Promise<{ w: Page; title: string }> {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    const title = path.basename(folder);
    await expect(w.getByText(title).first()).toBeVisible({ timeout: 25_000 });

    await w.getByTitle('Create a persistent group').click();
    const header = w.getByText('New group', { exact: true });
    await expect(header).toBeVisible();
    const dt = await w.evaluateHandle(() => new DataTransfer());
    await row(w, title).dispatchEvent('dragstart', { dataTransfer: dt });
    await header.dispatchEvent('drop', { dataTransfer: dt });
    await expect(rail(w).getByText('empty', { exact: true })).toHaveCount(0);
    return { w, title };
  }

  test('a session that needs you is loud; a calm one stays plain', async () => {
    const { w, title } = await oneSessionInAGroup();

    // calm to start: no attention tint, and the header summary says so
    const r = row(w, title);
    await expect(r).toHaveAttribute('data-needs-you', 'false');
    await expect(rail(w).getByText('calm')).toBeVisible();
    await expect(rail(w).getByText('need you')).toHaveCount(0);

    // A REAL held permission, not a Notification nudge (#952) — see the file
    // header. `!perm` makes the fake CLI ask for one over `can_use_tool`.
    await streamPrompter(a)(title, '!perm rail.sh');

    // ⚠️ REWRITTEN BY #877, AND THE OLD COMMENT IS THE POINT. It read "the row
    // now SPELLS OUT the ask instead of showing a status word", and asserted
    // `Wants permission to run` was VISIBLE on the row. That was true, and it
    // cost the row its task label: the long ask and the label competed for the
    // same second line, so a session that needed you showed no label at all —
    // at the one moment you most want to know WHICH piece of work is asking.
    //
    // So the ask moved. The visible row carries the short `status.*` word (the
    // same vocabulary the card header's pill uses) and the FULL ask lives in the
    // row button's accessible name, which is asserted here rather than dropped:
    // nothing was lost, it was relocated, and this pair is what says so.
    await expect(r).toHaveAttribute('data-session-status', 'needs-permission', { timeout: 15_000 });
    await expect(r.locator('[data-rail-state]')).toHaveText('needs you');
    await expect(r.locator('[data-rail-open]')).toHaveAttribute(
      'aria-label',
      /Wants permission to run/
    );
    await expect(r).toHaveAttribute('data-needs-you', 'true');

    // ...the name goes bold and the identity bar thickens (2.5px -> 4px)
    const name = r.locator('span', { hasText: title }).first();
    await expect
      .poll(() => name.evaluate((el) => getComputedStyle(el).fontWeight))
      .toBe('700');
    await expect
      .poll(() => r.locator('span[aria-hidden]').first().evaluate((el) => getComputedStyle(el).width))
      .toBe('4px');

    // ...and both counters agree with the row, because one rule feeds all three
    await expect(rail(w).getByText('1 need you')).toHaveCount(2); // group summary + footer
    await expect(rail(w).getByText('calm')).toHaveCount(0);
  });

  test('answering the session puts the rail back to calm', async () => {
    const { w, title } = await oneSessionInAGroup();
    const post = await hookPoster(a);
    await post(title, { hook_event_name: 'Stop' }); // finished, unreviewed
    const r = row(w, title);
    await expect(r).toHaveAttribute('data-session-status', 'done', { timeout: 15_000 });
    // …and the same relocation as above (#877): the short word on the row, the
    // whole sentence in its accessible name.
    await expect(r.locator('[data-rail-state]')).toHaveText('done');
    await expect(r.locator('[data-rail-open]')).toHaveAttribute(
      'aria-label',
      /Finished — review changes/
    );

    // back to work: the attention treatment must clear completely, or the rail
    // cries wolf and the whole panel stops meaning anything
    await post(title, { hook_event_name: 'UserPromptSubmit' });
    await expect(r).toHaveAttribute('data-needs-you', 'false', { timeout: 15_000 });
    await expect(rail(w).getByText('calm')).toBeVisible();
    await expect(rail(w).getByText('need you')).toHaveCount(0);
  });

  test('dismissing the event clears every "N need you" (#621)', async () => {
    // The owner's dogfood report: he dismissed the events and the counters sat
    // there. They counted the session's STATUS, and dismissing an event calls
    // `EventFeed.forget` — which moves the Events window and nothing else. So
    // the two surfaces disagreed about what "addressed" meant.
    //
    // Driven end to end on purpose: a real `can_use_tool` request raises it, the
    // real ✕ dismisses it, and the assertion is the three readouts a human reads.
    // The stimulus moved from a hook Notification to `!perm` in #952 — see the
    // file header — which makes "end to end" more true than it was.
    const { w, title } = await oneSessionInAGroup();
    await streamPrompter(a)(title, '!perm dismiss.sh');

    const r = row(w, title);
    await expect(r).toHaveAttribute('data-needs-you', 'true', { timeout: 15_000 });
    // they agree BEFORE: the group summary and the footer, in words and as a number
    await expect(rail(w).getByText('1 need you')).toHaveCount(2);
    await expect(w.locator('nav [data-rail-need]')).toHaveAttribute('data-rail-need', '1');

    await openEventsDrawer(w);
    const item = w.getByTestId('events-drawer').locator('[data-event-kind]').first();
    await expect(item).toBeVisible({ timeout: 15_000 });
    await item.locator('.event-dismiss').click();
    await expect(w.getByTestId('events-drawer').locator('[data-event-kind]')).toHaveCount(0, {
      timeout: 15_000,
    });

    // ...and they follow it down. This is the regression: before #621 they
    // stayed at 1 for as long as the session lived.
    await expect(rail(w).getByText('need you')).toHaveCount(0, { timeout: 15_000 });
    await expect(rail(w).getByText('calm')).toBeVisible();
    await expect(w.locator('nav [data-rail-need]')).toHaveCount(0);

    // The row follows the count down too (#1137): "0 need you" over a lit row
    // is the same disagreement from the other side. What does NOT move is what
    // the row SAYS — the CLI is still waiting for permission, and §4's
    // fail-open rule does not let a dismissal make that unknowable. Dismissing
    // takes the item off your plate; it does not answer it.
    await expect(r).toHaveAttribute('data-needs-you', 'false');
    await expect(r).toHaveAttribute('data-session-status', 'needs-permission');
    await expect
      .poll(() => r.locator('[data-rail-state]').evaluate((el) => (el as HTMLElement).style.color))
      .toBe('var(--status-needs-permission-ink)');
  });

  test("the row's ✕ ends the session, and only after the confirm", async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    const title = path.basename(folder);
    await expect(w.getByText(title).first()).toBeVisible({ timeout: 25_000 });

    // dismissing the confirm keeps the session — the ✕ sits on every row, so a
    // mis-click must never be able to kill work
    w.once('dialog', (d) => void d.dismiss());
    await row(w, title).getByTitle('Close session').click();
    await expect(row(w, title)).toBeVisible();

    w.once('dialog', (d) => void d.accept());
    await row(w, title).getByTitle('Close session').click();
    await expect(rail(w).getByText(title)).toHaveCount(0);
  });

  test('right-click opens the changes tab (the diff affordance the rows dropped)', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    const title = path.basename(folder);
    await expect(w.getByText(title).first()).toBeVisible({ timeout: 25_000 });

    await row(w, title).click({ button: 'right' });
    await expect(w.getByRole('menu')).toBeVisible();
    await w.getByRole('menuitem', { name: 'Open changes' }).click();
    await expect(w.getByRole('menu')).toHaveCount(0);
    await expect(w.locator('.dv-active-tab')).toContainText('· diff', { timeout: 15_000 });
  });

  test('the right-click menu stays INSIDE the window, however little room is under it (#641)', async () => {
    // The regression #559 fired and nothing caught until CI: the rail's menu is
    // `position: fixed` at the pointer, so a menu taller than the room beneath
    // it hangs off the bottom edge — and a fixed box has no scroll container,
    // so the items past the fold are unreachable. `Move up`/`Move down` added
    // ~72px, the bottom radio landed 7px below the windows-latest runner's
    // 655px viewport, and `click()` retried for 30s against an element
    // Playwright itself called "visible, enabled and stable".
    //
    // THE MENU IS SHORT AGAIN (#1168 took those items and both ticked lists
    // off it), so the app's own 600px minimum no longer squeezes it. The
    // placement code is the same and still has to hold for the day the menu
    // grows, so the squeeze is made here instead: the window is cut to end
    // just under the row that is clicked, measured, with the OS minimum
    // lifted for this test's window. The precondition is still asserted, so
    // this can never quietly stop testing anything.
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    const first = path.basename(folder);
    await expect(row(w, first)).toBeVisible({ timeout: 25_000 });

    // a second session, so the row that is clicked is not the first one
    const second = tempProjectFolder();
    await a.app.evaluate(({ dialog }, d) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [d] });
    }, second);
    await w.getByRole('button', { name: '+ session' }).click();
    const title = path.basename(second);
    await expect(row(w, title)).toBeVisible({ timeout: 25_000 });

    // cut the window to end ROOM_UNDER px below the middle of the row: less
    // than the menu is tall, and enough that the row itself is still drawn
    const ROOM_UNDER = 70;
    const at = (await row(w, title).boundingBox())!;
    const wanted = Math.round(at.y + at.height / 2 + ROOM_UNDER);
    await a.app.evaluate(({ BrowserWindow }, h) => {
      const win = BrowserWindow.getAllWindows()[0];
      win.unmaximize();
      win.setMinimumSize(600, 120);
      win.setContentSize(1024, h);
    }, wanted);
    await expect
      .poll(async () => w.evaluate(() => window.innerHeight), { timeout: 10_000 })
      .toBeLessThanOrEqual(wanted + 8); // the OS rounds; the real precondition is asserted below
    await expect(row(w, title)).toBeVisible();
    // A resize CLOSES an open menu, and the OS can deliver one more after the
    // height has already arrived. Wait until the size has held still.
    await expect
      .poll(
        async () =>
          w.evaluate(
            () =>
              new Promise<boolean>((done) => {
                let moved = false;
                const on = (): void => {
                  moved = true;
                };
                window.addEventListener('resize', on);
                setTimeout(() => {
                  window.removeEventListener('resize', on);
                  done(!moved);
                }, 400);
              })
          ),
        { timeout: 10_000 }
      )
      .toBe(true);

    // The click goes to the coordinate that was MEASURED, not to wherever
    // Playwright re-resolves the row's centre a moment later: `pointerY` is the
    // precondition below, and a rail that reflows between the two (a status
    // change, a need count landing) would make it a lie.
    const rowBox = (await row(w, title).boundingBox())!;
    const pointerY = rowBox.y + rowBox.height / 2;
    // ...and the row really is what is under that point: in a window this
    // short, a row can be measured and still be cut off by what is below it
    const under = await w.evaluate(
      ([x, y]) => {
        const el = document.elementFromPoint(x, y);
        return {
          inRow: !!el?.closest('.rail-row'),
          what: el ? `${el.tagName}.${el.className}`.slice(0, 80) : 'nothing',
          vh: window.innerHeight,
        };
      },
      [rowBox.x + rowBox.width / 2, pointerY]
    );
    expect(under.inRow, `under the pointer: ${under.what} at y=${pointerY} of ${under.vh}`).toBe(true);
    await w.mouse.click(rowBox.x + rowBox.width / 2, pointerY, { button: 'right' });
    const menu = w.getByRole('menu');
    await expect(menu).toBeVisible();

    const geom = await w.evaluate(() => {
      const el = document.querySelector('[role="menu"]') as HTMLElement;
      const all = el.querySelectorAll<HTMLElement>('[role^="menuitem"]');
      const last = all[all.length - 1];
      const m = el.getBoundingClientRect();
      const l = last.getBoundingClientRect();
      return {
        viewport: window.innerHeight,
        menu: { top: m.top, bottom: m.bottom, height: el.scrollHeight },
        last: { top: l.top, bottom: l.bottom },
      };
    });

    // the precondition: at the pointer, this menu genuinely does not fit
    expect(
      pointerY + geom.menu.height,
      'the window is no longer tight enough for this test to mean anything'
    ).toBeGreaterThan(geom.viewport);

    // ...and it was placed anyway — whole menu on screen, last item included
    expect(geom.menu.top).toBeGreaterThanOrEqual(0);
    expect(geom.menu.bottom).toBeLessThanOrEqual(geom.viewport);
    expect(geom.last.bottom).toBeLessThanOrEqual(geom.viewport);

    // and it is OPERABLE, not merely on screen. A short timeout on purpose: the
    // failure this guards against is a 30s click retry, and a regression should
    // say so in seconds.
    // The LAST item is "Close session", which is not something to click in
    // passing; a trial click runs every check a real one does (on screen,
    // not covered, receives the pointer) and stops short of pressing.
    await menu.getByRole('menuitem').last().click({ trial: true, timeout: 10_000 });
    await menu.getByRole('menuitem', { name: 'Pin session' }).click({ timeout: 10_000 });
    await expect(menu).toHaveCount(0);
    // on the row, not at the old point: a pinned session moves to the top
    await row(w, title).click({ button: 'right' });
    await expect(w.getByRole('menuitem', { name: 'Unpin session' })).toBeVisible();
  });

  test('the right-click menu opens AT the pointer when the app reads right-to-left (#642)', async () => {
    // `insetInlineStart` counts from the RIGHT edge under `dir="rtl"`, and the
    // rail was feeding it a `clientX`, which counts from the left in every
    // writing mode. The two disagree by the whole width of the window: a menu
    // asked for at the pointer opened a window-width away from it, and at the
    // rail's own x that put it clean off the screen.
    //
    // §5.21 is why this is a shipping defect and not a hypothetical: "RTL
    // insurance now, not later" — the layout is written in logical properties
    // precisely so that the day a right-to-left locale is dropped in, it works.
    // A `dir` on the root is that day, simulated.
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    const title = path.basename(folder);
    await expect(row(w, title)).toBeVisible({ timeout: 25_000 });

    await w.evaluate(() => document.documentElement.setAttribute('dir', 'rtl'));
    // the whole app is laid out from the right now, rail included
    await expect
      .poll(async () =>
        w.evaluate(() => getComputedStyle(document.querySelector('nav')!).direction)
      )
      .toBe('rtl');

    // clicked at the coordinate that was measured, for the same reason as above
    const rowBox = (await row(w, title).boundingBox())!;
    const pointerX = rowBox.x + rowBox.width / 2;
    await w.mouse.click(pointerX, rowBox.y + rowBox.height / 2, { button: 'right' });
    const menu = w.getByRole('menu');
    await expect(menu).toBeVisible();

    const geom = await w.evaluate(() => {
      const el = document.querySelector('[role="menu"]') as HTMLElement;
      const b = el.getBoundingClientRect();
      return {
        vw: window.innerWidth,
        vh: window.innerHeight,
        left: b.left,
        right: b.right,
        top: b.top,
        bottom: b.bottom,
        width: b.width,
      };
    });

    // the precondition, stated so this cannot quietly stop testing anything:
    // the old formula and the new one are further apart than the menu is wide,
    // so "it happens to look right" is not available as an explanation
    const wrongLeft = geom.vw - pointerX - geom.width;
    expect(
      Math.abs(wrongLeft - geom.left),
      'physical and logical placement agree here, so this test proves nothing'
    ).toBeGreaterThan(geom.width);

    // on screen, all four edges
    expect(geom.left).toBeGreaterThanOrEqual(0);
    expect(geom.right).toBeLessThanOrEqual(geom.vw);
    expect(geom.top).toBeGreaterThanOrEqual(0);
    expect(geom.bottom).toBeLessThanOrEqual(geom.vh);

    // ...and AT the pointer: one of its inline edges sits on the click. The
    // right edge is the RTL-native answer (the menu grows in the reading
    // direction, leftward); the left edge is the flip, when there is no room
    // that way. Either is correct; a menu that touches neither is the bug.
    expect(Math.min(Math.abs(geom.right - pointerX), Math.abs(geom.left - pointerX))).toBeLessThan(
      2
    );

    // and it is OPERABLE where it landed, which is the whole point. Short
    // timeout on purpose: an off-screen item fails by retrying for 30s.
    await menu.getByRole('menuitem', { name: 'Pin session' }).click({ timeout: 10_000 });
    await expect(menu).toHaveCount(0);
    await row(w, title).click({ button: 'right' });
    await expect(w.getByRole('menuitem', { name: 'Unpin session' })).toBeVisible();
  });

  test('a session can be dropped ANYWHERE on a group card, not just its header', async () => {
    // Dan: "I have to drag it to the little folder icon when really I should
    // just be able to drag it right into the group window anywhere."
    const folderA = tempProjectFolder();
    const folderB = tempProjectFolder();
    a = await launchApp({ seedFolder: folderA });
    const w = a.window;
    const [nameA, nameB] = [path.basename(folderA), path.basename(folderB)];
    await expect(w.getByText(nameA).first()).toBeVisible({ timeout: 25_000 });

    await a.app.evaluate(({ dialog }, dir) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [dir] });
    }, folderB);
    await w.getByRole('button', { name: '+ session' }).click();
    await expect(w.getByText(nameB).first()).toBeVisible({ timeout: 25_000 });

    // put A in a group by dropping on the header (the path that already worked)
    await w.getByTitle('Create a persistent group').click();
    const dt1 = await w.evaluateHandle(() => new DataTransfer());
    await row(w, nameA).dispatchEvent('dragstart', { dataTransfer: dt1 });
    await w.getByText('New group', { exact: true }).dispatchEvent('drop', { dataTransfer: dt1 });
    await expect(rail(w).getByText('empty', { exact: true })).toHaveCount(0);

    // now drop B on the ROW for A — deep inside the card body, nowhere near
    // the header or the folder icon
    const dt2 = await w.evaluateHandle(() => new DataTransfer());
    await row(w, nameB).dispatchEvent('dragstart', { dataTransfer: dt2 });
    await row(w, nameA).dispatchEvent('drop', { dataTransfer: dt2 });

    // both live in the group card now
    const card = rail(w).locator('[data-group-card]', { hasText: 'New group' });
    await expect(card.locator('[draggable="true"]')).toHaveCount(2, { timeout: 15_000 });
  });

  test('an auto-group REFUSES a drop instead of silently swallowing it', async () => {
    // Dan 2026-07-26: two of his four cards wouldn't accept a drag and it took
    // a while to work out they were the automatic ones. The old code called
    // preventDefault on their dragover — so the browser advertised them as
    // valid targets — and then resolved the drop to "no group", which for an
    // already-ungrouped session is a no-op. Looked droppable, wasn't.
    const shared = tempProjectFolder();
    const other = tempProjectFolder();
    a = await launchApp({ seedFolder: shared });
    const w = a.window;
    const sharedName = path.basename(shared);
    await expect(w.getByText(sharedName).first()).toBeVisible({ timeout: 25_000 });

    // a second session in the SAME folder mints the auto-group
    await a.app.evaluate(({ dialog }, dir) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [dir] });
    }, shared);
    await w.getByRole('button', { name: '+ session' }).click();
    const auto = w.locator('[data-group-kind="auto"]');
    await expect(auto).toBeVisible({ timeout: 25_000 });
    await expect(auto.locator('[draggable="true"]')).toHaveCount(2);

    // ...and a loose session in a different folder to drag at it
    await a.app.evaluate(({ dialog }, dir) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [dir] });
    }, other);
    await w.getByRole('button', { name: '+ session' }).click();
    const otherName = path.basename(other);
    await expect(w.getByText(otherName).first()).toBeVisible({ timeout: 25_000 });

    // dragover must NOT be accepted — an unprevented dragover is exactly what
    // makes the browser draw a no-drop cursor
    const dt = await w.evaluateHandle(() => new DataTransfer());
    await row(w, otherName).dispatchEvent('dragstart', { dataTransfer: dt });
    const accepted = await auto.evaluate((el, type) => {
      const ev = new DragEvent('dragover', { bubbles: true, cancelable: true });
      Object.defineProperty(ev, 'dataTransfer', { value: new DataTransfer() });
      (ev.dataTransfer as DataTransfer).setData(type, 'x');
      el.dispatchEvent(ev);
      return ev.defaultPrevented;
    }, 'application/x-switchboard-card');
    expect(accepted, 'auto-group advertised itself as a drop target').toBe(false);

    // and the auto-group is unchanged: still exactly its two same-folder members
    await expect(auto.locator('[draggable="true"]')).toHaveCount(2);
  });

  test('a group name clears AA against its card in BOTH themes', async () => {
    // The group palette is tuned to read on a dark panel; raw, those mid-tones
    // land at 2.2-3.1:1 as 11.5px text on the daylight card. Measured, not
    // eyeballed, so a future palette or token edit can't quietly break it.
    const { w } = await oneSessionInAGroup();
    const name = w.getByText('New group', { exact: true });

    for (const theme of ['daylight', 'nordic'] as const) {
      await setTheme(w, theme);
      const ratio = await name.evaluate((el) => {
        const lum = (c: string): number => {
          // two shapes come back here: rgb()/rgba() in 0-255, and — for
          // anything that went through color-mix() — color(srgb r g b) in
          // 0-1 floats. Treating the second as 0-255 silently scores every
          // mixed color as black, which is exactly how a false pass hides.
          const n = c.match(/[\d.]+/g)!.slice(0, 3).map(Number);
          const [r, g, b] = c.startsWith('color(') ? n : n.map((v) => v / 255);
          const f = (s: number): number =>
            s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
          return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
        };
        // Walk up to the first OPAQUE background. The header band is a 7% tint,
        // so it must be skipped rather than measured — its rgba() channels are
        // the un-composited group color, which would score the text against
        // itself. The opaque card underneath is also the conservative choice:
        // the tint only darkens it, which helps dark text.
        let bg = 'rgb(255, 255, 255)';
        // `Element`, not `HTMLElement`: Playwright hands the callback an
        // `SVGElement | HTMLElement`, and only `Element` accepts both. Both
        // `getComputedStyle` and `parentElement` are defined on it.
        for (let n: Element | null = el; n; n = n.parentElement) {
          const c = getComputedStyle(n).backgroundColor;
          const parts = c.match(/[\d.]+/g);
          if (parts && (parts.length < 4 || Number(parts[3]) >= 0.99)) {
            bg = c;
            break;
          }
        }
        const a = lum(getComputedStyle(el).color);
        const b = lum(bg);
        return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      });
      expect(ratio, `${theme} group name contrast`).toBeGreaterThanOrEqual(4.5);
    }
  });

  test('the shared container frame reads against every surface it borders', async () => {
    // Dan asked for one border treatment across the rail's group cards and the
    // grid's session windows, and for it to be more prevalent than the first
    // pass. Asserting the TOKEN covers both consumers at once — and covers the
    // UNFOCUSED frame, which is the case tabs.spec can't see (with one group
    // on screen it is always the accent-drawn active one).
    a = await launchApp({ seedFolder: tempProjectFolder() });
    const w = a.window;
    await expect(w.locator('nav [draggable="true"]')).toHaveCount(1, { timeout: 25_000 });

    for (const theme of ['daylight', 'nordic']) {
      await setTheme(w, theme);
      await w.waitForTimeout(200);
      const ratios = await w.evaluate(() => {
        const root = getComputedStyle(document.documentElement);
        const tok = (n: string): string => root.getPropertyValue(n).trim();
        const lum = (hex: string): number => {
          const m = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex)!;
          const f = (h: string): number => {
            const s = parseInt(h, 16) / 255;
            return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
          };
          return 0.2126 * f(m[1]) + 0.7152 * f(m[2]) + 0.0722 * f(m[3]);
        };
        const ratio = (x: string, y: string): number => {
          const [a2, b2] = [lum(x), lum(y)];
          const [hi, lo] = a2 > b2 ? [a2, b2] : [b2, a2];
          return (hi + 0.05) / (lo + 0.05);
        };
        const frame = tok('--group-frame');
        return {
          // the grid's session window against its own surface
          vsCard: ratio(frame, tok('--panel')),
          // the dockview tab strip, which runs along the top edge INSIDE the
          // frame — the lightest surface the edge touches on nordic, and the
          // one that binds the token's value (#648)
          vsTabStrip: ratio(frame, tok('--panel2')),
          // the rail's group card, and the canvas the card sits on
          vsRailCard: ratio(frame, tok('--rail-card')),
          vsRailCanvas: ratio(frame, tok('--rail-canvas')),
          // the workspace the grid's frames are drawn on
          vsWorkspace: ratio(frame, tok('--bg')),
        };
      });
      for (const [where, r] of Object.entries(ratios)) {
        // 1.4.11's bar for a meaningful non-text object, not the "is it more
        // prevalent than the first pass" floor of 1.55 this used to carry
        // (#648). The computed half is tokens.drift.test.ts, which measures
        // SEVEN pairs in all four themes — these five plus the two derived
        // `color-mix` surfaces of an auto-group card, which add nothing here.
        // This is the half that proves the running app resolves the token it
        // was told to.
        expect(r, `${theme} frame ${where}`).toBeGreaterThanOrEqual(3);
      }
    }
  });

  test('the rail width is draggable and survives a relaunch', async () => {
    a = await launchApp();
    const first = a;
    const w = first.window;
    const nav = rail(w);
    const before = (await nav.boundingBox())!.width;
    expect(Math.round(before)).toBe(286); // the design's figure, as shipped

    // drag the edge out to ~380px
    const handle = w.getByTitle('Drag to resize the rail');
    const box = (await handle.boundingBox())!;
    await w.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await w.mouse.down();
    await w.mouse.move(380, box.y + box.height / 2, { steps: 10 });
    await w.mouse.up();
    await expect.poll(async () => Math.round((await nav.boundingBox())!.width)).toBe(380);

    await w.waitForTimeout(800); // let the debounced ui-blob save reach disk
    await first.close();
    a = await launchApp({ home: first.home });
    await expect
      .poll(async () => Math.round((await rail(a.window).boundingBox())!.width))
      .toBe(380);
  });
});
