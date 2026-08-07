import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp' },
  screen: { getAllDisplays: () => [] },
  BrowserWindow: class {},
}));

import {
  WorkspaceStore,
  displayFingerprint,
  PersistedSession,
  CURRENT_VERSION,
  PLACEHOLDER_GROUP_NAME,
} from './store';
import { Logger } from '../log/logger';
import { cleanupTempDirs, tempDir } from '../../test-temp-dirs';

let dir: string;
let file: string;
beforeEach(() => {
  dir = tempDir('sb-ws-');
  file = path.join(dir, 'workspace.json');
});

/**
 * `new WorkspaceStore(...)`, registered so teardown can flush it.
 *
 * EVERY store in this file goes through it, and that is load-bearing for the
 * cleanup below rather than a style choice — see `afterEach` (#213).
 */
const stores: WorkspaceStore[] = [];
function makeStore(...args: ConstructorParameters<typeof WorkspaceStore>): WorkspaceStore {
  const s = new WorkspaceStore(...args);
  stores.push(s);
  return s;
}

// One workspace dir per test, deleted at the end of it — but FLUSH FIRST.
//
// `saveSoon()` arms a 500ms unref'd timer, and `save()` mkdirs its parent
// before writing. A debounced save that fires AFTER the rm therefore RECREATES
// the directory, in a worker that is still alive, with nothing left tracking it
// — neither this hook nor `test-setup.ts`'s `afterAll` net can take it. The
// result looks exactly like a Windows lock race and is not one.
//
// MEASURED: 8-9 stray `sb-ws-*` folders per full unit run. Running this file
// ALONE leaks zero, because the process exits before an unref'd timer can fire
// — which is how the first pass of #213 called this file clean.
//
// `save()` clears the timer before it writes, so this is as much a cancel as a
// flush. Every store is flushed rather than only the dirty ones: a clean
// store's save just rewrites what is already on disk.
afterEach(() => {
  for (const s of stores.splice(0, stores.length)) {
    try {
      s.save();
    } catch {
      /* teardown never throws — a failed flush is a leaked dir, not a red test */
    }
  }
  cleanupTempDirs();
});

const sess = (id: string, slot = 0): PersistedSession => ({
  id,
  identity: { title: id, folder: `C:/tmp/${id}`, providerId: 'claude-code' },
  layoutSlot: slot,
  nativeSessionId: `native-${id}`,
  suspendedAt: '2026-07-19T00:00:00.000Z',
});

const primary = { x: 0, y: 0, width: 1920, height: 1040 };
const left = { x: -1920, y: 0, width: 1920, height: 1040 };

describe('WorkspaceStore (done-when: quit -> relaunch reproduces exactly)', () => {
  it('save + fresh load round-trips sessions and window byte-exactly', () => {
    const a = makeStore(file);
    a.load();
    a.upsertSession(sess('one', 0));
    a.upsertSession(sess('two', 3));
    a.setWindow({
      bounds: { x: 10, y: 20, width: 1200, height: 800 },
      isMaximized: false,
      displayFingerprint: displayFingerprint([primary, left]),
    });
    a.save();

    const b = makeStore(file); // "relaunch"
    const restored = b.load();
    expect(restored).toEqual(a.snapshot());
    expect(restored.sessions.map((s) => s.id)).toEqual(['one', 'two']);
    expect(restored.sessions[1].layoutSlot).toBe(3);
    expect(restored.sessions[1].nativeSessionId).toBe('native-two');
  });

  it('upsert replaces by id; remove drops', () => {
    const st = makeStore(file);
    st.load();
    st.upsertSession(sess('a', 0));
    st.upsertSession({ ...sess('a', 5) });
    expect(st.snapshot().sessions).toHaveLength(1);
    expect(st.snapshot().sessions[0].layoutSlot).toBe(5);
    st.removeSession('a');
    expect(st.snapshot().sessions).toHaveLength(0);
  });

  it('corrupt file: backed aside, fresh start, no throw', () => {
    fs.writeFileSync(file, '{not json!!');
    const st = makeStore(file);
    const s = st.load();
    expect(s.sessions).toEqual([]);
    expect(fs.existsSync(`${file}.corrupt`)).toBe(true);
  });

  it('garbage session entries are filtered on load', () => {
    fs.writeFileSync(
      file,
      JSON.stringify({ version: 1, sessions: [sess('ok'), { id: 42 }, 'x'], window: null })
    );
    const st = makeStore(file);
    expect(st.load().sessions.map((s) => s.id)).toEqual(['ok']);
  });
});

