import { describe, it, expect } from 'vitest';
import {
  presentStatus,
  needCount,
  clampRailWidth,
  RAIL_WIDTH_DEFAULT,
  RAIL_WIDTH_MIN,
  RAIL_WIDTH_MAX,
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

describe('needCount', () => {
  it('counts only the sessions a human has to unblock', () => {
    expect(
      needCount([
        { status: 'working' },
        { status: 'needs-input' },
        { status: 'idle' },
        { status: 'crashed' },
        { status: 'done' },
        { status: 'needs-permission' },
      ])
    ).toBe(4);
  });

  it('is zero for an empty or entirely calm group', () => {
    expect(needCount([])).toBe(0);
    expect(needCount([{ status: 'working' }, { status: 'idle' }])).toBe(0);
  });

  it('agrees with presentStatus on every session it counts', () => {
    const sessions = [{ status: 'done' }, { status: 'working' }, { status: 'crashed' }];
    expect(needCount(sessions)).toBe(sessions.filter((s) => presentStatus(s.status).needsYou).length);
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
