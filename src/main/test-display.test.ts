// Main's half of Settings → Advanced → Testing (#1331): the file round trip.
//
// EVERY test here passes a temp home. The real `~/.switchboard-e2e.env` is the
// developer's own setting, and a unit test that wrote it would move the next
// e2e run onto a different screen. The last test proves the default really is
// `os.homedir()` by pointing THAT at a temp dir too, never by using it.
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { cleanupTempDirs, tempDir } from '../test-temp-dirs';
import { E2E_MONITOR_ENV, E2E_SETTINGS_FILE, type ScreenFacts } from '../shared/test-display';
import {
  readTestDisplayState,
  snapshotScreens,
  testDisplayFile,
  writeTestDisplay,
  type ScreenSnapshot,
} from './test-display';

afterEach(() => {
  vi.restoreAllMocks();
  cleanupTempDirs();
});

const facts = (id: number, x: number, label = 'LG HDR 4K'): ScreenFacts => ({
  id,
  label,
  scaleFactor: 1.5,
  bounds: { x, y: 0, width: 2560, height: 1440 },
  workArea: { x, y: 0, width: 2560, height: 1392 },
});
const PRIMARY = facts(756390797, 0);
const RIGHT = facts(1473062231, 2560);
const LEFT = facts(2452621004, -2560, 'LG ULTRAFINE');
const DESK: ScreenSnapshot = { screens: [RIGHT, PRIMARY, LEFT], primaryId: PRIMARY.id };
const K = E2E_MONITOR_ENV;

function home(contents?: string): string {
  const dir = tempDir('sb-testdisplay-');
  if (contents !== undefined) fs.writeFileSync(path.join(dir, E2E_SETTINGS_FILE), contents);
  return dir;
}
const fileIn = (dir: string): string => fs.readFileSync(path.join(dir, E2E_SETTINGS_FILE), 'utf8');

describe('readTestDisplayState', () => {
  it('lists every screen, primary first, and says nothing is saved when there is no file', () => {
    const h = home();
    const s = readTestDisplayState(DESK, h);
    expect(s.screens.map((r) => r.id)).toEqual([PRIMARY.id, LEFT.id, RIGHT.id]);
    expect(s.saved).toEqual({ kind: 'none' });
    expect(s.file).toBe(path.join(h, E2E_SETTINGS_FILE));
    expect(s.readProblem).toBeUndefined();
  });

  it('reads Dan’s hand-written file as the screen to the right', () => {
    const s = readTestDisplayState(DESK, home(`# e2e windows go here\n${K}=right\n`));
    expect(s.saved).toEqual({ kind: 'attached', value: 'right', screenId: RIGHT.id });
  });

  it('says a saved screen is missing when it is unplugged', () => {
    const unplugged: ScreenSnapshot = { screens: [PRIMARY, LEFT], primaryId: PRIMARY.id };
    expect(readTestDisplayState(unplugged, home(`${K}=right\n`)).saved).toEqual({
      kind: 'missing',
      value: 'right',
    });
    expect(readTestDisplayState(DESK, home(`${K}=id:42\n`)).saved).toEqual({
      kind: 'missing',
      value: 'id:42',
    });
  });

  it('says a hand-written value it cannot read is not one the tests can use', () => {
    expect(readTestDisplayState(DESK, home(`${K}=the big one\n`)).saved).toEqual({
      kind: 'invalid',
      value: 'the big one',
    });
  });

  it('treats `1` as the primary, ticked as the default', () => {
    expect(readTestDisplayState(DESK, home(`${K}=1\n`)).saved).toEqual({
      kind: 'attached',
      value: '1',
      screenId: null,
    });
  });

  it('reports a file it cannot read, rather than throwing', () => {
    const h = home();
    fs.mkdirSync(path.join(h, E2E_SETTINGS_FILE)); // a directory where the file goes: EISDIR
    const s = readTestDisplayState(DESK, h);
    expect(s.readProblem).toBeTruthy();
    expect(s.saved).toEqual({ kind: 'none' });
  });
});

