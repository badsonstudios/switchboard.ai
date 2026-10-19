// Settings → Advanced → Testing (#1331): main's half. It owns
// `~/.switchboard-e2e.env` — the per-machine file the e2e fixture reads to
// decide which screen this project's own test windows open on — so the
// renderer never touches the filesystem: it asks what is there, and names a
// SCREEN to switch to; main decides what to write.
//
// FAIL-OPEN, twice over:
//   - a file that cannot be read is shown as such and NOT written over — a
//     write would replace contents nobody has seen with a one-line file;
//   - a write that fails answers `{ ok: false, problem }` and the file is left
//     as it was (temp file + rename, so a half-written file is not a state).
//
// The home is a parameter for the unit tests, which must never reach the real
// `~`. In the app it is `os.homedir()`, which the e2e fixture points at the
// launch's temp home through USERPROFILE/HOME — so an e2e of the picker writes
// inside that temp home, never the developer's.
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  describeScreens,
  E2E_MONITOR_ENV,
  E2E_NO_ACTIVATE_ENV,
  E2E_NO_ACTIVATE_ON,
  E2E_SETTINGS_FILE,
  noActivateOn,
  readSettingsKey,
  resolveTestDisplay,
  valueForScreen,
  writeSettingsKey,
  type SavedTestDisplay,
  type ScreenFacts,
  type TestDisplayRefusal,
  type TestDisplaySetResult,
  type TestDisplayState,
} from '../shared/test-display';
import { errorText } from '../shared/error-text';
import type { IpcBroker } from './ipc/broker';

/** The displays as main sees them right now, plus which one is primary. */
export interface ScreenSnapshot {
  screens: ScreenFacts[];
  primaryId: number;
}

/** Electron's `screen`, reduced to the two calls this reads. */
export interface ScreenLike {
  getAllDisplays(): Array<{
    id: number;
    label?: string;
    bounds: { x: number; y: number; width: number; height: number };
    workArea: { x: number; y: number; width: number; height: number };
    scaleFactor: number;
  }>;
  getPrimaryDisplay(): { id: number };
}

export function snapshotScreens(screen: ScreenLike): ScreenSnapshot {
  return {
    screens: screen.getAllDisplays().map((d) => ({
      id: d.id,
      label: d.label ?? '',
      bounds: d.bounds,
      workArea: d.workArea,
      scaleFactor: d.scaleFactor,
    })),
    primaryId: screen.getPrimaryDisplay().id,
  };
}

export function testDisplayFile(home: string = os.homedir()): string {
  return path.join(home, E2E_SETTINGS_FILE);
}

/** The file's text: `''` when there is none, `{ problem }` when it cannot be read. */
function readFile(file: string): { text: string } | { problem: string } {
  try {
    return { text: fs.readFileSync(file, 'utf8') };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { text: '' };
    return { problem: errorText(err) };
  }
}

function savedFrom(text: string, snap: ScreenSnapshot): SavedTestDisplay {
  const value = readSettingsKey(text, E2E_MONITOR_ENV)?.trim();
  const r = resolveTestDisplay(snap.screens, snap.primaryId, value);
  if (!value || r.kind === 'off') return { kind: 'none' };
  if (r.kind === 'display') return { kind: 'attached', value, screenId: r.target.id };
  if (r.kind === 'primary') return { kind: 'attached', value, screenId: null };
  return { kind: r.kind, value };
}

export function readTestDisplayState(snap: ScreenSnapshot, home?: string): TestDisplayState {
  const file = testDisplayFile(home);
  const read = readFile(file);
  const base = { screens: describeScreens(snap.screens, snap.primaryId), file };
  if ('problem' in read) {
    return { ...base, saved: { kind: 'none' }, noActivate: false, readProblem: read.problem };
  }
  return {
    ...base,
    saved: savedFrom(read.text, snap),
    noActivate: noActivateOn(readSettingsKey(read.text, E2E_NO_ACTIVATE_ENV)),
  };
}

