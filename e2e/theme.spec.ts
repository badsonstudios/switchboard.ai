// P2-E15-05 — themes are token maps, and the third one is a data file.
//
// The unit tests own the map mechanics; these are the two claims only the real
// window can settle: that a JSON theme actually REPAINTS (a token map nobody
// resolves is a token map that does nothing), and that the paint reaches a
// popped-out window, which is a separate document with its own <html>.
import { test, expect, Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { launchApp, LaunchedApp, tempProjectFolder } from './fixtures/app';
// the ramp itself, not a copy of it: a seventh status added to the app would
// otherwise drop out of the sweep in silence (#246)
import { STATUS_TOKENS } from '../src/renderer/src/lib/rail-view';

/** the RESOLVED value of a custom property on a document root */
function token(page: Page, name: string): Promise<string> {
  return page.evaluate(
    (t) => getComputedStyle(document.documentElement).getPropertyValue(t).trim(),
    name
  );
}

/** what one pass over the window found */
interface Audit {
  words: Word[];
  /** does THIS theme give any status an ink different from its hue? The two
   *  contrast themes do not, so there the hue half of the sweep is vacuous —
   *  reported rather than assumed, so nobody has to exempt a theme by name. */
  distinguishable: boolean;
}

/** one visible word, and what the window really painted it against */
interface Word {
  /** tag, classes and the first characters of the text — enough to go look */
  what: string;
  /** the element whose background the word ends up sitting on */
  from: string;
  ratio: number;
  /** the raw token, when the word is painted in a HUE (a status hue, or since
   *  #269 a §5.11 accent) rather than in an ink */
  hue: string | null;
  /** color, opacity and backdrop as measured — a failure has to be actionable */
  why: string;
}

/**
 * Every status-coloured word in the RUNNING WINDOW, and its real ratio.
 *
 * ONE implementation, serialized into the page (it closes over nothing), used
 * both by the pill's assertion and by the whole-window sweep — a second copy of
 * contrast arithmetic is a second chance to be subtly wrong about the thing
 * this file exists to be right about. It cannot be injected once and shared:
 * the renderer runs under a strict CSP (csp.spec.ts) with no `unsafe-eval`, so
 * a helper cannot be reconstituted inside the page.
 *
 * Three things it does that reading the token files cannot:
 *  • it COMPOSITES the whole stack — every translucent background between the
 *    word and the first opaque one, in order. Skipping to the first opaque
 *    ancestor and measuring against that is optimistic: the rail's needy row is
 *    a 10% tint over `--rail-card`, and ignoring the tint reports ~1 point more
 *    contrast than is on screen. This is the exact mistake `.collapsed-row` was
 *    rewritten to make computable, so the harness had better not make it.
 *  • it folds in every `opacity`, INCLUDING the one on the element that
 *    supplies the background — group opacity does not preserve contrast, it
 *    fades the text and the fill toward whatever is behind BOTH of them. The
 *    events panel's reviewed rows were the worked example (`--panel2` at 0.82)
 *    until #268 replaced that opacity with a `color-mix` the token tests can
 *    read; the arithmetic stays because the next one will not announce itself,
 *    and because a `color-mix` fill is the OTHER thing this composites.
 *  • it reads the token NAME off an inline style where there is one, which is
 *    the only way to tell `--status-working` from `--accent-blue` — the same
 *    pixels, different meanings (see the sweep below).
 */
const auditWords = (opts: { ramp: string[]; only?: string }): Audit => {
  // rgb()/rgba() come back 0-255, but anything that went through color-mix()
  // arrives as color(srgb r g b) in 0-1 floats. Reading the second as 0-255
  // scores every mixed colour as black — a false PASS for dark ink, which is
  // exactly the case this exists for. Returns [r, g, b, a], all 0-1.
  const rgba = (c: string): number[] => {
    const n = (c.match(/[\d.]+/g) ?? ['0', '0', '0', '0']).map(Number);
    const [r, g, b] = c.startsWith('color(') ? n : n.slice(0, 3).map((v) => v / 255);
    return [r, g, b, n.length > 3 ? n[3] : 1];
  };
  const over = (top: number[], alpha: number, under: number[]): number[] =>
    under.map((u, i) => top[i] * alpha + u * (1 - alpha));
  const lum = (c: number[]): number => {
    const f = (s: number): number => (s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
  };
  const named = (el: Element): string =>
    el.tagName.toLowerCase() +
    (typeof el.className === 'string' && el.className.trim()
      ? '.' + el.className.trim().split(/\s+/).join('.')
      : '') +
    ' "' +
    (el.textContent ?? '').trim().slice(0, 30) +
    '"';

  const cs = getComputedStyle(document.documentElement);
  const norm = (c: string): string => {
    const t = c.trim();
    if (t.startsWith('#')) {
      const h = t.slice(1);
      const p =
        h.length === 3 ? [...h].map((x) => x + x) : [h.slice(0, 2), h.slice(2, 4), h.slice(4, 6)];
      return p.map((x) => parseInt(x, 16)).join(',');
    }
    return rgba(t)
      .slice(0, 3)
      .map((v) => Math.round(v * 255))
      .join(',');
  };
  // a hue is only DISTINGUISHABLE from its ink where the theme gives them
  // different values; where they are equal there is no defect to find
  const hueNames = new Map<string, string>();
  const inks = new Set<string>();
  for (const s of opts.ramp) {
    const hue = norm(cs.getPropertyValue('--status-' + s));
    const ink = norm(cs.getPropertyValue('--status-' + s + '-ink'));
    inks.add(ink);
    if (hue !== ink) hueNames.set(hue, '--status-' + s);
  }
  // §5.11 SESSION ACCENTS, read out of the stylesheet so a ninth needs no edit.
  //
  // Four of the eight are byte-identical to a status hue — `--accent-amber` IS
  // `--status-needs-input`, `--accent-blue` IS `--status-working` — and a
  // session's accent arrives as a raw hex from the main process
  // (sessions/identity.ts), so a card's identity badge is the same pixels as a
  // needs-input word with no name attached to tell them apart. Where there is
  // no inline colour to read a name off, such a word is SKIPPED ENTIRELY,
  // ratio included. The trade is measured, not assumed: reverting the tool
  // block's inline colour to `var(--status-working)` still fails here by name,
  // while reverting the CSS rule `.feed-md a` to the same hue does not — that
  // case belongs to the source scan in tokens.drift.test.ts, which reads names
  // for every site in the tree and never has to guess.
  //
  // #269 narrowed what this costs. The badge that made the skip load-bearing —
  // an accent painted as 9px text, 1.80-3.11:1 on daylight — now writes
  // `var(--accent-ink-on-fill)` on an accent FIELD, so it arrives with a name
  // and is measured like anything else. What is still skipped is a word whose
  // colour merely EQUALS an accent with nothing naming it, which after #269 is
  // no known site.
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
        // the palette, not everything spelled `--accent-`: the on-field INK
        // shares that prefix and is also `--bar` on nordic and the
        // needs-permission on-fill ink in every theme, so sweeping it into the
        // skip set would quietly excuse three unrelated tokens
        if (prop.startsWith('--accent-') && !prop.endsWith('-ink-on-fill')) {
          accents.add(norm(style.getPropertyValue(prop)));
        }
      }
    }
  }

  const out: Word[] = [];
  for (const el of Array.from(document.querySelectorAll(opts.only ?? '*'))) {
    // WORDS only: an element with no text node of its own paints none, and
    // every child would otherwise be counted again for its parent's inherited
    // colour
    const words = Array.from(el.childNodes).some(
      (n) => n.nodeType === 3 && (n.textContent ?? '').trim() !== ''
    );
    if (!words) continue;
    // …and WORDS means letters or digits. A lone glyph (the rail's ✕, a ⌄
    // disclosure) is an icon that happens to be a character: it belongs to
    // 1.4.11's 3:1 for graphical objects, exactly like the lamp's dot and
    // ring, not to a text sweep. Without this, a chrome token that happens to
    // share bytes with a status hue flags a defect that is not there —
    // nordic's --rail-close IS the shared --status-idle value, and the ✕ wore
    // it honestly for months while this sweep sampled mid-`transition: color`
    // and read the previous theme's value instead (caught on CI 2026-08-05,
    // which is also why transitions are now disabled before sampling: the
    // green was luck, in both directions).
    const ownText = Array.from(el.childNodes)
      .filter((n) => n.nodeType === 3)
      .map((n) => n.textContent ?? '')
      .join('');
    if (!/[\p{L}\p{N}]/u.test(ownText)) continue;
    const box = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    if (box.width === 0 || box.height === 0 || style.visibility === 'hidden') continue;

    // the token this element was HANDED, when it was handed one. A name cannot
    // collide; a colour value can.
    //
    // `--accent-*` is read here too since #269, and it is worth being precise
    // about what that buys. The §5.11 badge writes `--accent-ink-on-fill`
    // inline; without the name, that word falls into the value-matching branch
    // below, is recognised as neither a hue nor a status ink, and is SKIPPED —
    // so the fix would ship unmeasured. That is the reason.
    //
    // What it does NOT buy is catching the revert. A session's accent reaches
    // the renderer as a raw hex from the main process, so `color: live.accent`
    // computes to `#db61a2` with no name attached and lands in the accent skip
    // below (which exists precisely because a VALUE cannot be told apart from a
    // status hue). What catches THAT is the `"JS"` entry in this sweep's site
    // list — the badge drops out of the words measured — and the focused badge
    // test above. A named `color: var(--accent-pink)` would fail here; that is a
    // stylesheet spelling nothing in the tree currently uses.
    const token = /var\((--(?:status|accent)-[a-z-]+)\)/.exec(
      (el as HTMLElement).style?.color ?? ''
    );
    const colour = norm(style.color);
    // `-ink` OR `-ink-on-fill`: both on-fill inks end in the latter, and reading
    // only the former would score them as hues and fail every theme
    let hue: string | null = token && !/-ink(-on-fill)?$/.test(token[1]) ? token[1] : null;
    if (!opts.only && !token) {
      if (accents.has(colour)) continue;
      hue = hueNames.get(colour) ?? null;
      if (!hue && !inks.has(colour)) continue;
    }

    // the stack, innermost first, then composited outermost-in so that every
    // translucent layer and every group opacity lands in the right order
    const stack: Array<{ el: Element; bg: number[]; op: number }> = [];
    for (let n: Element | null = el; n; n = n.parentElement) {
      const s = getComputedStyle(n);
      stack.push({ el: n, bg: rgba(s.backgroundColor), op: Number(s.opacity) });
    }
    let cumulative = 1;
    let surface = [1, 1, 1]; // the canvas behind the document
    let from = 'nothing opaque';
    for (let i = stack.length - 1; i >= 0; i--) {
      cumulative *= stack[i].op;
      const alpha = stack[i].bg[3] * cumulative;
      if (alpha > 0) surface = over(stack[i].bg, alpha, surface);
      // the LAST layer that covers what is behind it is the one a reader would
      // name as "what this word is on"
      if (alpha >= 0.99) {
        from =
          i === 0
            ? 'self'
            : (stack[i].el.getAttribute('data-testid') ??
              (typeof stack[i].el.className === 'string' && stack[i].el.className.trim()
                ? stack[i].el.className.trim()
                : stack[i].el.tagName.toLowerCase()));
      }
    }
    const ink = rgba(style.color);
    const text = over(ink, ink[3] * cumulative, surface);
    const [a, b] = [lum(text), lum(surface)];
    out.push({
      what: named(el),
      from,
      hue,
      ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05),
      why: `${style.color} at opacity ${cumulative.toFixed(2)} on rgb(${surface
        .map((v) => Math.round(v * 255))
        .join(',')}) (from ${from})`,
    });
  }
  return { words: out, distinguishable: hueNames.size > 0 };
};

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

      const seen = await w.evaluate(auditWords, { ramp: [...STATUS_TOKENS], only: '.status-pill' });
      expect(seen.words.length, `${id}: no pill was measured`).toBeGreaterThan(0);
      for (const word of seen.words) {
        // the pill's own fill is opaque by design (#221), so the composite
        // should end on the pill itself — a stack that had to reach the header
        // would mean the fill went transparent again, and the ratio would be
        // measured against a surface the user never sees through it
        expect(word.from, `${id}: the pill's own fill must be what the word sits on`).toBe('self');
        expect(word.hue, `${id}: the pill must paint its ink, never its hue`).toBeNull();
        expect(word.ratio, `${id} status pill contrast — ${word.why}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  test('the identity badge is legible in every theme, as painted (#269)', async () => {
    // The unit tests measure the ink against the eight accents in the file. Only
    // the window can say that the badge really is a FIELD — that the accent
    // reaching the renderer as a raw hex from the main process ends up in the
    // background and not in the `color`, at BOTH render sites (§5.11's "renders
    // identically everywhere": the card's dockview tab and the card header).
    //
    // The seeded folder gets a package.json so the badge reads `JS`. It matters:
    // `tempProjectFolder()` alone detects nothing and the badge is `·`, which the
    // sweep correctly refuses to count as a word — the test would pass having
    // measured no badge at all.
    const folder = tempProjectFolder();
    fs.writeFileSync(path.join(folder, 'package.json'), '{}\n');
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    const badge = w.getByTestId('identity-badge').first();
    await expect(badge).toBeVisible({ timeout: 25_000 });
    await expect(badge).toHaveText('JS');

    // WHICH COLOUR WENT WHERE, at the render site, with the real accent the main
    // process assigned. The ratio loop below cannot say this: a badge painted
    // dark-on-dark would fail it, but a badge that simply dropped the field and
    // kept a legible ink would pass while the identity signal was gone. Read off
    // the inline style, so the accent is the raw hex `sessions/identity.ts`
    // handed over rather than a token this test could have spelled itself.
    const paint = await badge.evaluate((el) => ({
      color: (el as HTMLElement).style.color,
      background: (el as HTMLElement).style.background,
    }));
    expect(paint.color, 'the badge writes the one measured on-field ink').toBe(
      'var(--accent-ink-on-fill)'
    );
    expect(paint.background, 'the accent is the FIELD — a real colour, not a token').toMatch(
      /^(#|rgb)/
    );

    // The sweep disables transitions before sampling for a real reason (#246's
    // hand-off: a mid-`transition: color` sample reads the previous theme).
    // Nothing this test measures transitions today, but the next person will
    // copy it, so it samples end states too.
    await w.addStyleTag({
      content: '*, *::before, *::after { transition: none !important; }',
    });

    for (const [label, id] of THEMES) {
      await w.getByRole('button', { name: label, exact: true }).click();
      await expect(w.locator('html')).toHaveAttribute('data-theme-id', id);

      const seen = await w.evaluate(auditWords, {
        ramp: [...STATUS_TOKENS],
        only: '[data-testid="identity-badge"]',
      });
      // both sites, not one: the header's badge and the tab's are the defect and
      // the regression risk respectively, and a single one measured would let
      // the other drift back
      expect(seen.words.length, `${id}: fewer than two badges were measured`).toBeGreaterThan(1);
      // NOT covered here, and worth knowing: the accent-LESS branch
      // (`--text` on `--chip`, for a card whose record has not been read yet).
      // Every seeded session has an accent, so only the drift test's
      // "the accent-less badge" case measures that pair.
      for (const word of seen.words) {
        expect(word.from, `${id}: the badge's own field must be what the word sits on`).toBe('self');
        // fires on the stylesheet spelling of the revert (`color:
        // var(--accent-pink)`); the raw-hex spelling is caught by `from` and the
        // ratio, both mutation-checked 2026-08-10
        expect(word.hue, `${id}: the badge must paint its ink, never an accent`).toBeNull();
        expect(word.ratio, `${id} identity badge contrast — ${word.why}`).toBeGreaterThanOrEqual(
          4.5
        );
      }
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
    //
    // The package.json is for the §5.11 badge (#269), and it is not decoration:
    // a folder with no project marker gets the badge `·`, which this sweep
    // rightly refuses to count as a word — so the badge was never among the
    // words measured at all, and a revert passed here. With `JS` in it the badge
    // joins the site list below, and a revert to `color: live.accent` fails
    // because the badge stops being one of the words measured (its colour is
    // then a bare accent value, which the skip drops). Mutation-checked both
    // ways, 2026-08-10.
    const folder = tempProjectFolder();
    fs.writeFileSync(path.join(folder, 'package.json'), '{}\n');
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

    // Colours are sampled the instant the theme attribute lands, and several
    // controls transition `color` over ~0.1s (.rail-x, .collapsed-row …). A
    // sample taken mid-transition reads the OLD theme's value — and nordic's
    // --rail-close is byte-equal to the shared --status-idle, so on a slow
    // runner the rail's ✕ flags as "a hue on words" while daylight is active
    // (caught on CI, 2026-08-05). This sweep measures END states; transitions
    // are animation, not intent, so they are off for the sampling.
    await w.addStyleTag({
      content: '*, *::before, *::after { transition: none !important; }',
    });

    const distinguishable = new Set<string>();
    for (const [label, id] of THEMES) {
      await w.getByRole('button', { name: label, exact: true }).click();
      await expect(w.locator('html')).toHaveAttribute('data-theme-id', id);

      const seen = await w.evaluate(auditWords, { ramp: [...STATUS_TOKENS] });

      const hues = seen.words.filter((x) => x.hue).map((x) => `${x.hue} on ${x.what}`);
      expect(hues, `${id}: a HUE (status or §5.11 accent) is being used as a text colour`).toEqual(
        []
      );
      const dim = seen.words
        .filter((x) => x.ratio < 4.5)
        .map((x) => `${x.what} = ${x.ratio.toFixed(2)}:1 — ${x.why}`);
      expect(dim, `${id}: status-inked words below 4.5:1 as painted`).toEqual([]);

      // The sweep's own guard, and it is not a formality: a walk that matched
      // nothing passes both assertions above without looking at a single word,
      // and that is exactly what a broken filter or a fixture that stopped
      // rendering the feed would look like. Named sites, not a count, so a
      // sweep that quietly stops reaching the feed fails instead of shrinking.
      const measured = seen.words.map((x) => x.what).join(' | ');
      for (const site of ['.status-pill', 'a "the manual"', '"Read"', '"[x]"', '"JS"']) {
        expect(measured, `${id}: ${site} was not among the words measured`).toContain(site);
      }
      if (seen.distinguishable) distinguishable.add(id);
    }

    // The hue half of this test is only ASKABLE where a theme gives a status
    // its own ink — high contrast and soft contrast set ink == hue, so there is
    // nothing to tell apart in either. Derived from the themes rather than
    // exempted by name (a renamed theme would otherwise fail for a non-defect),
    // and asserted once at the end so that a change making ink == hue
    // EVERYWHERE could not silently turn the whole check into a no-op.
    expect(distinguishable.size, 'no theme distinguishes a status ink from its hue').toBeGreaterThan(
      0
    );
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