describe('writeTestDisplay — the file round trip', () => {
  it('creates the file with a header saying what it is', () => {
    const h = home();
    const r = writeTestDisplay(DESK, LEFT.id, h);
    expect(r.ok).toBe(true);
    expect(fileIn(h)).toMatch(/^# Which screen/);
    expect(fileIn(h).endsWith(`${K}=left\n`)).toBe(true);
    expect(r.state.saved).toEqual({ kind: 'attached', value: 'left', screenId: LEFT.id });
  });

  it('changes only its own line, keeping every other one', () => {
    const h = home(`# mine\r\nOTHER=keep\r\n${K}=right\r\n`);
    expect(writeTestDisplay(DESK, LEFT.id, h).ok).toBe(true);
    expect(fileIn(h)).toBe(`# mine\r\nOTHER=keep\r\n${K}=left\r\n`);
  });

  it('choosing the primary removes the line and keeps the rest', () => {
    const h = home(`OTHER=keep\n${K}=right\n`);
    const r = writeTestDisplay(DESK, null, h);
    expect(r.ok).toBe(true);
    expect(fileIn(h)).toBe('OTHER=keep\n');
    expect(r.state.saved).toEqual({ kind: 'none' });
  });

  it('choosing the primary with no file creates none', () => {
    const h = home();
    expect(writeTestDisplay(DESK, null, h).ok).toBe(true);
    expect(fs.existsSync(path.join(h, E2E_SETTINGS_FILE))).toBe(false);
  });

  it('writes the id when the screen shares its direction with another', () => {
    const farRight = facts(9, 5120);
    const snap: ScreenSnapshot = { screens: [PRIMARY, RIGHT, farRight], primaryId: PRIMARY.id };
    const h = home();
    writeTestDisplay(snap, RIGHT.id, h);
    expect(fileIn(h)).toContain(`${K}=id:${RIGHT.id}\n`);
  });

  it.each([
    ['a screen that is not attached', 12345],
    ['a string', '1473062231'],
    ['a fraction', 1.5],
    ['nothing', undefined],
  ])('refuses %s and leaves the file alone', (_what, id) => {
    const h = home(`${K}=right\n`);
    const r = writeTestDisplay(DESK, id, h);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.code).toBe(id === 12345 ? 'not-attached' : 'not-a-screen');
    expect(fileIn(h)).toBe(`${K}=right\n`);
    expect(r.state.saved).toEqual({ kind: 'attached', value: 'right', screenId: RIGHT.id });
  });

  it('does not write over a file it could not read', () => {
    const h = home();
    fs.mkdirSync(path.join(h, E2E_SETTINGS_FILE));
    const r = writeTestDisplay(DESK, LEFT.id, h);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.code).toBeUndefined(); // an I/O failure carries the OS's words
    expect(fs.statSync(path.join(h, E2E_SETTINGS_FILE)).isDirectory()).toBe(true);
  });

  it('answers a failed write with the problem, the file untouched, no temp file left', () => {
    const h = home(`${K}=right\n`);
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
    });
    const r = writeTestDisplay(DESK, LEFT.id, h);
    expect(r).toMatchObject({ ok: false });
    expect(!r.ok && r.problem).toMatch(/EPERM/);
    expect(fileIn(h)).toBe(`${K}=right\n`);
    expect(fs.readdirSync(h)).toEqual([E2E_SETTINGS_FILE]);
  });

  it('defaults to os.homedir() — pointed at a temp dir here, never the real one', () => {
    const h = home();
    vi.spyOn(os, 'homedir').mockReturnValue(h);
    expect(testDisplayFile()).toBe(path.join(h, E2E_SETTINGS_FILE));
    writeTestDisplay(DESK, RIGHT.id);
    expect(fileIn(h)).toContain(`${K}=right\n`);
  });
});

describe('snapshotScreens', () => {
  it('reads Electron’s screen, tolerating a display with no label', () => {
    const snap = snapshotScreens({
      getAllDisplays: () => [
        { id: 1, bounds: PRIMARY.bounds, workArea: PRIMARY.workArea, scaleFactor: 1 },
        { id: 2, label: 'Dell', bounds: RIGHT.bounds, workArea: RIGHT.workArea, scaleFactor: 2 },
      ],
      getPrimaryDisplay: () => ({ id: 1 }),
    });
    expect(snap.primaryId).toBe(1);
    expect(snap.screens.map((s) => s.label)).toEqual(['', 'Dell']);
  });
});
