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
// `WorkspaceNoticeBanner` carried it from #168 but nothing checked it, so
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
    component: 'WorkspaceNoticeBanner',
    file: 'components/WorkspaceNoticeBanner.tsx',
    from: 'const banner: React.CSSProperties = {',
    to: '\n};',
    guard: INLINE_GUARD,
    // #168, and #207's failing-save half. Issue numbers stay in comments
    // throughout this list: they are hex-colour-shaped, and the lint rule that
    // keeps raw hex out of the renderer cannot tell the difference inside a
    // string literal.
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
    component: 'ServiceHealthBanner',
    file: 'theme/tokens.css',
    from: '.service-health-banner {',
    to: '\n}',
    guard: CSS_GUARD,
    // P2-E14-07, §5.14. Same shape as the preflight banner: a CSS rule, so the
    // guard is checked here rather than in a rendered test jsdom cannot style.
    why: 'the only hint that a wall of failing sessions might not be your fault',
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
  {
    component: 'BatchApprovalBar',
    file: 'components/BatchApprovalBar.tsx',
    from: 'data-testid="batch-approval"',
    to: '\n    >',
    guard: INLINE_GUARD,
    // P2-E9-11, §5.8's batch bullet. It renders nothing when nothing groups —
    // like the collapsed strip — but when it IS there, several CLIs are parked
    // behind it and the buttons are the only thing that releases them.
    why: 'the buttons several blocked sessions are waiting on (§5.8)',
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
  PushSetupDialog: 'a modal, same as AboutPanel (P2-E14-06)',
  QuietHoursDialog: 'a modal, same as AboutPanel (P2-E14-05b)',
  McpManagerDialog: 'a modal, same as AboutPanel (§5.17, #632)',
  ModelPickerDialog: 'a modal, same as AboutPanel (#721)',
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

// --- The events drawer, classified on purpose (P2-E14-01) -------------------
//
// Shape B put an always-visible thing on screen — the drawer's tab — and the
// roster above does not mention it. That is a DECISION, not an omission, and
// this block is where it is written down and held.
//
// WHY IT IS NOT ON THE ROSTER. Every entry above is an in-flow child of the
// shell COLUMN, and `flexShrink: 0` is a promise about how negative free space
// is shared out among such children. The tab is neither: it lives inside the
// workspace row, one level down, and it is `position: absolute` — out of flow
// entirely, so it has no flex basis to be shrunk against and the guard would be
// an inert declaration. Adding it above would put a line in the roster that
// checks nothing, which is precisely the failure the file's header warns about
// ("a green test over a dead declaration").
//
// WHAT REPLACES THE GUARD. Out of flow, the drawer's one way of hurting the
// bars is the opposite one: escaping its container and covering them. It is
// positioned against the nearest positioned ancestor, which App makes the
// workspace row on purpose — drop that one declaration and the containing block
// becomes the viewport, so the drawer resolves `insetBlockEnd: 0` to the bottom
// of the WINDOW and hangs over the status bar, the urgency strip and every
// notice below it. Same defect class as the roster's (an always-visible surface
// silently loses its space to a neighbour), same witness (the source text), one
// level down. So the pair is pinned instead: the row is positioned, and the
// drawer is what needs it to be.
describe('the events drawer stays inside the workspace row', () => {
  const DRAWER = read('components/EventsDrawer.tsx');

  it('the workspace row is a positioned ancestor', () => {
    const workspace = styleBlock(
      APP,
      'App.tsx',
      "<div style={{ flex: 1, display: 'flex', minBlockSize: 0",
      // the whole opening tag is one line, so the newline closes the block
      '\n'
    );
    expect(
      workspace,
      "App's workspace row no longer declares `position: relative`, so the " +
        'events drawer is positioned against the VIEWPORT instead — it now ' +
        'hangs over the status bar and every strip above it, which is exactly ' +
        'the space those surfaces are guaranteed'
    ).toMatch(/position:\s*'relative'/);
  });

  it('...which is only load-bearing while the drawer is out of flow', () => {
    // the other half of the pair: if the drawer stopped being absolute, the
    // test above would be guarding nothing — and the drawer would be back to
    // taking a column out of the grid, which is the whole thing this item
    // removed
    expect(
      DRAWER,
      'the events drawer is no longer `position: absolute`. If it has become an ' +
        'in-flow child again it costs the session grid its width — the 220px ' +
        'this item reclaimed — and it belongs on a roster rather than here'
    ).toMatch(/position:\s*'absolute'/);
  });

  it('does not sit in the shell column', () => {
    expect(
      shellChildren,
      'EventsDrawer was moved up into the shell column. There it is an in-flow ' +
        'child like every rostered bar: give it `flexShrink: 0` and a NOTICES ' +
        'entry, and delete this block — the reasoning above no longer applies'
    ).not.toContain('EventsDrawer');
  });
});

// --- The popped-out document ------------------------------------------------
//
// A popped-out group is its OWN document, and #168's read-only notice follows
// the user there (#208). The mechanism above repeats there exactly: popout.html
// turns the body into a flex column, dockview's adopted container takes
// `flex: 1 1 0` — basis zero again, absorbs nothing — so a short popout window
// squeezes the notice instead. The guard is present and has been since #208,
// and until now nothing checked it: the roster's own defect class, one document
// over. That is what #306 is.
//
// It gets its own roster instead of a row in NOTICES because entries there are
// keyed by the name App.tsx renders them under, and this element has no such
// name: lib/popout-banner-host creates it at runtime, in a document App never
// sees. Same shape, same anchor-and-terminator witness, separate scan.
const POPOUT = read('../popout.html');

/** Both spellings of the same promise. popout.html writes the shorthand, and
 *  this does not ask it to change: that rule is one of a PAIR — this element
 *  takes what it needs, `#dv-popout-window` under it takes the rest with
 *  `flex: 1 1 0` — and the pair reads as a pair only while both are spelled
 *  alike. The longhand is accepted too, so normalizing it later is a choice and
 *  not a test failure. What neither spelling permits is a shrink factor other
 *  than zero, which is the entire point. `!important` is optional because the
 *  neighbouring rules need it and this one may yet. */
const POPOUT_GUARD =
  /^\s*(?:flex-shrink:\s*0|flex:\s*(?:none|0\s+0(?:\s+[^\s;!]+)?))\s*(?:!important)?\s*;/m;

type PopoutNotice = {
  /** the selector popout.html writes the rule under, minus the body prefix —
   *  both the anchor for the style block and the key the scan classifies by */
  selector: string;
  /** what is lost when it shrinks — the reason it is on the roster */
  why: string;
};

/** Every always-visible child of the popout's body column. Issue numbers stay
 *  out of these strings and in the comments: they are hex-colour-shaped and the
 *  renderer's no-raw-hex lint rule cannot tell the difference inside a string
 *  literal. */
const POPOUT_NOTICES: readonly PopoutNotice[] = [
  {
    selector: '[data-sb-banner-host]',
    // #208 put it there; #168 is the warning it carries
    why: 'the only warning that nothing done this run will be saved, in a window a user can spend the whole run inside',
  },
];

/** The column's other children, and why none of them is a notice. */
const POPOUT_NOT_A_NOTICE: Readonly<Record<string, string>> = {
  '#dv-popout-window':
    "dockview's adopted container — `flex: 1 1 0`, a basis of 0. It is the thing that is SUPPOSED to give way here, exactly as the workspace div is in the main window",
};

/** the child rules of the popout's body column, read off the one `<style>`
 *  block. Indentation-anchored for the same fail-loud reason the App scan is —
 *  and guarded the same way, by a test that the scan still finds them. */
const popoutColumnRules = [...POPOUT.matchAll(/^ {6}body\[data-sb-banner\] > ([^{]+?) \{/gm)].map(
  (m) => m[1]
);

describe("the popout window's notice keeps its height", () => {
  it.each(POPOUT_NOTICES)('$selector declares the shrink guard', (n) => {
    expect(
      styleBlock(POPOUT, 'popout.html', `body[data-sb-banner] > ${n.selector} {`, '\n      }'),
      `the popout's ${n.selector} rule must hold its shrink factor at 0 — ` +
        `without it a short popout window squeezes it instead of dockview's ` +
        `container below, and what is lost is ${n.why}`
    ).toMatch(POPOUT_GUARD);
  });

  // Without the column the guard is inert: `flex-*` on a child of a non-flex
  // body means nothing, and worse, #208's comment records what actually
  // happens then — the notice lands UNDER dockview's opaque container, present
  // in the DOM and invisible on screen. A green test over a dead declaration is
  // the one outcome this file exists to prevent.
  it('the popout body is still the flex column that makes the guard mean anything', () => {
    const column = styleBlock(POPOUT, 'popout.html', 'body[data-sb-banner] {', '\n      }');
    expect(
      column,
      'popout.html no longer makes the body a flex column, so every shrink ' +
        'guard below it is inert and the notice renders underneath dockview'
    ).toMatch(/^\s*display:\s*flex\s*!important\s*;/m);
    expect(column, 'the popout body column is no longer a COLUMN').toMatch(
      /^\s*flex-direction:\s*column\s*!important\s*;/m
    );
  });

  // The rule is written against two attributes the renderer sets from its own
  // constants, in a different file, in a different document. Nothing but this
  // makes the two agree — rename either side alone and the selector matches
  // nothing, which looks exactly like a guard and does exactly nothing.
  it('the guarded rule selects the element the renderer actually inserts', () => {
    const host = read('lib/popout-banner-host.ts');
    const hostAttr = /const HOST_ATTR = '([^']+)'/.exec(host)?.[1];
    const bodyAttr = /const BODY_ATTR = '([^']+)'/.exec(host)?.[1];
    expect(
      hostAttr && bodyAttr,
      'HOST_ATTR / BODY_ATTR could not be read out of lib/popout-banner-host.ts — ' +
        'they were renamed or restructured, and until this reader is fixed the ' +
        'check below cannot tell whether the CSS still matches them'
    ).toBeTruthy();
    expect(
      POPOUT,
      `popout.html does not select the attributes the renderer sets ` +
        `(body ${bodyAttr}, host ${hostAttr}) — one side was renamed without the ` +
        `other, so the rule matches nothing and the notice has no guard at all`
    ).toContain(`body[${bodyAttr}] > [${hostAttr}] {`);
  });
});

