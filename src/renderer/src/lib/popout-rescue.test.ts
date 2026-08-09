import { describe, it, expect } from 'vitest';
import {
  isStranded,
  popoutWindowGone,
  rescueHome,
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
  panels: string[],
  location: 'grid' | 'popout' | 'floating' = 'grid',
  window?: Window | null
): RescueGroup {
  return {
    id,
    panels: panels.map((p) => ({ id: p })),
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
    expect(popoutWindowGone(group('g1', [], 'popout', win(true)).api.location)).toBe(true);
  });

  it('is false while the window is open', () => {
    expect(popoutWindowGone(group('g1', [], 'popout', win(false)).api.location)).toBe(false);
  });

  it('is true for a popout group with no window object at all', () => {
    // dockview drops its Window reference as part of closing; a popout group
    // with nothing to point at is as gone as one that says so
    expect(popoutWindowGone(group('g1', [], 'popout', null).api.location)).toBe(true);
  });

  it('is never true for a group in the grid — there is no window to lose', () => {
    expect(popoutWindowGone(group('g1', ['session-a']).api.location)).toBe(false);
    expect(popoutWindowGone(group('g2', ['session-a'], 'floating').api.location)).toBe(false);
  });

  it('KEEPS a window it cannot ask about', () => {
    // the same stance popout-windows takes about an unreachable window: tearing
    // a session out of a LIVE popout costs the user their window, while leaving
    // a dead one costs one more sweep. Only an answer of "closed" is acted on.
    const hostile: RescueGroup = {
      id: 'g1',
      panels: [],
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

  it('keeps a window whose `closed` getter throws', () => {
    const booby = {
      get closed(): boolean {
        throw new Error('gone');
      },
    } as unknown as Window;
    expect(popoutWindowGone(group('g1', [], 'popout', booby).api.location)).toBe(false);
  });
});

describe('strandedByGroup (#292)', () => {
  it('finds the card left behind in a dead window', () => {
    const dead = group('pop1', ['session-a'], 'popout', win(true));
    const home = group('g1', ['session-b']);
    const panels = [panel('session-a', dead), panel('session-b', home)];
    expect(isStranded(panels[0])).toBe(true);
    expect(isStranded(panels[1])).toBe(false);
    expect([...strandedByGroup(panels).keys()]).toEqual(['pop1']);
  });

  it('leaves a LIVE popout alone — that card is exactly where the user put it', () => {
    const alive = group('pop1', ['session-a'], 'popout', win(false));
    expect(strandedByGroup([panel('session-a', alive)]).size).toBe(0);
  });

  it('keeps the cards that shared a window together', () => {
    // a popout window can host several cards (dragged in), and a clean close
    // returns them as one group — so the rescue has to be able to as well
    const dead = group('pop1', ['session-a', 'session-b'], 'popout', win(true));
    const byGroup = strandedByGroup([panel('session-a', dead), panel('session-b', dead)]);
    expect(byGroup.size).toBe(1);
    expect(byGroup.get('pop1')?.map((p) => p.id)).toEqual(['session-a', 'session-b']);
  });

  it('separates two windows that died at once', () => {
    const deadA = group('pop1', ['session-a'], 'popout', win(true));
    const deadB = group('pop2', ['session-b'], 'popout', win(true));
    const byGroup = strandedByGroup([panel('session-a', deadA), panel('session-b', deadB)]);
    expect([...byGroup.keys()]).toEqual(['pop1', 'pop2']);
  });

  it('finds nothing in an ordinary workspace', () => {
    const g = group('g1', ['session-a', 'session-b']);
    expect(strandedByGroup([panel('session-a', g), panel('session-b', g)]).size).toBe(0);
  });
});

describe('rescueHome (#292)', () => {
  it('lands the card in the empty shell its popout left behind', () => {
    const shell = group('g1', []);
    expect(rescueHome([group('g0', ['session-x']), shell, group('pop1', [], 'popout', win(true))])
      ?.id).toBe('g1');
  });

  it('never lands it in a popout — dead or alive', () => {
    // the whole point is to get OUT of a window; a floating group is not the
    // grid either, and neither is somewhere a rescued card should appear
    expect(
      rescueHome([group('pop1', [], 'popout', win(true)), group('f1', [], 'floating')])
    ).toBeUndefined();
  });

  it('never displaces a group that is holding cards', () => {
    expect(rescueHome([group('g0', ['session-x']), group('g1', ['session-y'])])).toBeUndefined();
  });

  it('takes the FIRST empty grid group, so the rescue is deterministic', () => {
    expect(rescueHome([group('g1', []), group('g2', [])])?.id).toBe('g1');
  });
});
