// The six looks a working session can have (#718): the list, the default, and
// the rules the stylesheet has to keep for every one of them.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { DEFAULT_WORKING_LOOK, WORKING_LOOKS, workingLookOf } from './working-look';
import en from '../../../shared/i18n/locales/en.json';

const css = fs.readFileSync(path.join(__dirname, '..', 'theme', 'tokens.css'), 'utf8');
/** the part of the stylesheet that is about a working session */
const block = css.slice(css.indexOf('A WORKING SESSION (#718)'));

describe('the list (issue 718)', () => {
  it('is the six the owner saw, in the order he saw them', () => {
    expect(WORKING_LOOKS).toEqual(['glow', 'marquee', 'fill', 'shimmer', 'strip', 'bars']);
  });

  it('⭐ defaults to option 3', () => {
    expect(DEFAULT_WORKING_LOOK).toBe('fill');
    expect(WORKING_LOOKS.indexOf(DEFAULT_WORKING_LOOK) + 1).toBe(3);
  });

  it('reads a stored choice, and falls back to the default for anything else', () => {
    for (const look of WORKING_LOOKS) expect(workingLookOf(look)).toBe(look);
    for (const junk of [undefined, null, '', 'ring', 7, {}, ['fill']]) {
      expect(workingLookOf(junk)).toBe('fill');
    }
  });

  it('every look has a name and a one-line description in Settings', () => {
    const words = en.workingLook as Record<string, string>;
    for (const look of WORKING_LOOKS) {
      expect(words[look], look).toBeTruthy();
      expect(words[`${look}Note`], look).toBeTruthy();
    }
  });
});

describe('the stylesheet, for every look', () => {
  it('has rules for each of the six, and for none that is not on the list', () => {
    const named = new Set(
      Array.from(block.matchAll(/\[data-working-look='([a-z]+)'\]/g)).map((m) => m[1])
    );
    // (the bare `[data-working-look]`, "whichever look", is not a look)
    expect([...named].sort()).toEqual([...WORKING_LOOKS].sort());
  });

  /** every selector in the block that restyles a working row or pill */
  const selectors = block
    .split('}')
    .map((chunk) => chunk.slice(chunk.lastIndexOf('*/') + 2).split('{')[0].trim())
    .filter((s) => s.includes('data-working-look') && s.includes("data-session-status='working'"));

  it('⚠️ never touches a session that NEEDS YOU: working stays the quieter of the two', () => {
    // the ticket's first constraint. A working look that could land on a
    // waiting session would be painting over the one colour that means "you".
    expect(selectors.length).toBeGreaterThan(12);
    for (const s of selectors) {
      expect(s, s).toContain(":not([data-needs-you='true'])");
    }
  });

  it('⚠️ the session you have OPEN is still told apart, under every look', () => {
    // found in review: a look repaints the tint and the edge bar, which were
    // the only things marking the open session. One rule, for all six.
    const rule = selectors.find((s) => s.includes("data-selected='true'"));
    expect(rule).toBeDefined();
    expect(rule).toContain("[data-strip-pill][aria-current='true']");
    // any look, not one of them by name
    expect(rule!.startsWith('[data-working-look] ')).toBe(true);
  });

  it('paints in the session’s own colour, never in a "needs you" colour', () => {
    expect(block).toContain('var(--work-accent)');
    // the comment at the top names the rule; no DECLARATION may use the tokens
    const declarations = block
      .split('\n')
      .filter((l) => /^\s*[a-z-]+\s*:/.test(l))
      .join('\n');
    expect(declarations).not.toMatch(/--status-needs-(input|permission)/);
  });

  it('has a still version of every look that moves, for when less motion is asked for', () => {
    const still = block.slice(block.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(still.length).toBeGreaterThan(100);
    expect(still).toContain('animation: none !important');
    // the four that move a layer; `fill` moves nothing, `bars` is stilled by the
    // shared `.status-bars i` rule
    for (const look of ['glow', 'marquee', 'shimmer', 'strip']) {
      expect(still, look).toContain(`[data-working-look='${look}']`);
    }
    expect(still).toContain('.status-bars i');
  });

  it('moves only opacity and transform, except the marquee’s own ring', () => {
    // cheap to animate with many sessions busy: the compositor moves opacity
    // and transform without repainting. The marquee sweeps an angle in a
    // gradient, which repaints its thin ring; that is the one stated exception.
    const frames = Array.from(block.matchAll(/@keyframes (sb-work-[a-z]+) \{([^@]*?)\n\}/g));
    expect(frames.map((f) => f[1]).sort()).toEqual([
      'sb-work-breathe',
      'sb-work-dance',
      'sb-work-orbit',
      'sb-work-slide',
      'sb-work-sweep',
    ]);
    for (const [, name, body] of frames) {
      const props = Array.from(body.matchAll(/([a-z-]+)\s*:/g)).map((m) => m[1]);
      const allowed = name === 'sb-work-orbit' ? ['--work-angle'] : ['opacity', 'transform'];
      for (const p of props) expect(allowed, `${name} animates ${p}`).toContain(p);
    }
  });
});
