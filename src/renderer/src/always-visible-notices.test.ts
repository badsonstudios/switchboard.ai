// Every always-visible bar in the app shell keeps its height (#274).
//
// THE MECHANISM
// -------------
// App's root element is a `100vh` flex COLUMN. Its main area is `flex: 1` —
// which is `flex: 1 1 0%`, a basis of ZERO. Negative free space in a flex
// container is distributed in proportion to each item's shrink factor times
// its basis, so an item with a basis of 0 absorbs NOTHING: in a short window
// every missing pixel comes off the auto-basis children instead. Those are the
// bars and notices stacked above and below the workspace — exactly the
// surfaces whose contract is that they are always there to be read.
//
// WHY THIS FILE EXISTS
// --------------------
// The guard is one declaration and it has been forgotten three times.
// `WorkspaceReadOnlyBanner` carried it from #168 but nothing checked it, so
// deleting it stayed green. `.preflight-banner` did not carry it at all until
// #241, which made the "claude wasn't found" warning the one that got squeezed
// in the very case where two notices are up at once. The two strips and the
// two chrome bars never had it. Fixing four files and pinning one of them
// would just queue the fifth up, so this is a ROSTER: one list of every
// always-visible child of the shell column, and — below it — a scan of App.tsx
// that fails when a child appears in neither this list nor the exemptions.
// A future notice added without a guard has to be classified here first.
//
// WHY THE WITNESS IS THE SOURCE TEXT
// ----------------------------------
// Because for half the roster there is no other witness. jsdom loads no CSS,
// so `.preflight-banner`'s rule is unreachable from a rendered test (#241),
// and no e2e fixture can even make the preflight banner appear — that needs
// the built app launched with `claude` off PATH (#222). Reading the style
// block's text is what the drift tests already do for the same reason, and it
// applies uniformly to a CSS rule, a `React.CSSProperties` const and a style
// object written inline in JSX. It also costs nothing when a component's props
// change, which a rendered roster of six components would.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/** a file's text, newline-normalized — a two-line anchor must match on CRLF
 *  too. `.gitattributes` pins checkouts to LF (#280); this is insurance for a
 *  working copy that predates it. */
function read(rel: string): string {
  return fs.readFileSync(path.join(__dirname, rel), 'utf8').replace(/\r\n/g, '\n');
}

const APP = read('App.tsx');

/**
 * The text of one style block, from its opening anchor to its closing text.
 *
 * The anchor has to appear EXACTLY once. This is a substring lookup, so a
 * second occurrence would silently resolve to whichever comes first and the
 * assertion below it would be measuring a different block than it names.
 */
function styleBlock(src: string, file: string, from: string, to: string): string {
  const start = src.indexOf(from);
  expect(start, `anchor not found in ${file}: ${from}`).toBeGreaterThan(-1);
  expect(
    src.split(from).length - 1,
    `anchor matches more than one place in ${file} — reword it: ${from}`
  ).toBe(1);
  const end = src.indexOf(to, start);
  expect(end, `anchor in ${file} is never closed by ${JSON.stringify(to)}: ${from}`).toBeGreaterThan(
    -1
  );
  return src.slice(start, end);
}

/** the longhand specifically, in both spellings. `flex: 0 0 auto` would paint
 *  the same, but this is a one-line promise and a shorthand is where it goes to
 *  be lost inside a later edit that only meant to change the basis. */
const CSS_GUARD = /^\s*flex-shrink:\s*0\s*;/m;
const INLINE_GUARD = /^\s*flexShrink:\s*0\s*,/m;

type Notice = {
  /** the name App.tsx renders it by — the key the shell scan matches on */
  component: string;
  /** the file the guard lives in, relative to this one */
  file: string;
  /** first text of the style block that must carry it */
  from: string;
  /** the text that closes that block */
  to: string;
  /** which spelling of the declaration this block is written in */
  guard: RegExp;
  /** what is lost when it shrinks — the reason it is on the roster */
  why: string;
};

/**
 * Every always-visible child of the shell column. Add a bar to App and it goes
 * here; the scan below will not let it be skipped.
 *
 * Three shapes of style block are represented and the roster does not care
 * which: a `React.CSSProperties` const (`const x: ... = {` … `\n};`), a style
 * object written inline in JSX (anchored on the element's `data-testid`, closed
 * by the `>` that ends its opening tag), and a CSS rule in tokens.css.
 */
const NOTICES: readonly Notice[] = [
  {
    component: 'TitleBar',
    file: 'components/chrome.tsx',
    from: 'const barStyle: React.CSSProperties = {',
    to: '\n};',
    guard: INLINE_GUARD,
    why: 'the app name, the build stamp and every global toggle',
  },
  {
    component: 'StatusBar',
    file: 'components/chrome.tsx',
    // the same const: the footer spreads `barStyle`, which the test below
    // holds it to, so one declaration guards both bars
    from: 'const barStyle: React.CSSProperties = {',
    to: '\n};',
    guard: INLINE_GUARD,
    why: 'the session count, the CLI version and every contributed readout',
  },
  {
    component: 'WorkspaceReadOnlyBanner',
    file: 'components/WorkspaceReadOnlyBanner.tsx',
    from: 'const banner: React.CSSProperties = {',
    to: '\n};',
    guard: INLINE_GUARD,
    // #168. Issue numbers stay in comments throughout this list: they are
    // hex-colour-shaped, and the lint rule that keeps raw hex out of the
    // renderer cannot tell the difference inside a string literal.
    why: 'the only warning that nothing done this run will be saved',
  },
  {
    component: 'PreflightBanner',
    file: 'theme/tokens.css',
    from: '.preflight-banner {',
    to: '\n}',
    guard: CSS_GUARD,
    // #222 gave it a live region, #241 gave it this guard
    why: 'the only statement of why no session will ever start',
  },
  {
    component: 'UrgencyStrip',
    file: 'components/UrgencyStrip.tsx',
    from: 'data-testid="urgency-strip"',
    to: '\n    >',
    guard: INLINE_GUARD,
    why: 'every session at a glance — §5.8 calls it persistent',
  },
  {
    component: 'CollapsedStrip',
    file: 'components/CollapsedStrip.tsx',
    from: 'data-testid="collapsed-strip"',
    to: '\n    >',
    guard: INLINE_GUARD,
    why: 'the only place a collapsed session is listed outside the rail (§5.8)',
  },
];

/**
 * The shell column's other children, and why none of them is a notice.
 *
 * Stated rather than filtered: "it is a dialog" is a claim about the code, and
 * a claim written down here is one a reader can check against the component.
 */
const NOT_A_NOTICE: Readonly<Record<string, string>> = {
  AboutPanel:
    'a modal — returns null when closed and is `position: fixed` when open, so it is never an in-flow flex child',
  UpdateDialog: 'a modal, same as AboutPanel',
  CommandPalette: 'a modal, same as AboutPanel',
  div: 'the workspace itself — `flex: 1` with a basis of 0. It is the thing that is SUPPOSED to give way; that is the whole mechanism',
};

/** the exemptions are keyed by TAG NAME, so `div` would quietly cover a second
 *  bare div added to the column. There is one, and it is the workspace; a new
 *  one has to be named (a component) before it can be classified. */
const BARE_DIVS_ALLOWED = 1;

describe('every always-visible bar in the shell keeps its height', () => {
  it.each(NOTICES)('$component declares the shrink guard ($why)', (n) => {
    expect(
      styleBlock(read(n.file), n.file, n.from, n.to),
      `${n.component} must declare a shrink guard in ${n.file} — without it a ` +
        `short window squeezes it instead of the workspace below, and what is ` +
        `lost is ${n.why}`
    ).toMatch(n.guard);
  });

  // TitleBar and StatusBar share one declaration because StatusBar spreads the
  // const. That is only true while it does: pin the spread, or dropping it
  // would leave the footer unguarded with this roster still green.
  it('StatusBar is guarded because it spreads barStyle', () => {
    expect(
      styleBlock(
        read('components/chrome.tsx'),
        'components/chrome.tsx',
        'export function StatusBar(',
        '\n}\n'
      ),
      'StatusBar no longer spreads barStyle, so it no longer inherits the ' +
        'shrink guard — give the footer its own, and split the roster entry'
    ).toMatch(/\.\.\.barStyle/);
  });
});

// --- The completeness half --------------------------------------------------
//
// The roster above is only worth having if it cannot go stale. Every direct
// child of the shell column is indented six spaces (App's `return (` puts the
// root element at four), so they can be read straight off the file — and every
// one of them has to be either rostered or exempted by name.
const shellChildren = [...APP.matchAll(/^ {6}<([A-Za-z][\w]*)/gm)].map((m) => m[1]);

describe('the roster covers the shell column', () => {
  // the scan is indentation-based, so it has to be able to fail LOUDLY rather
  // than quietly matching nothing and passing every test below it vacuously
  it('still finds the shell column', () => {
    expect(
      shellChildren.length,
      'the six-space scan of App.tsx found almost nothing — App was reformatted ' +
        'or restructured, and until the scan is fixed nothing below it means anything'
    ).toBeGreaterThanOrEqual(8);
    expect(shellChildren).toContain('TitleBar');
  });

  it('every child of the column is a rostered notice or a stated exemption', () => {
    const known = new Set([...NOTICES.map((n) => n.component), ...Object.keys(NOT_A_NOTICE)]);
    expect(
      shellChildren.filter((c) => !known.has(c)),
      'a new child of the shell column is neither on the notice roster nor in ' +
        'NOT_A_NOTICE. If it is always visible it needs `flexShrink: 0` and a ' +
        'roster entry; if it is a modal or the workspace itself, say so in ' +
        'NOT_A_NOTICE with the reason'
    ).toEqual([]);
  });

  it('has exactly one bare div in the column — the workspace', () => {
    expect(
      shellChildren.filter((c) => c === 'div').length,
      'a second bare <div> was added to the shell column and inherited the ' +
        'workspace exemption without anyone deciding it should. Give it a name ' +
        '(pull it out as a component) so it can be rostered or exempted on purpose'
    ).toBe(BARE_DIVS_ALLOWED);
  });

  it('every rostered notice is still rendered by the shell', () => {
    for (const n of NOTICES) {
      expect(
        shellChildren,
        `${n.component} is on the roster but App no longer renders it — remove ` +
          `the entry, or the roster is guarding something nobody can see`
      ).toContain(n.component);
    }
  });
});