describe('missing-display rescue (done-when part 2)', () => {
  it('same arrangement: exact geometry restored', () => {
    const st = makeStore(file);
    st.load();
    st.setWindow({
      bounds: { x: -1800, y: 50, width: 800, height: 600 },
      isMaximized: false,
      displayFingerprint: displayFingerprint([primary, left]),
    });
    const w = st.restoreWindow([primary, left]);
    expect(w.bounds).toEqual({ x: -1800, y: 50, width: 800, height: 600 });
  });

  it('display gone + bounds off every remaining display: rescue to centered, keep maximized', () => {
    const st = makeStore(file);
    st.load();
    st.setWindow({
      bounds: { x: -1800, y: 50, width: 800, height: 600 }, // on the left display
      isMaximized: true,
      displayFingerprint: displayFingerprint([primary, left]),
    });
    const w = st.restoreWindow([primary]); // left display unplugged
    expect(w.bounds).toBeNull();
    expect(w.isMaximized).toBe(true);
  });

  it('arrangement changed but bounds still visible: keep them', () => {
    const st = makeStore(file);
    st.load();
    st.setWindow({
      bounds: { x: 100, y: 100, width: 800, height: 600 },
      isMaximized: false,
      displayFingerprint: displayFingerprint([primary, left]),
    });
    const w = st.restoreWindow([primary]);
    expect(w.bounds).toEqual({ x: 100, y: 100, width: 800, height: 600 });
  });
});

describe('persistent groups (P2-E12-01: durable containers, empty ≠ gone)', () => {
  const grp = (id: string, name = id) => ({ id, name, color: '#4a90d9' });

  it('groups round-trip a save/load; an EMPTY group persists', () => {
    const a = makeStore(file);
    a.load();
    a.upsertGroup(grp('g1', 'IT'));
    a.save();
    const b = makeStore(file);
    expect(b.load().groups).toEqual([grp('g1', 'IT')]);
  });

  it('membership round-trips; delete-group drops members to ungrouped', () => {
    const st = makeStore(file);
    st.load();
    st.upsertGroup(grp('g1'));
    st.upsertSession({ ...sess('a'), groupId: 'g1' });
    st.upsertSession(sess('b'));
    expect(st.snapshot().sessions[0].groupId).toBe('g1');
    st.removeGroup('g1');
    const s = st.snapshot();
    expect(s.groups).toEqual([]);
    expect(s.sessions.every((x) => x.groupId === undefined)).toBe(true);
  });

  it('setSessionGroup validates: unknown group is a no-op, null clears', () => {
    const st = makeStore(file);
    st.load();
    st.upsertGroup(grp('g1'));
    st.upsertSession(sess('a'));
    st.setSessionGroup('a', 'nope');
    expect(st.snapshot().sessions[0].groupId).toBeUndefined();
    st.setSessionGroup('a', 'g1');
    expect(st.snapshot().sessions[0].groupId).toBe('g1');
    st.setSessionGroup('a', null);
    expect(st.snapshot().sessions[0].groupId).toBeUndefined();
  });

  it('load filters garbage groups and clears dangling groupIds', () => {
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        sessions: [{ ...sess('a'), groupId: 'ghost' }],
        groups: [grp('g1'), { id: 1 }, 'x', { id: 'g2' }],
        window: null,
      })
    );
    const st = makeStore(file);
    const s = st.load();
    expect(s.groups.map((g) => g.id)).toEqual(['g1']);
    expect(s.sessions[0].groupId).toBeUndefined(); // 'ghost' didn't survive
  });

  it('update-in-place: rename/recolor via upsert keeps one record', () => {
    const st = makeStore(file);
    st.load();
    st.upsertGroup(grp('g1', 'Dev'));
    st.upsertGroup({ id: 'g1', name: 'DevOps', color: '#aa3366' });
    expect(st.snapshot().groups).toEqual([{ id: 'g1', name: 'DevOps', color: '#aa3366' }]);
  });
});

