// The tab menu's own rules (#1281) that need no component to state.
import { describe, it, expect } from 'vitest';
import { revealLabelKey, sessionTabMenuItems } from './session-menu';

const t = (key: string): string => key;
const noop = (): void => {};
const RUNS = { diff: noop, rename: noop, pin: noop, close: noop, seen: noop, move: noop };
const FACTS = {
  session: { id: 's', title: 's', status: 'idle' },
  groups: [],
  pinned: false,
  finished: false,
};

describe('the tab menu (issue 1281)', () => {
  it('names the file manager the way the platform does', () => {
    expect(revealLabelKey('win32')).toBe('tabMenu.revealWindows');
    expect(revealLabelKey('darwin')).toBe('tabMenu.revealMac');
    expect(revealLabelKey('linux')).toBe('tabMenu.revealOther');
    expect(revealLabelKey(undefined)).toBe('tabMenu.revealOther');
  });

  it('puts Fork straight after Duplicate, so the difference is visible', () => {
    const ids = sessionTabMenuItems(
      FACTS,
      RUNS,
      { duplicate: noop, fork: noop, popOut: { poppedOut: false, run: noop }, closeOthers: { can: true, run: noop } },
      t
    ).map((i) => i.id);
    expect(ids.slice(0, 3)).toEqual(['rename', 'duplicate', 'fork']);
  });

  it('hides what can never apply: no folder means no Duplicate, Copy path or Reveal', () => {
    const ids = sessionTabMenuItems(
      FACTS,
      RUNS,
      { popOut: { poppedOut: false, run: noop }, closeOthers: { can: false, run: noop } },
      t
    ).map((i) => i.id);
    expect(ids).not.toContain('duplicate');
    expect(ids).not.toContain('copy-path');
    expect(ids).not.toContain('reveal');
    expect(ids.at(-1)).toBe('close');
  });
});
