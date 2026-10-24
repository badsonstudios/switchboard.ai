// The document header's fold thresholds (#1408), pinned to the CSS they mirror.
//
// The fold arithmetic itself is `diff-toolbar-fit.test.ts`'s — this header
// reuses that rule unchanged. What is new is two numbers the "…" menu needs:
// the pane widths under which `tokens.css` hides the Outline and Readable width
// chips. The menu is not inside the container the CSS asks about, so it asks in
// numbers, and a number that drifted from its container query would offer a
// control the row has decided there is no room for (or hide one it shows).
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  chipHiddenAt,
  MEASURE_CHIP_MAX_HIDDEN_PX,
  OUTLINE_CHIP_MAX_HIDDEN_PX,
} from './document-header-fit';

const CSS = fs
  .readFileSync(path.join(__dirname, '..', 'theme', 'tokens.css'), 'utf8')
  .replace(/\r\n/g, '\n');

/** The max-width of the `@container doc-pane` rule that hides `selector`. */
function hiddenBelow(selector: string): number {
  const re = /@container doc-pane \(max-width: (\d+)px\) \{\s*([^{]+)\{\s*display: none;/g;
  for (const m of CSS.matchAll(re)) {
    if (m[2].trim() === selector) return Number(m[1]);
  }
  throw new Error(`no @container doc-pane rule hides ${selector}`);
}

describe('the header fold thresholds match tokens.css (#1408)', () => {
  it('Outline', () => {
    expect(OUTLINE_CHIP_MAX_HIDDEN_PX).toBe(hiddenBelow('.doc-outline-toggle'));
  });

  it('Readable width', () => {
    expect(MEASURE_CHIP_MAX_HIDDEN_PX).toBe(hiddenBelow('.doc-measure-toggle'));
  });

  it('max-width is inclusive, as a container query is', () => {
    expect(chipHiddenAt(420, OUTLINE_CHIP_MAX_HIDDEN_PX)).toBe(true);
    expect(chipHiddenAt(420.5, OUTLINE_CHIP_MAX_HIDDEN_PX)).toBe(false);
    expect(chipHiddenAt(600, MEASURE_CHIP_MAX_HIDDEN_PX)).toBe(true);
    expect(chipHiddenAt(601, MEASURE_CHIP_MAX_HIDDEN_PX)).toBe(false);
  });
});
