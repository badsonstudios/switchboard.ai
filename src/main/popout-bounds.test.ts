import { describe, it, expect } from 'vitest';
import { parsePopoutFeatures } from './popout-bounds';

describe('parsePopoutFeatures', () => {
  it('maps dockview left/top/width/height to screen-absolute bounds', () => {
    // dockview builds: top=<screenY>,left=<screenX>,width=,height=
    expect(parsePopoutFeatures('top=540,left=-1920,width=800,height=600')).toEqual({
      x: -1920, // a monitor to the LEFT of primary — negative x is valid
      y: 540,
      width: 800,
      height: 600,
    });
  });

  it('returns empty for undefined/empty features (let Electron default)', () => {
    expect(parsePopoutFeatures(undefined)).toEqual({});
    expect(parsePopoutFeatures('')).toEqual({});
  });

  it('ignores non-finite and non-positive size fields', () => {
    // a garbage width/height must not produce a 0- or NaN-sized window
    expect(parsePopoutFeatures('left=100,top=100,width=0,height=NaN')).toEqual({
      x: 100,
      y: 100,
    });
  });

  it('rounds fractional coordinates (HiDPI can yield fractions)', () => {
    expect(parsePopoutFeatures('left=100.6,top=50.4,width=800.9,height=600.2')).toEqual({
      x: 101,
      y: 50,
      width: 801,
      height: 600,
    });
  });

  it('tolerates extra feature keys dockview or the browser may add', () => {
    expect(parsePopoutFeatures('menubar=no,left=10,top=20,width=300,height=400,noopener=1')).toEqual({
      x: 10,
      y: 20,
      width: 300,
      height: 400,
    });
  });
});
