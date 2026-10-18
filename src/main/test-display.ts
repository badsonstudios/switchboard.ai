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
  E2E_SETTINGS_FILE,
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
  if ('problem' in read) return { ...base, saved: { kind: 'none' }, readProblem: read.problem };
  return { ...base, saved: savedFrom(read.text, snap) };
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
  const file = testDisplayFile(home);
  const fail = (problem: string, code?: TestDisplayRefusal): TestDisplaySetResult => ({
    ok: false,
    problem,
    ...(code ? { code } : {}),
    state: readTestDisplayState(snap, home),
  });
  if (screenId !== null && (typeof screenId !== 'number' || !Number.isSafeInteger(screenId))) {
    return fail('not a screen', 'not-a-screen');
  }
  if (screenId !== null && !snap.screens.some((s) => s.id === screenId)) {
    return fail('that screen is not attached any more', 'not-attached');
  }
  const read = readFile(file);
  if ('problem' in read) return fail(read.problem);
  const value = screenId === null ? null : valueForScreen(snap.screens, snap.primaryId, screenId);
  const next = writeSettingsKey(
    // a file we are about to create says what it is, for whoever finds it
    read.text === '' && value !== null ? HEADER : read.text,
    E2E_MONITOR_ENV,
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

const HEADER =
  "# Which screen switchboard.ai's own automated tests open their windows on.\n" +
  '# Written by Settings > Advanced > Testing; one KEY=VALUE per line.\n';
