import { describe, it, expect } from 'vitest';
import { popoutWindowKey, type PopoutKeyGroup } from './popout-window-key';

const inWindow = (id: string, name: string | (() => never) | undefined): PopoutKeyGroup => ({
  id,
  api: {
    location: {
      type: 'popout',
      getWindow: () =>
        typeof name === 'function'
          ? ({
              get name(): string {
                return name();
              },
            } as unknown as Window)
          : name === undefined
            ? undefined
            : ({ name } as Window),
    },
  },
});

describe('popoutWindowKey (#1456)', () => {
  it("answers the window's first group for that group", () => {
    // dockview named the window for group 2 when it opened
    expect(popoutWindowKey(inWindow('2', '1-2'))).toBe('2');
  });

  it("answers the WINDOW's key for a second group split into the same window — the bug", () => {
    // the probe's case: a session split beside another inside one popout sits
    // in group 5, but main only knows the window as 2
    expect(popoutWindowKey(inWindow('5', '1-2'))).toBe('2');
  });

  it('falls back to the group id when the window name cannot be read', () => {
    expect(popoutWindowKey(inWindow('5', undefined))).toBe('5');
    expect(popoutWindowKey(inWindow('5', ''))).toBe('5');
    expect(
      popoutWindowKey(
        inWindow('5', () => {
          throw new Error('closed');
        })
      )
    ).toBe('5');
  });

  it('is null for a group that is not popped out, or no group at all', () => {
    expect(popoutWindowKey({ id: '3', api: { location: { type: 'grid' } } })).toBeNull();
    expect(popoutWindowKey(null)).toBeNull();
    expect(popoutWindowKey(undefined)).toBeNull();
  });
});
