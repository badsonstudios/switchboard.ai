// P2-E15-05 — themes are token maps, and the third one is a data file.
//
// The unit tests own the map mechanics; these are the two claims only the real
// window can settle: that a JSON theme actually REPAINTS (a token map nobody
// resolves is a token map that does nothing), and that the paint reaches a
// popped-out window, which is a separate document with its own <html>.
import { test, expect, Locator, Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { launchApp, LaunchedApp, tempProjectFolder } from './fixtures/app';

/** the RESOLVED value of a custom property on a document root */
function token(page: Page, name: string): Promise<string> {
  return page.evaluate(
    (t) => getComputedStyle(document.documentElement).getPropertyValue(t).trim(),
    name
  );
}

/**
 * What one element's words measure against, IN THE RUNNING WINDOW.
 *
 * Serialized into the page, so it closes over nothing and every helper it needs
 * is inside it. Two things it does that reading the files cannot:
 *  • it walks to the first OPAQUE background at or above the word, which is the
 *    only way to know the colour a mix or a transparent fill really resolved to;
 *  • it folds in every `opacity` between the word and that background — a
 *    contrast cut nothing in the token map can see, and the reason the feed's
 *    streaming caret was under AA on daylight while its colour token was fine.
 * `from` is reported rather than asserted here so each caller can say what it
 * expected the word to be sitting on.
 */
const painted = (el: Element): { from: string; ratio: number } => {
  // rgb()/rgba() come back 0-255, but anything that went through color-mix()
  // arrives as color(srgb r g b) in 0-1 floats. Reading the second as 0-255
  // scores every mixed colour as black — a false PASS for dark ink, which is
  // exactly the case this exists for.
  const rgb = (c: string): number[] => {
    const n = c.match(/[\d.]+/g)!.slice(0, 3).map(Number);
    return c.startsWith('color(') ? n : n.map((v) => v / 255);
  };
  const lum = (c: string): number => {
    const [r, g, b] = rgb(c);
    const f = (s: number): number => (s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  let alpha = 1;
  let from = 'none';
  let bg = 'rgb(255, 255, 255)';
  for (let n: Element | null = el; n; n = n.parentElement) {
    const s = getComputedStyle(n);
    const parts = s.backgroundColor.match(/[\d.]+/g);
    if (parts && (parts.length < 4 || Number(parts[3]) >= 0.99)) {
      // an opacity ON the background element fades the words with it, so it
      // changes nothing and the walk stops before counting it
      bg = s.backgroundColor;
      from = n === el ? 'self' : (n.getAttribute('data-testid') ?? n.className ?? 'ancestor');
      break;
    }
    alpha *= Number(s.opacity);
  }
  const ink = rgb(getComputedStyle(el).color);
  const back = rgb(bg);
  const eff = ink.map((v, i) => v * alpha + back[i] * (1 - alpha));
  const [a, b] = [lum(`rgb(${eff.map((v) => v * 255).join(',')})`), lum(bg)];
  return { from, ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) };
};

/** the ratio of the first element a locator resolves to */
function contrastOf(where: Locator): Promise<{ from: string; ratio: number }> {
  return where.evaluate(painted);
}

/** [picker label, the id it paints] — the shipped set, as a user meets it. */
const THEMES: Array<[string, string]> = [
  ['nordic', 'nordic'],
  ['daylight', 'daylight'],
  ['high contrast', 'high-contrast'],
  ['soft contrast', 'soft-contrast'],
];

test.describe('themes (P2-E15-05)', () => {
  let a: LaunchedApp;
  test.afterEach(async () => a?.cleanup());

  test('every shipped theme is selectable and high contrast repaints', async () => {
    a = await launchApp();
    const w = a.window;
    const html = w.locator('html');

    for (const [label] of THEMES) {
      await expect(w.getByRole('button', { name: label, exact: true })).toBeVisible();
    }

    await w.getByRole('button', { name: 'daylight', exact: true }).click();
    const light = await token(w, '--bg');

    await w.getByRole('button', { name: 'high contrast', exact: true }).click();
    // the id is the theme; data-theme stays on the PRESET it builds on, which
    // is what lets an overlay inherit the rest of a dark palette
    await expect(html).toHaveAttribute('data-theme-id', 'high-contrast');
    await expect(html).toHaveAttribute('data-theme', 'nordic');
    await expect(html).toHaveAttribute('data-color-scheme', 'dark');

    const hc = await token(w, '--bg');
    expect(hc).not.toBe(light);
    // black, from the JSON — the file is doing the painting
    expect(hc).toMatch(/^(#000000|rgb\(0, 0, 0\))$/);

    // and switching away leaves nothing of it behind
    await w.getByRole('button', { name: 'daylight', exact: true }).click();
    expect(await token(w, '--bg')).toBe(light);
  });

  test('every theme composes a VALID drop-target ring', async () => {
    // The assertion class the contrast tests miss: they read values out of the
    // file, and a value can be a perfectly good color and still break the
    // declaration it lands in. The rail builds its drop highlight by
    // concatenating a shadow token — `box-shadow: 0 0 0 2px <accent>,
    // var(--group-lift)` — and `none` is a whole-property keyword, not a list
    // item, so a theme setting `--group-lift: none` makes the whole thing
    // invalid and the ring disappears in the theme that most needs it.
    a = await launchApp();
    const w = a.window;
    for (const [label, id] of THEMES) {
      await w.getByRole('button', { name: label, exact: true }).click();
      // the chip must actually have switched — otherwise this loop could pass
      // three times over the theme it booted in
      await expect(w.locator('html')).toHaveAttribute('data-theme-id', id);
      const shadow = await w.evaluate(() => {
        const probe = document.createElement('div');
        probe.style.boxShadow = '0 0 0 2px rgb(1, 2, 3), var(--group-lift)';
        document.body.append(probe);
        const value = getComputedStyle(probe).boxShadow;
        probe.remove();
        return value;
      });
      expect(shadow, `${label}: drop ring dropped by the browser`).not.toBe('none');
      expect(shadow, `${label}: ring color missing`).toContain('rgb(1, 2, 3)');
    }
  });

  test('the status pill is legible in every theme, as painted (#221)', async () => {
    // The unit tests compute this mix from the files; only the real window can
    // say what Chromium actually PAINTED. It matters here more than anywhere
    // else the tokens are checked, because the pill's fill is a `color-mix` of
    // a status hue into the card header — nothing in the token map holds that
    // colour, and the two halves of the pair live in different files (the rule
    // in tokens.css, the hue/ink it receives in StatusPill.tsx). This is also
    // the only check that would notice the pill being moved onto some other
    // surface, which would leave the computed promise measuring a fiction.
    a = await launchApp({ seedFolder: tempProjectFolder() });
    const w = a.window;
    const pill = w.locator('.status-pill').first();
    await expect(pill).toBeVisible({ timeout: 25_000 });

    for (const [label, id] of THEMES) {
      await w.getByRole('button', { name: label, exact: true }).click();
      await expect(w.locator('html')).toHaveAttribute('data-theme-id', id);

      // the pill's own fill is opaque by design (#221), so the walk should stop
      // on the pill itself — a walk that had to climb to the header would mean
      // the fill went transparent again, and the ratio would be measured
      // against a surface the user never sees through it
      const seen = await contrastOf(pill);

      expect(seen.from, `${id}: the pill's own fill must be what the word sits on`).toBe('self');
      expect(seen.ratio, `${id} status pill contrast`).toBeGreaterThanOrEqual(4.5);
    }
  });

  test('no word on screen is painted in a raw status hue (#246)', async () => {
    // #221 fixed the status pill and reported six more sites of the same
    // defect: a status hue used as a TEXT colour. This is the painted answer
    // to all of them at once — no selector list, so it cannot go stale and it
    // finds sites nobody wrote down. It asks two questions of every visible
    // word in the real window, in every shipped theme:
    //   1. is its colour a raw --status-<x>? (only askable where the theme's
    //      ink and hue DIFFER — the two contrast themes set ink == hue, so
    //      there is nothing to tell apart and nothing to catch);
    //   2. if its colour is a status INK, does it clear 4.5:1 against what is
    //      actually behind it, opacity included?
    // The feed is loaded first because five of the six sites are in it, and it
    // is where the surfaces are tinted rather than flat.
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    await expect(w.getByText(folder.split(/[\\/]/).pop()!).first()).toBeVisible({
      timeout: 25_000,
    });

    // the CLI's part, as feed.spec.ts plays it: a link in rendered prose
    // (.feed-md a), a tool block header (the tool's name), and a checklist —
    // three of the sites, on screen, at their real sizes
    const dir = path.join(a.home, '.claude', 'projects', folder.replace(/[\\/:. ]/g, '-'));
    fs.mkdirSync(dir, { recursive: true });
    const line = (o: Record<string, unknown>): string =>
      JSON.stringify({
        sessionId: 'native-contrast',
        cwd: folder,
        timestamp: new Date().toISOString(),
        ...o,
      }) + '\n';
    fs.writeFileSync(
      path.join(dir, 'native-contrast.jsonl'),
      line({ type: 'user', message: { role: 'user', content: 'read the docs' } }) +
        line({
          type: 'assistant',
          message: {
            content: [
              { type: 'text', text: 'see [the manual](https://example.invalid/manual)' },
              { type: 'tool_use', name: 'Read', input: { file_path: 'C:/tmp/x.md' } },
              {
                type: 'tool_use',
                name: 'TodoWrite',
                input: {
                  todos: [
                    { content: 'first step', status: 'completed' },
                    { content: 'second step', status: 'in_progress' },
                  ],
                },
              },
            ],
          },
        })
    );
    await expect(w.locator('.feed-md a')).toBeVisible({ timeout: 25_000 });
    await expect(w.getByText('first step')).toBeVisible();

    for (const [label, id] of THEMES) {
      await w.getByRole('button', { name: label, exact: true }).click();
      await expect(w.locator('html')).toHaveAttribute('data-theme-id', id);

      const seen = await w.evaluate((ramp) => {
        // The same walk `painted` does, spelled out again rather than injected:
        // the renderer runs under a strict CSP (csp.spec.ts) that forbids
        // `new Function`, so a helper cannot be reconstituted inside the page.
        const chan = (c: string): number[] => {
          const n = c.match(/[\d.]+/g)!.slice(0, 3).map(Number);
          return c.startsWith('color(') ? n : n.map((v) => v / 255);
        };
        const lum = (rgb: number[]): number => {
          const f = (s: number): number => (s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4);
          return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]);
        };
        const measure = (el: Element): { ratio: number; why: string } => {
          let alpha = 1;
          let bg = 'rgb(255, 255, 255)';
          let from = 'nothing opaque';
          for (let n: Element | null = el; n; n = n.parentElement) {
            const s = getComputedStyle(n);
            const parts = s.backgroundColor.match(/[\d.]+/g);
            if (parts && (parts.length < 4 || Number(parts[3]) >= 0.99)) {
              bg = s.backgroundColor;
              const cls = typeof n.className === 'string' ? n.className.trim() : '';
              from =
                n === el
                  ? 'itself'
                  : (n.getAttribute('data-testid') ?? (cls || n.tagName.toLowerCase()));
              break;
            }
            // an opacity between the word and its background is a contrast cut
            // no token map can see — the streaming caret's was 0.8 (#246)
            alpha *= Number(s.opacity);
          }
          const back = chan(bg);
          const eff = chan(getComputedStyle(el).color).map(
            (v, i) => v * alpha + back[i] * (1 - alpha)
          );
          const [a, b] = [lum(eff), lum(back)];
          return {
            ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05),
            // a failure that does not say what it measured sends the next
            // reader hunting for a surface by hand, which is how #221's six
            // sites went unmeasured in the first place
            why: `${getComputedStyle(el).color} at opacity ${alpha.toFixed(2)} on ${bg} (from ${from})`,
          };
        };
        const cs = getComputedStyle(document.documentElement);
        const norm = (c: string): string => {
          const t = c.trim();
          if (t.startsWith('#')) {
            const h = t.slice(1);
            const p =
              h.length === 3
                ? [...h].map((x) => x + x)
                : [h.slice(0, 2), h.slice(2, 4), h.slice(4, 6)];
            return p.map((x) => parseInt(x, 16)).join(',');
          }
          const m = t.match(/[\d.]+/g);
          if (!m) return t;
          const v = m.slice(0, 3).map(Number);
          return (t.startsWith('color(') ? v.map((x) => x * 255) : v).map(Math.round).join(',');
        };
        // a hue is only DISTINGUISHABLE from its ink where the theme gives them
        // different values; where they are equal there is no defect to find
        const hueNames = new Map<string, string>();
        const inks = new Set<string>();
        for (const s of ramp) {
          const hue = norm(cs.getPropertyValue('--status-' + s));
          const ink = norm(cs.getPropertyValue('--status-' + s + '-ink'));
          inks.add(ink);
          if (hue !== ink) hueNames.set(hue, '--status-' + s);
        }

        // WHY A COLOUR VALUE IS NOT ALWAYS ENOUGH: four of the eight
        // session-identity accents (§5.11) are byte-identical to a status hue
        // — `--accent-amber` IS `--status-needs-input`, `--accent-blue` IS
        // `--status-working` — and a session's accent is a raw hex from the
        // main process (sessions/identity.ts), so on screen the card's identity
        // badge is the same pixels as a needs-input word. Two answers, in this
        // order: an element with an INLINE colour still names the token it was
        // given, and a name cannot collide; only when there is no inline colour
        // (a CSS rule, or an inherited one) does this fall back to matching by
        // value, and there the accents are excluded. Read out of the
        // stylesheet, not listed here, so a ninth accent needs no edit.
        //
        // MEASURED, not assumed (mutation-checked while writing this): reverting
        // the tool block's inline colour to `var(--status-working)` fails here
        // by name; reverting the CSS rule `.feed-md a` to the same hue does NOT,
        // because `--status-working` and `--accent-blue` are the same pixels and
        // this cannot tell them apart. That case belongs to the source scan in
        // tokens.drift.test.ts, which reads names for every site in the tree.
        const accents = new Set<string>();
        for (const sheet of Array.from(document.styleSheets)) {
          let rules: CSSRule[];
          try {
            rules = Array.from(sheet.cssRules);
          } catch {
            continue;
          }
          for (const rule of rules) {
            const style = (rule as CSSStyleRule).style;
            if (!style) continue;
            for (const prop of Array.from(style)) {
              if (prop.startsWith('--accent-')) accents.add(norm(style.getPropertyValue(prop)));
            }
          }
        }
        const name = (el: Element): string =>
          el.tagName.toLowerCase() +
          (typeof el.className === 'string' && el.className.trim()
            ? '.' + el.className.trim().split(/\s+/).join('.')
            : '') +
          ' "' +
          (el.textContent ?? '').trim().slice(0, 30) +
          '"';

        const hues: string[] = [];
        const dim: string[] = [];
        let inked = 0;
        for (const el of Array.from(document.querySelectorAll('*'))) {
          // WORDS only: an element with no text node of its own paints none,
          // and every child would otherwise be counted again for its parent's
          // inherited colour
          const words = Array.from(el.childNodes).some(
            (n) => n.nodeType === 3 && (n.textContent ?? '').trim() !== ''
          );
          if (!words) continue;
          const box = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          if (box.width === 0 || box.height === 0 || style.visibility === 'hidden') continue;
          // the token this element was HANDED, when it was handed one
          const named = /var\((--status-[a-z-]+)\)/.exec((el as HTMLElement).style?.color ?? '');
          if (named && !named[1].endsWith('-ink')) {
            hues.push(named[1] + ' as text on ' + name(el));
            continue;
          }
          const colour = norm(style.color);
          if (!named) {
            if (accents.has(colour)) continue;
            if (hueNames.has(colour)) {
              hues.push(hueNames.get(colour) + ' as text on ' + name(el));
              continue;
            }
            if (!inks.has(colour)) continue;
          }
          inked++;
          const r = measure(el);
          if (r.ratio < 4.5) dim.push(`${name(el)} = ${r.ratio.toFixed(2)}:1 — ${r.why}`);
        }
        return { hues, dim, inked, distinguishable: hueNames.size > 0 };
      }, ['working', 'needs-input', 'needs-permission', 'idle', 'done', 'crashed']);

      expect(seen.hues, `${id}: a status HUE is being used as a text colour`).toEqual([]);
      expect(seen.dim, `${id}: status-inked words below 4.5:1 as painted`).toEqual([]);
      // the sweep's own guard: a walk that matched nothing would pass both of
      // the assertions above without looking at a single word
      expect(seen.inked, `${id}: nothing status-coloured was on screen to check`).toBeGreaterThan(2);
      expect(seen.distinguishable || id.endsWith('contrast')).toBe(true);
    }
  });

  test('the theme AND language survive a relaunch of the built app', async () => {
    // P2-E15-06, and it was a LIVE bug measured 2026-07-31: both prefs lived in
    // localStorage, and the packaged renderer is served from a random loopback
    // port — origin `http://127.0.0.1:58814` on one launch, `:57029` on the
    // next — so the store they were written to did not exist any more. The
    // picker worked and the choice evaporated at the door, every time. This
    // test has to run against the BUILT app for that reason: a dev server has a
    // stable origin and would have passed throughout the bug.
    a = await launchApp();
    const first = a;
    await first.window.getByRole('button', { name: 'high contrast', exact: true }).click();
    await expect(first.window.locator('html')).toHaveAttribute('data-theme-id', 'high-contrast');
    await first.window.getByRole('button', { name: 'pseudo', exact: true }).click();
    await expect(first.window.getByText(/⟦.+⟧/).first()).toBeVisible();
    await first.close();

    a = await launchApp({ home: first.home });
    await expect(a.window.locator('html')).toHaveAttribute('data-theme-id', 'high-contrast', {
      timeout: 25_000,
    });
    // the language came back too — same store, same bug
    await expect(a.window.getByText(/⟦.+⟧/).first()).toBeVisible();
  });

  test('a theme switch reaches a popped-out window', async () => {
    test.skip(
      process.platform === 'linux',
      'popout opens a 2nd OS window — unreliable under headless xvfb; covered on Windows + macOS'
    );
    a = await launchApp({ seedFolder: tempProjectFolder() });
    const w = a.window;
    await expect(w.locator('nav [draggable="true"]')).toHaveCount(1, { timeout: 25_000 });

    await w.getByTitle('Pop out into its own window').click();
    await expect.poll(() => a.app.windows().length, { timeout: 15_000 }).toBe(2);
    const popout = a.app.windows().find((p) => p.url().includes('popout.html'))!;
    expect(popout, 'no popout page').toBeTruthy();

    await w.getByRole('button', { name: 'high contrast', exact: true }).click();

    // the popout shares the stylesheet but not our <html>: without the overlay
    // copy it would sit on the nordic PRESET with every override missing —
    // which looks exactly like a theme that half-applied
    await expect
      .poll(() => token(popout, '--bg'), { timeout: 10_000 })
      .toBe(await token(w, '--bg'));
    await expect(popout.locator('html')).toHaveAttribute('data-theme-id', 'high-contrast');

    // and back: a stale override in the popout is the same bug in reverse
    await w.getByRole('button', { name: 'nordic', exact: true }).click();
    await expect
      .poll(() => token(popout, '--bg'), { timeout: 10_000 })
      .toBe(await token(w, '--bg'));
  });
});
