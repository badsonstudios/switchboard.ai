// The picker's half of the test-screen setting (#1331): the rows Settings
// draws, the value it writes, and the file edit. The resolver's value forms
// are pinned in `e2e/fixtures/app.test.ts`, beside the fixture that runs them;
// here they are only exercised through what Settings writes, which is the
// property that matters — every value written must resolve back to the screen
// that was picked.
import { describe, expect, it } from 'vitest';
import {
  describeScreens,
  E2E_MONITOR_ENV,
  readSettingsKey,
  resolveTestDisplay,
  screenPosition,
  valueForScreen,
  writeSettingsKey,
  type ScreenFacts,
} from './test-display';

const screen = (id: number, x: number, y: number, label = '', w = 2560, h = 1440, scale = 1.5): ScreenFacts => ({
  id,
  label,
  scaleFactor: scale,
  bounds: { x, y, width: w, height: h },
  workArea: { x, y, width: w, height: h - 48 },
});

// Dan's desk on 2026-10-17, as Electron reported it: three 4K panels at 150%,
// listed right, primary, left — deliberately not primary-first.
const PRIMARY = screen(756390797, 0, 0, 'LG HDR 4K');
const RIGHT = screen(1473062231, 2560, 0, 'LG HDR 4K');
const LEFT = screen(2452621004, -2560, 0, 'LG ULTRAFINE');
const DESK = [RIGHT, PRIMARY, LEFT];

describe('describeScreens — rows a person can tell apart', () => {
  it('puts the primary first and numbers the rest along the desk', () => {
    const rows = describeScreens(DESK, PRIMARY.id);
    expect(rows.map((r) => [r.number, r.id, r.position])).toEqual([
      [1, PRIMARY.id, 'primary'],
      [2, LEFT.id, 'left'],
      [3, RIGHT.id, 'right'],
    ]);
  });

  it('reports native pixels, not Electron’s scaled size', () => {
    // a 4K panel at 150% reports 2560x1440; the OS's own settings say 3840x2160
    const [primary] = describeScreens(DESK, PRIMARY.id);
    expect(primary).toMatchObject({ width: 3840, height: 2160, name: 'LG HDR 4K', primary: true });
  });

  it('copes with an unnamed screen and a scale factor of zero', () => {
    const [row] = describeScreens([{ ...screen(1, 0, 0, '  ', 1920, 1080, 0) }], 1);
    expect(row).toMatchObject({ name: '', width: 1920, height: 1080 });
  });
});

describe('screenPosition — edges, the way a person describes the desk', () => {
  const p = { x: 0, y: 0, width: 2560, height: 1440 };
  it.each([
    ['right', { x: 2560, y: 0, width: 1920, height: 1080 }],
    ['left', { x: -1920, y: 200, width: 1920, height: 1080 }],
    ['above', { x: 300, y: -1080, width: 1920, height: 1080 }],
    ['below', { x: 0, y: 1440, width: 2560, height: 1440 }],
    ['above-right', { x: 2560, y: -1080, width: 1920, height: 1080 }],
    ['below-left', { x: -1920, y: 1440, width: 1920, height: 1080 }],
    ['overlapping', { x: 100, y: 100, width: 1920, height: 1080 }],
  ])('%s', (want, box) => {
    expect(screenPosition(box, p)).toBe(want);
  });

  it('calls a TALL screen beside a short one "right", not "below-right"', () => {
    expect(screenPosition({ x: 2560, y: -400, width: 1440, height: 2560 }, p)).toBe('right');
  });
});