describe('notification prefs merge-patch (review P1 #13)', () => {
  it('toggling enabled does not wipe osToasts or quiet hours', () => {
    const st = makeStore(file);
    st.load();
    st.setNotificationPrefs({ osToasts: true, quietStart: '22:00', quietEnd: '07:00' });
    st.setNotificationPrefs({ enabled: false }); // the UI's only call shape
    expect(st.getNotificationPrefs()).toEqual({
      enabled: false,
      osToasts: true,
      quietStart: '22:00',
      quietEnd: '07:00',
    });
    st.setNotificationPrefs({ osToasts: false });
    expect(st.getNotificationPrefs()).toMatchObject({ enabled: false, osToasts: false });
  });
});

describe('update prefs (P2-E19-03)', () => {
  it('defaults to auto-check ON with nothing skipped', () => {
    const st = makeStore(file);
    st.load();
    expect(st.getUpdatePrefs()).toEqual({ autoCheck: true });
  });

  it('round-trips through the file, and merge-patches like the other prefs', () => {
    const a = makeStore(file);
    a.load();
    a.setUpdatePrefs({ skippedVersion: '0.2.0' });
    a.setUpdatePrefs({ lastCheck: '2026-08-05T10:00:00.000Z' }); // main's own bookkeeping
    a.setUpdatePrefs({ autoCheck: false }); // the About-panel toggle's only shape
    a.save();
    const b = makeStore(file);
    b.load();
    expect(b.getUpdatePrefs()).toEqual({
      autoCheck: false,
      skippedVersion: '0.2.0',
      lastCheck: '2026-08-05T10:00:00.000Z',
    });
  });

  it('reads a hand-edited or hostile file tolerantly', () => {
    // A `skippedVersion` of null must not become the string "null" and
    // suppress a release nobody skipped.
    fs.writeFileSync(
      file,
      JSON.stringify({ version: 1, updates: { autoCheck: 'yes', skippedVersion: null, lastCheck: 7 } })
    );
    const st = makeStore(file);
    st.load();
    expect(st.getUpdatePrefs()).toEqual({ autoCheck: true });
  });

  it('a file written before this feature existed simply gets the defaults', () => {
    fs.writeFileSync(file, JSON.stringify({ version: 1, sessions: [], autoTrust: false }));
    const st = makeStore(file);
    st.load();
    expect(st.getUpdatePrefs()).toEqual({ autoCheck: true });
    expect(st.getAutoTrust()).toBe(false); // …and nothing else moved
  });

  it('two stores do not share the defaults object', () => {
    const a = makeStore(file);
    a.load();
    a.setUpdatePrefs({ skippedVersion: '9.9.9' });
    const b = makeStore(path.join(dir, 'other.json'));
    b.load();
    expect(b.getUpdatePrefs()).toEqual({ autoCheck: true });
  });
});

describe('ui blob (P2-E12-08 focus/view-tab state)', () => {
  it('round-trips opaque ui state', () => {
    const a = makeStore(file);
    a.load();
    a.setUi({ focusedCardId: 'c1', 'viewTab.c1': 'terminal', autonomy: 'plan' });
    a.save();
    const b = makeStore(file);
    b.load();
    expect(b.getUi()).toEqual({ focusedCardId: 'c1', 'viewTab.c1': 'terminal', autonomy: 'plan' });
  });
});

/** A logger that keeps only what was warned about, for the assertions below. */
type Line = { msg: string; fields?: Record<string, unknown> };
const fakeLogger = (warns: Line[]): Logger => {
  const l: Logger = {
    debug: () => {},
    info: () => {},
    warn: (msg, fields) => warns.push({ msg, fields }),
    error: () => {},
    child: () => l,
  };
  return l;
};

describe('a failed save is audible (#165)', () => {
  it('a write that throws still fails open — but says so, naming the file and the cause', () => {
    const warns: Line[] = [];
    const st = makeStore(file, fakeLogger(warns));
    st.load();
    st.upsertSession(sess('a', 0));

    const boom = new Error('EPERM: operation not permitted, rename');
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw boom;
    });
    try {
      // fail-open holds: a doomed save must never propagate into the caller,
      // which on the quit path is an Electron `close` handler (#86)
      expect(() => st.save()).not.toThrow();
    } finally {
      spy.mockRestore();
    }

    expect(warns).toHaveLength(1);
    expect(warns[0].msg).toMatch(/workspace save failed/);
    expect(warns[0].fields).toMatchObject({ file, error: expect.stringContaining('EPERM') });
  });

  it('a save that works stays silent', () => {
    const warns: Line[] = [];
    const st = makeStore(file, fakeLogger(warns));
    st.load();
    st.upsertSession(sess('a', 0));
    st.save();
    expect(warns).toEqual([]);
    expect(makeStore(file).load().sessions.map((x) => x.id)).toEqual(['a']);
  });
});

