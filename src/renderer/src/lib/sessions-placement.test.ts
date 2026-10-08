// The left / top choice for the sessions list (#1143).
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SESSIONS_PLACEMENT,
  placementClick,
  sessionsPlacementOf,
} from './sessions-placement';

describe('reading the stored placement', () => {
  it('takes the two words it knows', () => {
    expect(sessionsPlacementOf('left')).toBe('left');
    expect(sessionsPlacementOf('top')).toBe('top');
  });

  it('reads anything else as the default, which is the left', () => {
    expect(DEFAULT_SESSIONS_PLACEMENT).toBe('left');
    for (const raw of [undefined, null, '', 'bottom', 'TOP', 1, true, {}, ['top']]) {
      expect(sessionsPlacementOf(raw)).toBe('left');
    }
  });
});

describe('one click on the left / top switch', () => {
  it('moves the list when the other half is clicked', () => {
    expect(placementClick({ placement: 'left', hidden: false }, 'top')).toEqual({
      placement: 'top',
      hidden: false,
    });
    expect(placementClick({ placement: 'top', hidden: false }, 'left')).toEqual({
      placement: 'left',
      hidden: false,
    });
  });

  it('puts the list away when the lit half is clicked, without forgetting where it was', () => {
    expect(placementClick({ placement: 'top', hidden: false }, 'top')).toEqual({
      placement: 'top',
      hidden: true,
    });
    expect(placementClick({ placement: 'left', hidden: false }, 'left')).toEqual({
      placement: 'left',
      hidden: true,
    });
  });

  it('brings a hidden list back in whichever half was clicked', () => {
    // either half, including the one it was hidden FROM: with the list away
    // neither half is lit, so there is no "lit half" for a click to mean "hide"
    expect(placementClick({ placement: 'top', hidden: true }, 'top')).toEqual({
      placement: 'top',
      hidden: false,
    });
    expect(placementClick({ placement: 'top', hidden: true }, 'left')).toEqual({
      placement: 'left',
      hidden: false,
    });
  });
});