describe("the roster covers the popout's body column", () => {
  // Exact, not a lower bound like the App scan's: this doubles as the check
  // that nothing on either list has been DELETED from popout.html, which is
  // what 'every rostered notice is still rendered by the shell' does upstairs.
  // Classify a new rule and this stays green on its own; it only speaks up when
  // the two sides actually disagree.
  it('still finds the popout column', () => {
    expect(
      popoutColumnRules,
      'the scan of popout.html found a different number of child rules than the ' +
        'roster and the exemptions describe — either the <style> block was ' +
        'reformatted so the scan no longer reads it (and nothing below means ' +
        'anything until that is fixed), or a rule listed here no longer exists'
    ).toHaveLength(POPOUT_NOTICES.length + Object.keys(POPOUT_NOT_A_NOTICE).length);
  });

  it('every child of the popout column is rostered or a stated exemption', () => {
    const known = new Set([
      ...POPOUT_NOTICES.map((n) => n.selector),
      ...Object.keys(POPOUT_NOT_A_NOTICE),
    ]);
    expect(
      popoutColumnRules.filter((s) => !known.has(s)),
      'a new child rule was added to the popout body column and classified ' +
        'nowhere. If the element is always visible it needs a shrink guard and ' +
        'a POPOUT_NOTICES entry; if it is the container that should give way, ' +
        'say so in POPOUT_NOT_A_NOTICE with the reason'
    ).toEqual([]);
  });
});