// The app cannot write one of these: `groups:create`/`groups:update` have
// always refused an empty name. A hand-edited or half-written file can, and a
// group's name IS the thing you double-click to rename it — blank renders
// zero-width, so the group becomes unreachable. Load has to hold the invariant
// too, and it has to REPAIR rather than drop: dropping the group takes its
// membership with it (every session inside falls back to ungrouped), which
// spends real structure to pay for one bad field.
describe('a blank group name is repaired on load (#327)', () => {
  const write = (groups: unknown[], sessions: PersistedSession[] = []): void =>
    fs.writeFileSync(file, JSON.stringify({ version: 1, sessions, groups, window: null }));

  it('an empty name becomes a placeholder — the group and its members survive', () => {
    write(
      [{ id: 'g1', name: '', color: '#4a90d9', notifyScope: 'muted' }],
      [{ ...sess('a'), groupId: 'g1' }]
    );
    const s = makeStore(file).load();

    expect(s.groups).toEqual([
      { id: 'g1', name: 'Untitled group', color: '#4a90d9', notifyScope: 'muted' },
    ]);
    // the whole point of repairing instead of dropping
    expect(s.sessions[0].groupId).toBe('g1');
  });

  it('a whitespace-only name counts as blank — it renders just as empty', () => {
    write([{ id: 'g1', name: ' \t\n ', color: '#4a90d9' }]);
    expect(makeStore(file).load().groups[0].name).toBe(PLACEHOLDER_GROUP_NAME);
  });

  it('a name that renders is left exactly as written, padding and all', () => {
    write([
      { id: 'g1', name: 'IT', color: '#4a90d9' },
      { id: 'g2', name: '  Dev  ', color: '#8f6fd8' },
    ]);
    const warns: Line[] = [];
    const s = makeStore(file, fakeLogger(warns)).load();
    expect(s.groups.map((g) => g.name)).toEqual(['IT', '  Dev  ']);
    expect(warns).toEqual([]);
  });

  it('the repair is audible, naming the group it renamed', () => {
    write([
      { id: 'g1', name: 'IT', color: '#4a90d9' },
      { id: 'g2', name: '', color: '#8f6fd8' },
    ]);
    const warns: Line[] = [];
    makeStore(file, fakeLogger(warns)).load();
    expect(warns).toHaveLength(1);
    expect(warns[0].msg).toMatch(/blank name/i);
    expect(warns[0].fields).toMatchObject({ file, groupId: 'g2' });
  });

  it('the repaired name is what the next save writes — the file heals', () => {
    write([{ id: 'g1', name: '', color: '#4a90d9' }]);
    const st = makeStore(file);
    st.load();
    st.save();
    expect(makeStore(file).load().groups[0].name).toBe(PLACEHOLDER_GROUP_NAME);
    expect(fs.readFileSync(file, 'utf8')).toContain(PLACEHOLDER_GROUP_NAME);
  });

  it('a structurally broken group is still DROPPED — repair is for recoverable fields', () => {
    write([{ id: 'g1', name: 42, color: '#4a90d9' }, { id: 'g2', color: '#8f6fd8' }]);
    expect(makeStore(file).load().groups).toEqual([]);
  });
});