/**
 * Set one key of the file (`null` removes its line), keeping every other line.
 * The one write path both settings share: refuse a file that cannot be read,
 * write through a temp file + rename, answer the state as it now is.
 */
function writeKey(
  snap: ScreenSnapshot,
  key: string,
  value: string | null,
  home: string | undefined
): TestDisplaySetResult {
  const file = testDisplayFile(home);
  const fail = (problem: string): TestDisplaySetResult => ({
    ok: false,
    problem,
    state: readTestDisplayState(snap, home),
  });
  const read = readFile(file);
  if ('problem' in read) return fail(read.problem);
  const next = writeSettingsKey(
    // a file we are about to create (or an empty one) says what it is, for
    // whoever finds it
    read.text === '' && value !== null ? HEADER : read.text,
    key,
    value
  );
  if (next !== read.text) {
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, next, 'utf8');
      fs.renameSync(tmp, file);
    } catch (err) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        // the temp file is the least of it; the answer below says what failed
      }
      return fail(errorText(err));
    }
  }
  return { ok: true, state: readTestDisplayState(snap, home) };
}

/**
 * Run the tests on screen `screenId` — `null` for the primary (the default,
 * which removes the line). Every other line of the file is kept.
 */
export function writeTestDisplay(
  snap: ScreenSnapshot,
  screenId: unknown,
  home?: string
): TestDisplaySetResult {
  if (screenId !== null && (typeof screenId !== 'number' || !Number.isSafeInteger(screenId))) {
    return refuse(snap, home, 'not a screen', 'not-a-screen');
  }
  if (screenId !== null && !snap.screens.some((s) => s.id === screenId)) {
    return refuse(snap, home, 'that screen is not attached any more', 'not-attached');
  }
  const value = screenId === null ? null : valueForScreen(snap.screens, snap.primaryId, screenId);
  return writeKey(snap, E2E_MONITOR_ENV, value, home);
}

/**
 * Open the test windows without taking focus (#1335) — `SWITCHBOARD_E2E_NO_ACTIVATE`.
 * On writes `=1`; off REMOVES the line, because absent is what the fixture
 * reads as off and a `=0` line would be one more thing to explain. Anything
 * but a boolean is refused with the file untouched.
 */
export function writeTestNoActivate(
  snap: ScreenSnapshot,
  on: unknown,
  home?: string
): TestDisplaySetResult {
  if (typeof on !== 'boolean') return refuse(snap, home, 'not on or off', 'not-a-switch');
  return writeKey(snap, E2E_NO_ACTIVATE_ENV, on ? E2E_NO_ACTIVATE_ON : null, home);
}

/** A write refused before the file was touched: a code the renderer words. */
function refuse(
  snap: ScreenSnapshot,
  home: string | undefined,
  problem: string,
  code: TestDisplayRefusal
): TestDisplaySetResult {
  return { ok: false, problem, code, state: readTestDisplayState(snap, home) };
}

/**
 * The three invoke channels (#1331, #1335). The push half, `testDisplay:changed`,
 * is sent from main's display listeners. `home` is for the tests only.
 */
export function registerTestDisplayIpc(deps: {
  broker: Pick<IpcBroker, 'handle'>;
  snapshot: () => ScreenSnapshot;
  home?: string;
}): void {
  const { broker, snapshot, home } = deps;
  broker.handle('testDisplay:get', () => readTestDisplayState(snapshot(), home));
  broker.handle('testDisplay:set', (_e, screenId) => writeTestDisplay(snapshot(), screenId, home));
  broker.handle('testDisplay:setNoActivate', (_e, on) =>
    writeTestNoActivate(snapshot(), on, home)
  );
}

const HEADER =
  "# How switchboard.ai's own automated tests open their windows: which screen,\n" +
  '# and whether they take focus.\n' +
  '# Written by Settings > Advanced > Testing; one KEY=VALUE per line.\n';
