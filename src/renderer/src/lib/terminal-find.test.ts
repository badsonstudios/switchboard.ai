// @vitest-environment jsdom
// THE VERSION VERDICT, PINNED (P2-E17-03, #415).
//
// The item's first instruction was to verify `@xterm/addon-search` at RUNTIME
// before building on it: 0.16.0 is the `latest` tag, declares no peer
// dependency, and predates `@xterm/xterm@6.0.0` (the 0.17 line is beta-only and
// pins `^6.1.0-beta`), so npm's willingness to install it proves nothing.
//
// So this file builds a REAL `Terminal` and a REAL `SearchAddon` — no mocks, no
// fakes — writes enough output to push most of it into scrollback, and asserts
// the contract `lib/terminal-find.ts` is written against. The day an upgrade
// breaks the pairing, this is what goes red, with the failure naming the exact
// call that stopped working.
//
// THE ONE CONDITION IT FOUND: match decorations go through
// `Terminal.registerDecoration`, which is PROPOSED API in xterm 6. Without
// `allowProposedApi: true` the addon does not degrade — `findNext` THROWS. The
// last case here is the one that matters most in production: with the flag off,
// find still returns the right matches, because every addon call is wrapped.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Terminal } from '@xterm/xterm';
import { SearchAddon } from '@xterm/addon-search';
// The addon's decoration API demands literal `#RRGGBB` (production reads the
// live `--chip` token instead — see `decorations()`), so these two cases have
// to hand it one to drive it directly. Scoped to this file's raw-addon probes.
/* eslint-disable no-restricted-syntax -- literal hex is the addon's own API */
import {
  offsetInLine,
  revealTerminalMatch,
  searchTerminal,
  snippetAround,
  clearTerminalSearch,
} from './terminal-find';

/**
 * jsdom has no `matchMedia`, and xterm's `CoreBrowserService` calls it while
 * measuring device pixel ratio — `term.open()` throws without this. Shimmed
 * here rather than in `test-setup.ts` because `theme.ts` reads the real thing
 * and a global shim would quietly answer "dark" for every other suite.
 */
function shimMatchMedia(): void {
  (window as unknown as Record<string, unknown>).matchMedia = () => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  });
}

let term: Terminal;
let addon: SearchAddon;
let host: HTMLDivElement;

function make(options: { allowProposedApi?: boolean } = {}): void {
  host = document.createElement('div');
  document.body.appendChild(host);
  term = new Terminal({
    cols: 80,
    rows: 10,
    scrollback: 5000,
    allowProposedApi: options.allowProposedApi ?? true,
  });
  addon = new SearchAddon();
  term.loadAddon(addon);
  term.open(host);
}

function write(data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve));
}

/** 40 lines, so 30 of them are in SCROLLBACK behind a 10-row viewport. */
async function seed(): Promise<void> {
  for (let i = 0; i < 40; i += 1) {
    await write(`line ${i} ${i % 4 === 0 ? 'NEEDLE' : 'straw'}\r\n`);
  }
}

beforeEach(() => {
  shimMatchMedia();
  document.body.innerHTML = '';
});

afterEach(() => {
  term?.dispose();
});