describe('schema version dispatch (P2-E15-13, §5.26 / AR-P2-9)', () => {
  /** A file on disk with an arbitrary `version` value and real content. */
  const writeFile = (version: unknown): void =>
    fs.writeFileSync(
      file,
      JSON.stringify({
        version,
        sessions: [sess('a', 2)],
        groups: [{ id: 'g1', name: 'IT', color: '#4a90d9' }],
        window: null,
        layout: { grid: 'opaque' },
        ui: { focusedCardId: 'a' },
      })
    );

  it.each([
    ['absent', undefined],
    ['v0', 0],
    ['v1', 1],
    ['a v1 string', '1'],
    ['unusable garbage', 'abc'],
    ['null', null],
  ])('%s loads as v1 — sanitized, writable, and silent', (_label, version) => {
    writeFile(version);
    const warns: Line[] = [];
    const st = makeStore(file, fakeLogger(warns));
    const s = st.load();

    expect(s.version).toBe(CURRENT_VERSION);
    expect(s.sessions.map((x) => x.id)).toEqual(['a']);
    expect(s.groups.map((g) => g.id)).toEqual(['g1']);
    expect(s.layout).toEqual({ grid: 'opaque' });
    expect(st.isReadOnly()).toBe(false);
    expect(warns).toEqual([]);

    st.upsertSession(sess('b', 3));
    st.save();
    expect(makeStore(file).load().sessions.map((x) => x.id)).toEqual(['a', 'b']);
  });

  it('a FUTURE version loads read-only: shown in memory, never written back', () => {
    writeFile(99);
    const before = fs.readFileSync(file, 'utf8');
    const warns: Line[] = [];
    const st = makeStore(file, fakeLogger(warns));
    const s = st.load();

    // fail-open: the app still boots on what it recognizes
    expect(s.sessions.map((x) => x.id)).toEqual(['a']);
    expect(s.groups.map((g) => g.id)).toEqual(['g1']);
    expect(st.isReadOnly()).toBe(true);

    // ...but nothing this run does can overwrite the newer file
    st.upsertSession(sess('b', 3));
    st.setUi({ wiped: true });
    st.removeSession('a');
    st.save();
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);
  });

  it('a FUTURE version says so in the log, naming both versions', () => {
    writeFile(CURRENT_VERSION + 1);
    const warns: Line[] = [];
    makeStore(file, fakeLogger(warns)).load();
    expect(warns).toHaveLength(1);
    expect(warns[0].msg).toMatch(/newer version/i);
    expect(warns[0].fields).toMatchObject({
      fileVersion: CURRENT_VERSION + 1,
      supportedVersion: CURRENT_VERSION,
    });
  });

  it('a numeric STRING version is coerced, not read as v1 and overwritten', () => {
    writeFile(String(CURRENT_VERSION + 1)); // sloppy writer, still from the future
    const st = makeStore(file);
    st.load();
    expect(st.isReadOnly()).toBe(true);
  });

  it('read-only survives the debounce: saveSoon never fires a write', () => {
    vi.useFakeTimers();
    try {
      writeFile(CURRENT_VERSION + 1);
      const before = fs.readFileSync(file, 'utf8');
      const st = makeStore(file);
      st.load();
      st.upsertSession(sess('b', 3)); // goes through saveSoon()
      expect(vi.getTimerCount()).toBe(0); // no pointless write is even armed
      vi.runAllTimers();
      expect(fs.readFileSync(file, 'utf8')).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it('read-only is per-load, not sticky', () => {
    writeFile(CURRENT_VERSION + 1);
    const st = makeStore(file);
    st.load();
    expect(st.isReadOnly()).toBe(true);
    writeFile(CURRENT_VERSION); // e.g. the user restored a backup
    st.load();
    expect(st.isReadOnly()).toBe(false);
    st.upsertSession(sess('b', 3));
    st.save();
    expect(makeStore(file).load().sessions.map((x) => x.id)).toEqual(['a', 'b']);
  });

  it.each([
    ['valid JSON that is not a workspace', 'null'],
    ['a bare array', '[1,2]'],
  ])('%s is backed aside and restarts writable', (_label, content) => {
    fs.writeFileSync(file, content);
    const st = makeStore(file);
    const s = st.load();
    expect(s.sessions).toEqual([]);
    expect(st.isReadOnly()).toBe(false);
    expect(fs.existsSync(`${file}.corrupt`)).toBe(true);
  });

  // Latent since P1-E2-04, surfaced by the stores this suite builds: the
  // fresh-start state used to alias the module-level EMPTY, so one store's
  // groups leaked into the next store's "empty" workspace.
  it('two stores that both start empty do not share state', () => {
    fs.writeFileSync(file, '{not json'); // forces the fresh-start path
    const a = makeStore(file);
    a.load();
    a.upsertGroup({ id: 'g1', name: 'IT', color: '#4a90d9' });
    a.upsertSession(sess('a'));

    const other = path.join(dir, 'other.json');
    const b = makeStore(other);
    expect(b.load().groups).toEqual([]);
    expect(b.snapshot().sessions).toEqual([]);
  });
});

describe('fingerprint stability', () => {
  it('is order-independent', () => {
    expect(displayFingerprint([primary, left])).toBe(displayFingerprint([left, primary]));
  });
});
