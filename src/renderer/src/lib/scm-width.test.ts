import { describe, it, expect, beforeEach, vi } from 'vitest';

const store = new Map<string, unknown>();
vi.mock('./ui-state', () => ({
  uiGet: <T,>(key: string, fallback: T): T => (store.has(key) ? (store.get(key) as T) : fallback),
  uiSet: (key: string, value: unknown): void => {
    store.set(key, value);
  },
}));

import {
  SCM_BODY_MIN,
  SCM_WIDTH_DEFAULT,
  SCM_WIDTH_MAX,
  SCM_WIDTH_MIN,
  clampScmWidth,
  getScmWidth,
  resetScmWidthForTests,
  scmWidthFromDrag,
  setScmWidth,
  subscribeScmWidth,
} from './scm-width';

beforeEach(() => {
  store.clear();
  resetScmWidthForTests();
});

describe('clampScmWidth (#1142)', () => {
  it('holds a width inside the fixed bounds', () => {
    expect(clampScmWidth(300)).toBe(300);
    expect(clampScmWidth(10)).toBe(SCM_WIDTH_MIN);
    expect(clampScmWidth(5000)).toBe(SCM_WIDTH_MAX);
    expect(clampScmWidth(300.6)).toBe(301);
  });

  it('falls back to the default for a width that is not a number', () => {
    expect(clampScmWidth(Number.NaN)).toBe(SCM_WIDTH_DEFAULT);
    expect(clampScmWidth(Number.POSITIVE_INFINITY)).toBe(SCM_WIDTH_DEFAULT);
  });

  // the diff beside the list always keeps its share
  it('never takes the room the diff needs', () => {
    expect(clampScmWidth(600, 700)).toBe(700 - SCM_BODY_MIN);
    expect(clampScmWidth(300, 700)).toBe(300);
  });

  // …but on a card too narrow for both, the list keeps its minimum, as the
  // fixed 240 always did
  it('keeps the minimum on a pane too narrow for both', () => {
    expect(clampScmWidth(300, 250)).toBe(SCM_WIDTH_MIN);
  });

  it('ignores a pane width it cannot use', () => {
    expect(clampScmWidth(500, 0)).toBe(500);
    expect(clampScmWidth(500, Number.NaN)).toBe(500);
  });
});

describe('scmWidthFromDrag (#1142)', () => {
  it('follows the pointer from where the drag started', () => {
    expect(scmWidthFromDrag(240, 1000, 1100, 'ltr')).toBe(340);
    expect(scmWidthFromDrag(240, 1000, 980, 'ltr')).toBe(220);
  });

  // under rtl the list is on the right and its free edge is its LEFT one
  it('mirrors under right-to-left: dragging left makes it wider', () => {
    expect(scmWidthFromDrag(240, 1000, 900, 'rtl')).toBe(340);
    expect(scmWidthFromDrag(240, 1000, 1020, 'rtl')).toBe(220);
  });

  it('stops at the bounds and at the diff’s share', () => {
    expect(scmWidthFromDrag(240, 0, -500, 'ltr')).toBe(SCM_WIDTH_MIN);
    expect(scmWidthFromDrag(240, 0, 5000, 'ltr')).toBe(SCM_WIDTH_MAX);
    expect(scmWidthFromDrag(240, 0, 5000, 'ltr', 800)).toBe(800 - SCM_BODY_MIN);
  });
});

describe('the one shared width (#1142)', () => {
  it('starts at the default, and at the stored value when there is one', () => {
    expect(getScmWidth()).toBe(SCM_WIDTH_DEFAULT);
    resetScmWidthForTests();
    store.set('scmWidth', 400);
    expect(getScmWidth()).toBe(400);
  });

  it('clamps a stored value it would never have written', () => {
    store.set('scmWidth', 99999);
    expect(getScmWidth()).toBe(SCM_WIDTH_MAX);
  });

  it('tells every subscriber, and writes the value down', () => {
    const seen: number[] = [];
    const off = subscribeScmWidth(() => seen.push(getScmWidth()));
    setScmWidth(320);
    expect(seen).toEqual([320]);
    expect(store.get('scmWidth')).toBe(320);
    off();
    setScmWidth(360);
    expect(seen).toEqual([320]);
  });

  // a drag moves the value on every pointer event; only the last is saved
  it('moves without saving while a drag is in flight', () => {
    const seen: number[] = [];
    subscribeScmWidth(() => seen.push(getScmWidth()));
    setScmWidth(300, { persist: false });
    setScmWidth(310, { persist: false });
    expect(seen).toEqual([300, 310]);
    expect(store.has('scmWidth')).toBe(false);
    setScmWidth(310);
    expect(store.get('scmWidth')).toBe(310);
    // unchanged value: saved, nobody re-rendered
    expect(seen).toEqual([300, 310]);
  });
});
