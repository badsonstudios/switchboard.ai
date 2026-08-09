import { describe, it, expect } from 'vitest';
import {
  isStranded,
  popoutWindowGone,
  strandedByGroup,
  type RescueGroup,
  type RescuePanel,
} from './popout-rescue';

/** a window that answers `closed` however the test says */
function win(closed: boolean): Window {
  return { closed } as unknown as Window;
}

function group(
  id: string,
  location: 'grid' | 'popout' | 'floating' = 'grid',
  window?: Window | null
): RescueGroup {
  return {
    id,
    api: {
      location:
        location === 'popout'
          ? { type: 'popout', getWindow: () => window ?? null }
          : { type: location },
    },
  };
}

function panel(id: string, g: RescueGroup): RescuePanel {
  return { id, group: g };
}

describe('popoutWindowGone (#292)', () => {
  it('is true for a popout whose window says it is closed', () => {
    expect(popoutWindowGone(group('g1', 'popout', win(true)).api.location)).toBe(true);
  });

  it('is false while the window is open', () => {
    expect(popoutWindowGone(group('g1', 'popout', win(false)).api.location)).toBe(false);
  });

  it('is true for a popout group with no window object at all', () => {
    // dockview drops its Window reference as part of closing; a popout group
    // with nothing to point at is as gone as one that says so
    expect(popoutWindowGone(group('g1', 'popout', null).api.location)).toBe(true);
  });

  it('is never true for a group in the grid — there is no window to lose', () => {
    expect(popoutWindowGone(group('g1').api.location)).toBe(false);
    expect(popoutWindowGone(group('g2', 'floating').api.location)).toBe(false);
  });

  it('KEEPS a window it cannot ask about', () => {
    // the same stance popout-windows takes about an unreachable window: tearing
    // a session out of a LIVE popout costs the user their window, while leaving
    // a dead one costs one more sweep. Only an answer of "closed" is acted on.
    const hostile: RescueGroup = {
      id: 'g1',
      api: {
        location: {
          type: 'popout',
          getWindow: () => {
            throw new Error('detached');
          },
        },
      },
    };
    expect(popoutWindowGone(hostile.api.location)).toBe(false);
  });

  it('keeps a popout location that has no way to be asked', () => {
    // `getWindow` is optional on this type only because the type is
    // STRUCTURAL. Its absence is another flavour of "cannot ask", and reading
    // it as death would evict a card on the strength of a missing function.
    expect(popoutWindowGone({ type: 'popout' })).toBe(false);
  });

  it('keeps a window whose `closed` getter throws', () => {
    const booby = {
      get closed(): boolean {
        throw new Error('gone');
      },
    } as unknown as Window;
    expect(popoutWindowGone(group('g1', 'popout', booby).api.location)).toBe(false);
  });
});

describe('strandedByGroup (#292)', () => {
  it('finds the card left behind in a dead window', () => {
    const dead = group('pop1', 'popout', win(true));
    const home = group('g1');
    const panels = [panel('session-a', dead), panel('session-b', home)];
    expect(isStranded(panels[0])).toBe(true);
    expect(isStranded(panels[1])).toBe(false);
    expect([...strandedByGroup(panels).keys()]).toEqual(['pop1']);
  });

  it('leaves a LIVE popout alone — that card is exactly where the user put it', () => {
    const alive = group('pop1', 'popout', win(false));
    expect(strandedByGroup([panel('session-a', alive)]).size).toBe(0);
  });

  it('keeps the cards that shared a window together', () => {
    // a popout window can host several cards (dragged in), and a clean close
    // returns them as one group — so the rescue has to be able to as well
    const dead = group('pop1', 'popout', win(true));
    const byGroup = strandedByGroup([panel('session-a', dead), panel('session-b', dead)]);
    expect(byGroup.size).toBe(1);
    expect(byGroup.get('pop1')?.map((p) => p.id)).toEqual(['session-a', 'session-b']);
  });

  it('separates two windows that died at once', () => {
    const deadA = group('pop1', 'popout', win(true));
    const deadB = group('pop2', 'popout', win(true));
    const byGroup = strandedByGroup([panel('session-a', deadA), panel('session-b', deadB)]);
    expect([...byGroup.keys()]).toEqual(['pop1', 'pop2']);
  });

  it('finds nothing in an ordinary workspace', () => {
    const g = group('g1');
    expect(strandedByGroup([panel('session-a', g), panel('session-b', g)]).size).toBe(0);
  });
});
