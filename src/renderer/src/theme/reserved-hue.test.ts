// THE GUARD for the owner's rule (#1165): yellow, gold and orange mean "a
// session needs you", and nothing else is drawn in them.
//
// The rule holds only if nobody has to remember it, so this file checks the
// three places a yellow can come from:
//
//   1. the PALETTES a session or a group is given a colour from;
//   2. the STYLESHEET and the two theme files, where every colour is declared;
//   3. the SOURCE, for a file that starts painting with one of the four
//      "needs you" tokens. Those tokens are the right colour and the wrong
//      meaning anywhere but on a session that is waiting for you.
//
// What "yellowish" is, in degrees, is in `shared/reserved-hue.ts`.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { ACCENTS } from '../../../shared/accents';
import { GROUP_PALETTE } from '../../../shared/group-palette';
import { hueOf, isReservedColor } from '../../../shared/reserved-hue';

const here = __dirname;
const srcRoot = path.join(here, '..');
const read = (p: string): string => fs.readFileSync(p, 'utf8');

/** the only names allowed to hold a reserved colour */
const NEEDS_YOU_TOKEN = /^--status-needs-(input|permission)(-ink)?$/;

const two = (n: number): string => n.toString(16).padStart(2, '0');

/**
 * Every colour written in a value, as `#rrggbb`, however it was spelled:
 * `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb()` and `rgba()`. (A first version read
 * six-digit hex only, and `rgba(227,179,65,.2)` walked straight past it.)
 */