describe('valueForScreen — what Settings writes', () => {
  it('writes nothing for the primary: the default needs no line', () => {
    expect(valueForScreen(DESK, PRIMARY.id, PRIMARY.id)).toBeNull();
  });

  it('writes the direction word when the screen is alone that way — Dan’s file today', () => {
    expect(valueForScreen(DESK, PRIMARY.id, RIGHT.id)).toBe('right');
    expect(valueForScreen(DESK, PRIMARY.id, LEFT.id)).toBe('left');
  });

  it('writes the id when two screens share the direction', () => {
    const farRight = screen(9, 5120, 0);
    const desk = [PRIMARY, RIGHT, farRight];
    expect(valueForScreen(desk, PRIMARY.id, RIGHT.id)).toBe(`id:${RIGHT.id}`);
    expect(valueForScreen(desk, PRIMARY.id, farRight.id)).toBe('id:9');
  });

  it('tries the axis the screen is further along first, then the other', () => {
    // up a little and far to the right: "right" while it is the only one there
    const upRight = screen(7, 2560, -600);
    expect(valueForScreen([PRIMARY, upRight], PRIMARY.id, upRight.id)).toBe('right');
    // with another screen to the right, "above" still names it alone
    expect(valueForScreen([PRIMARY, upRight, RIGHT], PRIMARY.id, upRight.id)).toBe('above');
  });

  it('writes the id for a screen it cannot place against the primary', () => {
    expect(valueForScreen([RIGHT], PRIMARY.id, RIGHT.id)).toBe(`id:${RIGHT.id}`);
  });

  it('every value it writes resolves back to the screen that was picked', () => {
    // the property the whole feature rests on: Settings and the fixture agree
    const desks: ScreenFacts[][] = [
      DESK,
      [PRIMARY, RIGHT, screen(9, 5120, 0)],
      [PRIMARY, screen(4, 0, -1440), screen(5, 0, 1440), screen(6, 2560, -600), LEFT],
      [screen(10, 400, 400), PRIMARY], // overlapping (mirrored-ish) arrangement
    ];
    for (const desk of desks) {
      for (const d of desk) {
        const value = valueForScreen(desk, PRIMARY.id, d.id);
        const r = resolveTestDisplay(desk, PRIMARY.id, value);
        if (d.id === PRIMARY.id) expect(r.kind).toBe('off');
        else expect(r.kind === 'display' && r.target.id, `${value}`).toBe(d.id);
      }
    }
  });
});

describe('resolveTestDisplay — what a saved value means right now', () => {
  it.each([
    ['nothing saved', undefined, 'off'],
    ['blank', '  ', 'off'],
    ['monitor 1', '1', 'primary'],
    ['the primary’s id', `id:${PRIMARY.id}`, 'primary'],
    ['a word with a screen that way', 'right', 'display'],
    ['an id that is attached', `id:${LEFT.id}`, 'display'],
    ['a word with nothing that way', 'below', 'missing'],
    ['an index past the end', '9', 'missing'],
    ['an unplugged id', 'id:123', 'missing'],
    ['junk', 'the-big-one', 'invalid'],
    ['zero', '0', 'invalid'],
    ['a bad id', 'id:x', 'invalid'],
  ])('%s', (_what, value, kind) => {
    expect(resolveTestDisplay(DESK, PRIMARY.id, value).kind).toBe(kind);
  });

  it('the screen to the right unplugged: `right` is missing, so the tests run on the primary', () => {
    expect(resolveTestDisplay([PRIMARY, LEFT], PRIMARY.id, 'right').kind).toBe('missing');
  });
});

describe('writeSettingsKey — only this key changes', () => {
  const K = E2E_MONITOR_ENV;

  it('adds the key to an empty or missing file', () => {
    expect(writeSettingsKey('', K, 'right')).toBe(`${K}=right\n`);
  });

  it('replaces the value in place, keeping comments and other keys', () => {
    const before = `# my machine\nOTHER=1\n${K}=left\n\nLAST=x\n`;
    expect(writeSettingsKey(before, K, 'id:42')).toBe(`# my machine\nOTHER=1\n${K}=id:42\n\nLAST=x\n`);
  });

  it('keeps the file’s CRLF line endings', () => {
    expect(writeSettingsKey(`A=1\r\n${K}=2\r\n`, K, 'right')).toBe(`A=1\r\n${K}=right\r\n`);
  });

  it('appends to a file with no final newline, and gives it one', () => {
    expect(writeSettingsKey('A=1', K, 'left')).toBe(`A=1\n${K}=left\n`);
  });

  it('collapses several assignments into one, in the first one’s place', () => {
    expect(writeSettingsKey(`${K}=2\nA=1\n${K}=3\n`, K, 'below')).toBe(`${K}=below\nA=1\n`);
  });

  it('removes the key for the primary, and leaves everything else', () => {
    expect(writeSettingsKey(`# keep\nA=1\n  ${K} = "right"\n`, K, null)).toBe('# keep\nA=1\n');
  });

  it('removing the only line leaves an empty file', () => {
    expect(writeSettingsKey(`${K}=right\n`, K, null)).toBe('');
  });

  it('removing a key that is not there changes nothing — not even a newline', () => {
    expect(writeSettingsKey('A=1', K, null)).toBe('A=1');
  });

  it('never touches a commented-out line or a longer key', () => {
    const before = `#${K}=old\n${K}S=keep\n`;
    expect(writeSettingsKey(before, K, 'right')).toBe(`#${K}=old\n${K}S=keep\n${K}=right\n`);
  });

  it('round-trips through the reader the fixture uses', () => {
    for (const v of ['right', 'id:2452621004', 'left']) {
      expect(readSettingsKey(writeSettingsKey(`# x\nA=1\n${K}=2\n`, K, v), K)).toBe(v);
    }
    expect(readSettingsKey(writeSettingsKey(`${K}=2\n`, K, null), K)).toBeUndefined();
  });
});
