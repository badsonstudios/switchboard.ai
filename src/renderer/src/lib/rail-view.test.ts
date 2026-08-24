import { describe, it, expect } from 'vitest';
import {
  presentStatus,
  statusVars,
  needCount,
  clampRailWidth,
  railWidthAtPointer,
  RAIL_WIDTH_DEFAULT,
  RAIL_WIDTH_MIN,
  RAIL_WIDTH_MAX,
  type StatusToken,
} from './rail-view';

describe('presentStatus', () => {
  it('marks exactly the four human-blocking states as needing you', () => {
    const needy = ['needs-input', 'needs-permission', 'done', 'crashed'];
    const calm = ['starting', 'working', 'idle', 'suspended'];
    for (const s of needy) expect(presentStatus(s).needsYou, s).toBe(true);
    for (const s of calm) expect(presentStatus(s).needsYou, s).toBe(false);
  });

  it('spins only while the agent is actually running', () => {
    expect(presentStatus('working').spinner).toBe(true);
    expect(presentStatus('starting').spinner).toBe(true);
    expect(presentStatus('idle').spinner).toBe(false);
    expect(presentStatus('done').spinner).toBe(false);
  });

  it('gives a glyph to every non-spinning state and none to the spinning ones', () => {
    for (const s of ['needs-input', 'needs-permission', 'done', 'crashed', 'idle', 'suspended']) {
      expect(presentStatus(s).glyphKey, s).toBeTruthy();
    }
    expect(presentStatus('working').glyphKey).toBeUndefined();
    expect(presentStatus('starting').glyphKey).toBeUndefined();
  });

  it('folds starting into working and suspended into idle', () => {
    expect(presentStatus('starting').token).toBe('working');
    expect(presentStatus('suspended').token).toBe('idle');
    // ...but they keep their own sub-label — "starting" is not "working"
    expect(presentStatus('starting').labelKey).not.toBe(presentStatus('working').labelKey);
    expect(presentStatus('suspended').labelKey).not.toBe(presentStatus('idle').labelKey);
  });

  it('fails open: an unknown or missing status reads as idle, never as an alarm', () => {
    for (const s of [undefined, '', 'compacting', 'who-knows']) {
      const p = presentStatus(s);
      expect(p.needsYou, String(s)).toBe(false);
      expect(p.token, String(s)).toBe('idle');
      expect(p.spinner, String(s)).toBe(false);
    }
  });
});

describe('statusVars', () => {
  it('names the hue and the ink of a ramp position', () => {
    expect(statusVars('crashed')).toEqual({
      hue: 'var(--status-crashed)',
      ink: 'var(--status-crashed-ink)',
    });
  });

  it('never offers the raw hue as a text color', () => {
    // the status pill's bug in one line (#221): the hue is for dots and tints,
    // and the ink is the only one measured against what is behind the text
    for (const s of ['working', 'needs-input', 'needs-permission', 'idle', 'done', 'crashed']) {
      const v = statusVars(s as StatusToken);
      expect(v.ink, s).toMatch(/-ink\)$/);
      expect(v.ink, s).not.toBe(v.hue);
    }
  });

  it('takes whatever presentStatus folded a raw status into', () => {
    expect(statusVars(presentStatus('suspended').token).ink).toBe('var(--status-idle-ink)');
    expect(statusVars(presentStatus('starting').token).ink).toBe('var(--status-working-ink)');
  });
});

describe('needCount (#621)', () => {
  const group = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];

  it('counts the members with an outstanding demand on them', () => {
    expect(needCount(group, new Set(['a', 'c']))).toBe(2);
  });

  it('is zero for an empty group, and for one with nothing outstanding', () => {
    expect(needCount([], new Set(['a']))).toBe(0);
    expect(needCount(group, new Set())).toBe(0);
  });

  it('counts MEMBERS, not entries — a card elsewhere is not this one’s', () => {
    // the group summary is per-group and the set is workspace-wide, so a needy
    // session in the next group must not inflate this header
    expect(needCount([{ id: 'a' }], new Set(['a', 'zz', 'yy']))).toBe(1);
  });

  it('counts each card once however often it appears in the set', () => {
    // a Set makes this true by construction; asserted so a future "list of
    // events" refactor cannot quietly start double-counting a session that
    // raised two
    expect(needCount([{ id: 'a' }], new Set(['a']))).toBe(1);
  });

  it('is NOT presentStatus — that is the bug it was (#621)', () => {
    // the whole point: a dismissed session still HAS a needy status (the CLI
    // may still be blocked, and the row still says so), and the counter must
    // not report it anyway
    expect(presentStatus('needs-input').needsYou).toBe(true);
    expect(needCount([{ id: 'a' }], new Set())).toBe(0);
  });
});

describe('clampRailWidth', () => {
  it('keeps a sane width untouched', () => {
    expect(clampRailWidth(RAIL_WIDTH_DEFAULT)).toBe(RAIL_WIDTH_DEFAULT);
    expect(clampRailWidth(320)).toBe(320);
  });

  it('never lets a drag hide the rail or eat the grid', () => {
    expect(clampRailWidth(0)).toBe(RAIL_WIDTH_MIN);
    expect(clampRailWidth(-400)).toBe(RAIL_WIDTH_MIN);
    expect(clampRailWidth(9000)).toBe(RAIL_WIDTH_MAX);
  });

  it('rounds to whole pixels and falls back on garbage', () => {
    expect(clampRailWidth(286.6)).toBe(287);
    expect(clampRailWidth(NaN)).toBe(RAIL_WIDTH_DEFAULT);
    expect(clampRailWidth(Infinity)).toBe(RAIL_WIDTH_DEFAULT);
  });
});

// The rail's edge is dragged with a PHYSICAL pointer coordinate but sets a
// LOGICAL inline size, and the two disagree by the width of the window under
// `dir="rtl"` — the same confusion that put the context menu off screen (#642).
describe('railWidthAtPointer', () => {
  const VW = 1008;

  it('is the pointer’s distance from the left edge when the app reads left-to-right', () => {
    expect(railWidthAtPointer(300, VW, 'ltr')).toBe(300);
  });

  it('is the distance from the RIGHT edge when the app reads right-to-left', () => {
    // the rail is on the right under rtl, so a gripper at x=708 is a 300px rail
    expect(railWidthAtPointer(VW - 300, VW, 'rtl')).toBe(300);
  });

  it('the bug it fixes: a physical x would have pinned the rail to its maximum', () => {
    // the gripper of a default-width rail, under rtl, is at 1008 - 286 = 722
    const gripper = VW - RAIL_WIDTH_DEFAULT;
    expect(clampRailWidth(gripper)).toBe(RAIL_WIDTH_MAX); // what it used to do
    expect(railWidthAtPointer(gripper, VW, 'rtl')).toBe(RAIL_WIDTH_DEFAULT);
  });

  it('and the drag runs the right way: further from the inline-start edge is wider', () => {
    const a = railWidthAtPointer(VW - 250, VW, 'rtl');
    const b = railWidthAtPointer(VW - 350, VW, 'rtl');
    expect(b).toBeGreaterThan(a);
  });

  it('still clamps, in either direction', () => {
    for (const direction of ['ltr', 'rtl'] as const) {
      for (const x of [-9999, 0, 1, 500, VW, 9999]) {
        const w = railWidthAtPointer(x, VW, direction);
        expect(w).toBeGreaterThanOrEqual(RAIL_WIDTH_MIN);
        expect(w).toBeLessThanOrEqual(RAIL_WIDTH_MAX);
      }
    }
  });
});
