// #365 — the raw-hex-colour lint rule, pinned in both directions.
//
// `no-restricted-syntax` is a regex over source text, and that regex IS the
// rule. Too loose and it reads this repo's issue numbers as colours — which is
// what it did: `'#358'` is three hex digits, so most references cost their
// sentence, and one cost #358 a test title. Too tight and a hand-written colour
// walks past §5.20's only automated guard.
//
// Nothing else in the repo executes `eslint.config.mjs`, so `npm run lint`
// going green proves only that no CURRENT file trips it — it cannot notice the
// rule quietly matching nothing. This runs the real config through the real
// ESLint API over snippets, which is the only way either direction fails loudly.
//
// It lives in scripts/ for the reason the vitest `include` list gives: repo
// tooling has no home under src/, and the thing under test sits at the root.
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import { ESLint } from 'eslint';

// The colour rule is scoped to `src/renderer/**` — main and shared are not
// drawing anything. The file never has to exist; the path is what picks the
// config block.
//
// That is only true because `eslint.config.mjs` ignores `**/__eslint-probe__*`
// on its two type-checked blocks (#255). `src/` is on `recommendedTypeChecked`,
// and under `parserOptions.project` a path in no tsconfig is a FATAL parse
// error — one of those makes ESLint drop every other message, so every
// assertion below would go red at once. Rename this constant and you must
// rename the ignore with it.
const RENDERER_FILE = path.join(process.cwd(), 'src', 'renderer', 'src', '__eslint-probe__.ts');

/** @type {ESLint} */
let eslint;
beforeAll(() => {
  eslint = new ESLint({ cwd: process.cwd() });
});

/** Every `no-restricted-syntax` message the real config raises for `source`. */
async function restricted(source) {
  const [result] = await eslint.lintText(source, { filePath: RENDERER_FILE });
  return result.messages.filter((m) => m.ruleId === 'no-restricted-syntax').map((m) => m.message);
}

/** How many of them are the colour complaint (rather than a sibling rule's). */
async function colourErrors(source) {
  return (await restricted(source)).filter((m) => m.startsWith('Raw hex color')).length;
}

describe('the raw-hex-colour rule', () => {
  // A colour written by hand is the defect §5.20 exists to prevent, and this
  // half must not weaken: everything here was caught before #365 and still is.
  it.each([
    ['a shorthand with letters', `const s = { color: '#fff' };`],
    ['an UPPERCASE shorthand', `const s = { color: '#FFF' };`],
    ['an all-numeric shorthand', `const s = { color: '#000' };`],
    ['a four-digit shorthand with alpha', `const s = { color: '#0000' };`],
    ['a full six-digit colour', `const s = { color: '#1a2b3c' };`],
    ['an all-numeric six-digit colour', `const s = { color: '#335588' };`],
    ['an eight-digit colour with alpha', `const s = { color: '#12345678' };`],
    ['one buried in a longer value', `const s = { border: '1px solid #abc' };`],
    ['one in a template literal', 'const s = `1px solid #abc`;'],
    ['one in a template literal, six digits', 'const s = `${x} 0 0 2px #1a2b3c`;'],
  ])('catches %s', async (_label, source) => {
    expect(await colourErrors(source)).toBeGreaterThan(0);
  });

  // ...and this half is the bug. An issue reference is decimal and lives in a
  // sentence; three or four of those digits happening to be valid hex is not a
  // colour, and the rule saying so made references unwritable in string
  // literals — test titles most of all.
  it.each([
    ['a test title', `it('announces suspension (#358)', () => {});`],
    ['two references in one sentence', `const s = 'fixed by #355 and #358 together';`],
    ['a four-digit issue number', `const s = 'see #1234 for why';`],
    ['a reference in a template literal', 'const s = `restored in #358`;'],
    ['a reference at the end of a line', `const s = 'the ended overlay, per #358';`],
    ['a reference followed by punctuation', `const s = 'per #213, every temp dir is swept.';`],
    // five and seven digits are not CSS colours in any notation, so the old
    // `{3,8}` was flagging shapes it could never have been about
    ['a five-digit run', `const s = 'ref #12345 in the log';`],
  ])('lets %s through', async (_label, source) => {
    expect(await colourErrors(source)).toBe(0);
  });

  // The ambiguous case, decided by POSITION and worth stating out loud: an
  // all-numeric shorthand is a colour when it is the whole value, because that
  // is how every inline style in this tree writes one. The cost is that a bare
  // `'#358'` — no sentence around it — reads as a colour. Nothing in the tree
  // writes that, and the alternative was losing `'#000'` entirely.
  it('reads a bare all-numeric literal as a colour, not a reference', async () => {
    expect(await colourErrors(`const s = '#358';`)).toBe(1);
    expect(await colourErrors(`const s = 'the fix for #358';`)).toBe(0);
  });

  // Colours in comments were never the rule's business (it matches AST string
  // nodes), which is why issue numbers in comments survived all along.
  it('ignores everything in a comment', async () => {
    expect(await colourErrors('// #358 painted it #fff, see #1a2b3c\nconst s = 1;')).toBe(0);
  });

  it('still catches an rgb() colour', async () => {
    const msgs = await restricted(`const s = { color: 'rgba(0, 0, 0, 0.5)' };`);
    expect(msgs.some((m) => m.startsWith('Raw rgb() color'))).toBe(true);
  });

  // The colour rules share their `no-restricted-syntax` entry with the
  // effect-cleanup guard, and flat config REPLACES a rule's options rather than
  // merging them — so editing this block can silently drop the guard for the
  // whole renderer. That trap is called out in the config; this is the alarm.
  it('leaves the effect-cleanup guard standing in the same block', async () => {
    const msgs = await restricted('useEffect(() => setTimeout(f, 1), []);');
    expect(msgs.some((m) => m.includes('block body'))).toBe(true);
  });
});