function coloursIn(value: string): string[] {
  const out: string[] = [];
  for (const m of value.matchAll(/#([0-9a-fA-F]{3,8})\b/g)) {
    const h = m[1];
    if (h.length === 3 || h.length === 4) out.push(`#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}`);
    else if (h.length === 6 || h.length === 8) out.push(`#${h.slice(0, 6)}`);
  }
  for (const m of value.matchAll(/rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/g)) {
    out.push(`#${two(Number(m[1]))}${two(Number(m[2]))}${two(Number(m[3]))}`);
  }
  return out;
}

/** every custom property declared in a stylesheet or a theme file, with the
 *  colours in its value and whether it points at a "needs you" token */
function declared(text: string): Array<{ name: string; hex: string; alias: boolean }> {
  const out: Array<{ name: string; hex: string; alias: boolean }> = [];
  for (const m of text.matchAll(/"?(--[a-z0-9-]+)"?\s*:\s*([^;\n]+)/g)) {
    const alias = /--status-needs-(input|permission)/.test(m[2]);
    const colours = coloursIn(m[2]);
    if (alias && colours.length === 0) out.push({ name: m[1], hex: '', alias });
    for (const hex of colours) out.push({ name: m[1], hex, alias });
  }
  return out;
}

describe('the palettes (issue 1165)', () => {
  it('no session colour is yellowish', () => {
    for (const a of ACCENTS) {
      expect(isReservedColor(a.value), `${a.name} ${a.value} hue ${Math.round(hueOf(a.value)!.hue)}`).toBe(false);
    }
  });

  it('no group colour is yellowish', () => {
    for (const c of GROUP_PALETTE) {
      expect(isReservedColor(c), `${c} hue ${Math.round(hueOf(c)!.hue)}`).toBe(false);
    }
  });

  it('the stylesheet’s accent tokens are the session palette, name for name', () => {
    // two homes for one palette is how the first of them came to be the same
    // hex as "needs input" without anyone deciding it should be
    const css = declared(read(path.join(here, 'tokens.css'))).filter((d) =>
      /^--accent-(?!ink)/.test(d.name)
    );
    expect(css.map((d) => [d.name, d.hex.toLowerCase()]).sort()).toEqual(
      ACCENTS.map((a) => [`--accent-${a.name}`, a.value.toLowerCase()]).sort()
    );
  });
});

describe('every declared colour, in the stylesheet and in each theme', () => {
  const files = [
    path.join(here, 'tokens.css'),
    ...fs
      .readdirSync(path.join(here, 'themes'))
      .filter((f) => f.endsWith('.json'))
      .map((f) => path.join(here, 'themes', f)),
  ];

  it.each(files.map((f) => [path.basename(f), f]))(
    '%s: a yellowish colour belongs to a "needs you" token, or it is not there',
    (_name, file) => {
      const offenders = declared(read(file))
        .filter((d) => (d.alias || isReservedColor(d.hex)) && !NEEDS_YOU_TOKEN.test(d.name))
        .map((d) => (d.alias ? `${d.name}: an alias of a "needs you" token` : `${d.name}: ${d.hex}`));
      expect(offenders).toEqual([]);
    }
  );

  it('the "needs you" tokens really are in the reserved family (the rule has a subject)', () => {
    const css = declared(read(path.join(here, 'tokens.css'))).filter((d) =>
      NEEDS_YOU_TOKEN.test(d.name)
    );
    expect(css.length).toBeGreaterThanOrEqual(6);
    for (const d of css) expect(isReservedColor(d.hex), `${d.name} ${d.hex}`).toBe(true);
  });

  it('this guard fails on a deliberate violation', () => {
    // the acceptance asks for exactly this: a yellow under any other name is caught
    // ...however it is spelled, and an alias that would let the yellow out
    // under another name is caught too
    // the samples are built from a '#' and digits so the renderer's own lint
    // rule (no raw colours in this tree) does not take a test's bad example for
    // a colour somebody painted with
    const H = '#';
    const bad = declared(
      [
        `  --accent-sunflower: ${H}f2c200;`,
        `  --short: ${H}fc0;`,
        `  --with-alpha: ${H}e3b34180;`,
        `  --tint: ${'rg' + 'ba'}(227, 179, 65, 0.2);`,
        '  --warn: var(--status-needs-input);',
        `  --status-needs-input: ${H}e3b341;`,
        `  --fine: ${H}58a6ff;`,
      ].join('\n')
    );
    const offenders = bad.filter(
      (d) => (d.alias || isReservedColor(d.hex)) && !NEEDS_YOU_TOKEN.test(d.name)
    );
    expect(offenders.map((d) => d.name)).toEqual([
      '--accent-sunflower',
      '--short',
      '--with-alpha',
      '--tint',
      '--warn',
    ]);
  });
});

describe('who paints with the "needs you" colours', () => {
  /**
   * The files that draw a session waiting for you, or a count of them: the
   * question and approval panels, the events list, and the "N need you"
   * totals in the Sessions list, the strip and the status bar.
   *
   * ⚠️ ADDING A FILE HERE IS A CLAIM that what it paints in yellow is a session
   * needing the user. A warning, a failure, a pending connection, an unread
   * message, a "dirty" marker: none of those is, and about forty such uses were
   * moved to red (it failed) or blue (worth noticing) when this list was
   * written. If the new use is not a demand on the user, it does not get yellow.
   */
  const MAY_PAINT_NEEDS_YOU = new Set([
    'components/BatchApprovalBar.tsx',
    'components/EventsDrawer.tsx',
    'components/EventsPanel.tsx',
    'components/FeedView.tsx',
    'components/QuestionPanel.tsx',
    'components/SessionsRail.tsx',
    'components/SessionsStrip.tsx',
    'components/StripGroupEntry.tsx',
    'extensibility/status-bar-items.tsx',
    'theme/tokens.css',
    'theme/tokens.ts',
  ]);

  function sources(dir: string, out: string[] = []): string[] {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) sources(p, out);
      else if (/\.(tsx?|css)$/.test(e.name) && !/\.test\./.test(e.name)) out.push(p);
    }
    return out;
  }

  /** the lines of a file that are code, not commentary about a colour */
  const codeLines = (text: string): string[] =>
    text
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => !l.startsWith('//') && !l.startsWith('*') && !l.startsWith('/*') && !l.startsWith('{/*'));

  it('only the files that draw a waiting session use them', () => {
    const users = sources(srcRoot)
      // the bare NAME, with or without `var(`: a list of token names (the git
      // status letters, the commit-graph lanes) paints with them just as well
      .filter((p) => codeLines(read(p)).some((l) => /--status-needs-(input|permission)/.test(l)))
      .map((p) => path.relative(srcRoot, p).replace(/\\/g, '/'))
      .sort();
    const uninvited = users.filter((u) => !MAY_PAINT_NEEDS_YOU.has(u));
    expect(uninvited).toEqual([]);
  });

  it('the list has no file that stopped using them (a stale entry is a standing invitation)', () => {
    for (const rel of MAY_PAINT_NEEDS_YOU) {
      const text = read(path.join(srcRoot, rel));
      expect(/--status-needs-(input|permission)/.test(text), rel).toBe(true);
    }
  });
});