describe('@xterm/addon-search 0.16.0 against @xterm/xterm 6.0.0', () => {
  it('finds matches that have scrolled OUT of the viewport — the whole point', async () => {
    make();
    await seed();
    // the viewport holds 10 rows of 40: everything below row 30 is scrollback
    expect(term.buffer.active.baseY).toBeGreaterThan(0);

    const out = searchTerminal(term, addon, { term: 'NEEDLE' });

    expect(out.total).toBe(10); // rows 0, 4, 8 … 36
    expect(out.matches).toHaveLength(10);
    expect(out.truncated).toBe(false);
    // the first match is in scrollback, and it is addressable
    expect(out.matches[0].row).toBe(0);
    expect(out.matches[0].row).toBeLessThan(term.buffer.active.baseY);
    expect(out.matches[0].line).toBe('line 0 NEEDLE');
    expect(out.matches[0].line.slice(out.matches[0].offset, out.matches[0].offset + 6)).toBe('NEEDLE');
    // …and they come back in buffer order, which is what makes stepping sane
    expect(out.matches.map((m) => m.row)).toEqual([0, 4, 8, 12, 16, 20, 24, 28, 32, 36]);
  });

  it('agrees with the addon’s OWN tally — our walk is not a second search', async () => {
    make();
    await seed();
    // drive the addon directly and read the count it publishes, then compare
    let counted = -1;
    const sub = addon.onDidChangeResults((e) => {
      counted = e.resultCount;
    });
    term.clearSelection();
    addon.findNext('NEEDLE', {
      decorations: {
        matchBackground: '#39414f',
        activeMatchBackground: '#39414f',
        matchOverviewRuler: '#39414f',
        activeMatchColorOverviewRuler: '#39414f',
      },
    });
    sub.dispose();

    expect(counted).toBe(searchTerminal(term, addon, { term: 'NEEDLE' }).total);
  });

  it('honours case and whole-word, which is why we took the dependency', async () => {
    make();
    await write('Needle needles NEEDLE\r\n');

    // …and the calls run BACK TO BACK on one addon on purpose: the addon skips
    // re-highlighting when neither the term nor the options changed, so a
    // toggle of Aa or ab| that failed to invalidate would have the bar
    // reporting a stale count with full confidence. Each line below changes
    // only the options.
    expect(searchTerminal(term, addon, { term: 'needle' }).total).toBe(3);
    // "needles" contains a lower-case "needle"; "Needle" and "NEEDLE" do not
    expect(searchTerminal(term, addon, { term: 'needle', caseSensitive: true }).total).toBe(1);
    expect(searchTerminal(term, addon, { term: 'Needle', caseSensitive: true }).total).toBe(1);
    expect(searchTerminal(term, addon, { term: 'needle' }).total).toBe(3);
  });

  it('whole word: an UPSTREAM defect, characterised and pinned rather than guessed at', async () => {
    // Found while writing the case above, and it is the addon's, not ours:
    // with `wholeWord`, a row is ABANDONED at the first non-whole-word
    // candidate on it, so a real whole-word match sitting after one is never
    // reached. Probed against the raw addon (no code of ours in the path),
    // @xterm/addon-search 0.16.0 + @xterm/xterm 6.0.0, 2026-08-13.
    //
    // It is a narrow undercount on ONE option — the plain and case-sensitive
    // searches are exact, and the poisoning does not cross rows — so the
    // toggle still ships: a whole-word button that quietly did nothing on the
    // Terminal would be the bigger lie. Pinned here so that the day an upgrade
    // fixes it, this test says so out loud instead of nobody noticing.
    make();
    await write('aa needles bb needle cc\r\n'); // candidate BEFORE the real match
    await write('dd needle ee needles ff\r\n'); // candidate AFTER it
    await write('gg needle hh\r\n');

    const out = searchTerminal(term, addon, { term: 'needle', wholeWord: true });
    // rows 1 and 2 are found; row 0's genuine whole-word match at col 14 is not
    expect(out.matches.map((m) => m.row)).toEqual([1, 2]);
    expect(out.total).toBe(2); // the honest answer is 3
  });

  it('a walk that hits its CEILING reports a floor, never a total', async () => {
    // The addon's own tally is capped at its `highlightLimit` (1000) and the
    // walk is capped with it, so past that point NOBODY knows the answer.
    // Reporting the cap as a count would be the wrong-total-told-confidently
    // failure the whole item is built around. Driven here with a tiny ceiling
    // rather than 1,000 matches; the arithmetic is the same.
    make();
    await seed(); // 10 matches
    const out = searchTerminal(term, addon, { term: 'NEEDLE' }, 200, 4);

    expect(out.totalIsFloor).toBe(true);
    expect(out.total).toBe(4); // "4+", which the bar renders with a plus
    expect(out.matches).toHaveLength(4);

    // …and a walk that DOES close the loop is exact, not a floor
    expect(searchTerminal(term, addon, { term: 'NEEDLE' }).totalIsFloor).toBe(false);
  });

  it('refuses to reveal a match whose row has been evicted under it', async () => {
    // the buffer is a RING: on a busy session, a row recorded a minute ago now
    // holds different text, and selecting it would jump to something that is
    // not the match while the list still showed the old snippet
    make();
    await seed();
    const out = searchTerminal(term, addon, { term: 'NEEDLE' });
    const stale = { ...out.matches[1], line: 'line 4 SOMETHINGELSE', offset: 7, length: 13 };
    expect(revealTerminalMatch(term, stale)).toBe(false);
    expect(revealTerminalMatch(term, out.matches[1])).toBe(true);
  });

  it('a term that is not there is zero matches, not an error', async () => {
    make();
    await seed();
    expect(searchTerminal(term, addon, { term: 'nothing-like-this' })).toEqual({
      matches: [],
      total: 0,
      truncated: false,
      totalIsFloor: false,
    });
    expect(searchTerminal(term, addon, { term: '' }).total).toBe(0);
  });

  it('caps the LIST but never the COUNT — a capped number told as the total is the lie', async () => {
    make();
    await seed();
    const out = searchTerminal(term, addon, { term: 'NEEDLE' }, 3);
    expect(out.matches).toHaveLength(3);
    expect(out.total).toBe(10);
    expect(out.truncated).toBe(true);
  });

  it('leaves the terminal on the FIRST match, selected — "highlights and steps"', async () => {
    make();
    await seed();
    searchTerminal(term, addon, { term: 'NEEDLE' });
    expect(term.getSelection()).toBe('NEEDLE');
    expect(term.getSelectionPosition()?.start.y).toBe(0);
  });

  it('reveals a collected match: scrolls to it and selects it', async () => {
    make();
    await seed();
    const out = searchTerminal(term, addon, { term: 'NEEDLE' });
    const last = out.matches[out.matches.length - 1];

    expect(revealTerminalMatch(term, last)).toBe(true);
    expect(term.getSelection()).toBe('NEEDLE');
    expect(term.getSelectionPosition()?.start.y).toBe(last.row);
    // scrolled so the match is on screen, not merely selected off it
    expect(term.buffer.active.viewportY).toBeLessThanOrEqual(last.row);
    expect(term.buffer.active.viewportY + term.rows).toBeGreaterThan(last.row);

    // a row that no longer exists is a refusal, not a throw
    expect(revealTerminalMatch(term, { ...last, row: 99_999 })).toBe(false);
  });

  it('paints decorations when the theme token resolves — the production path', async () => {
    // Every other case here runs the UNdecorated path by accident: jsdom
    // resolves no custom properties, so `decorations()` declines. Give it one
    // and the real path runs, proposed API and all.
    make();
    await seed();
    term.element!.style.setProperty('--chip', '#39414f');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const out = searchTerminal(term, addon, { term: 'NEEDLE' });

    expect(out.total).toBe(10);
    expect(out.matches).toHaveLength(10);
    expect(warn).not.toHaveBeenCalled(); // nothing degraded
    warn.mockRestore();
  });

  it('clearing drops the selection and the highlights', async () => {
    make();
    await seed();
    searchTerminal(term, addon, { term: 'NEEDLE' });
    expect(term.getSelection()).not.toBe('');
    clearTerminalSearch(term, addon);
    expect(term.getSelection()).toBe('');
  });

  it('WITHOUT allowProposedApi the addon THROWS — and find degrades instead', async () => {
    // The condition the probe found, and the reason `TerminalPane` sets the
    // flag. Proven both ways: the raw call is fatal, ours is not.
    make({ allowProposedApi: false });
    await seed();
    // decorations are only ASKED for when the theme token resolves, and jsdom
    // resolves no custom properties of its own — so set one, or this case
    // would take the "no highlights wanted" path and prove nothing
    term.element!.style.setProperty('--chip', '#39414f');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(() =>
      addon.findNext('NEEDLE', {
        decorations: {
          matchBackground: '#39414f',
          activeMatchBackground: '#39414f',
          matchOverviewRuler: '#39414f',
          activeMatchColorOverviewRuler: '#39414f',
        },
      }),
    ).toThrow(/allowProposedApi/);

    // …and the module still answers, with the right matches and no highlights
    const out = searchTerminal(term, addon, { term: 'NEEDLE' });
    expect(out.total).toBe(10);
    expect(out.matches).toHaveLength(10);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('the snippet arithmetic', () => {
  it('picks the occurrence nearest the cell the addon reported', () => {
    // three matches on one row: the offset must follow the column, or every
    // row's <mark> would land on the first occurrence
    const line = 'aa needle bb needle cc needle';
    expect(offsetInLine(line, 'needle', 3)).toBe(3);
    expect(offsetInLine(line, 'needle', 13)).toBe(13);
    expect(offsetInLine(line, 'needle', 23)).toBe(23);
  });

  it('is case-insensitive unless asked, and falls back to the column it was given', () => {
    expect(offsetInLine('the NEEDLE here', 'needle', 4)).toBe(4);
    expect(offsetInLine('the NEEDLE here', 'needle', 4, true)).toBe(4); // no match → clamped column
    expect(offsetInLine('short', 'needle', 99)).toBe(5);
  });

  it('windows a very long row around the match rather than pasting 500 columns in', () => {
    const line = `${'x'.repeat(400)}NEEDLE${'y'.repeat(400)}`;
    const { snippet, matchStart } = snippetAround(line, 400, 6);
    expect(snippet.length).toBeLessThan(line.length);
    expect(snippet.slice(matchStart, matchStart + 6)).toBe('NEEDLE');
    expect(snippet.startsWith('…')).toBe(true);
    expect(snippet.endsWith('…')).toBe(true);
  });

  it('leaves a short row alone', () => {
    expect(snippetAround('line 0 NEEDLE', 7, 6)).toEqual({ snippet: 'line 0 NEEDLE', matchStart: 7 });
  });
});
