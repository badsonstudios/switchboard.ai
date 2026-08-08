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

/**
 * The `workspace.json.corrupt-<stamp>` post-mortems sitting beside `file`,
 * oldest first (#349). Fixed-width ISO stamps make a name sort chronological.
 */
const setAsides = (): string[] =>
  fs
    .readdirSync(dir)
    .filter((n) => n.startsWith('workspace.json.corrupt-'))
    .sort();

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
    expect(setAsides()).toHaveLength(1);
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

// Every one of these repairs used to happen in silence — the whole-file one
// most loudly of all: `void err;` threw away the parse error, the fact, and the
// path the corpse went to, and the user got "my workspace is suddenly empty"
// with nothing written anywhere to explain it. Nothing is surfaced in the UI
// (that posture question is #207); the log line IS the diagnosis, so it has to
// name what was lost and why.
describe('load-time repairs are audible (#344)', () => {
  const write = (content: unknown): void =>
    fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  /** Load `file` with a capturing logger and hand back what it warned about. */
  const loadWarns = (): Line[] => {
    const warns: Line[] = [];
    makeStore(file, fakeLogger(warns)).load();
    return warns;
  };

  describe('the whole file is unreadable', () => {
    it('says so, naming the cause and where the bad file went', () => {
      write('{not json!!');
      const warns = loadWarns();

      expect(warns).toHaveLength(1);
      expect(warns[0].msg).toMatch(/workspace file could not be read/i);
      // the WHY: whatever JSON.parse objected to, verbatim
      expect(warns[0].fields).toMatchObject({
        file,
        error: expect.stringContaining('JSON'),
        // a timestamped name since #349, and the line names the exact one
        setAside: expect.stringMatching(/\.corrupt-\d{4}-\d\d-\d\dT[\d.-]+Z$/),
      });
      // followable: the path in the log is a file that is really there
      expect(fs.existsSync(String(warns[0].fields?.setAside))).toBe(true);
      expect(setAsides()).toHaveLength(1);
    });

    it('names the deliberate throw for valid JSON that is not a workspace', () => {
      write('[1,2]');
      const warns = loadWarns();
      expect(warns).toHaveLength(1);
      expect(warns[0].fields?.error).toMatch(/not a JSON object/);
    });

    it('a missing file is first launch, not a fault — silent', () => {
      expect(fs.existsSync(file)).toBe(false);
      expect(loadWarns()).toEqual([]);
    });

    it('a failed set-aside copy is reported in the same line, not swallowed', () => {
      write('{not json!!');
      const spy = vi.spyOn(fs, 'copyFileSync').mockImplementation(() => {
        throw new Error('EPERM: operation not permitted, copyfile');
      });
      let warns: Line[];
      try {
        warns = loadWarns();
      } finally {
        spy.mockRestore();
      }

      expect(warns).toHaveLength(1);
      expect(warns[0].fields).toMatchObject({ setAsideError: expect.stringContaining('EPERM') });
      expect(warns[0].fields?.setAside).toBeUndefined(); // nothing was set aside to point at
    });
  });

  describe('field-level repairs', () => {
    it('dropped session entries are counted', () => {
      write({ version: 1, sessions: [sess('ok'), { id: 42 }, 'x'] });
      const warns = loadWarns();
      expect(warns).toHaveLength(1);
      expect(warns[0].msg).toMatch(/session entries .* were unusable/);
      expect(warns[0].fields).toMatchObject({ file, dropped: 2, kept: 1 });
    });

    it('dropped group entries are counted, and dangling members are named', () => {
      write({
        version: 1,
        sessions: [{ ...sess('a'), groupId: 'ghost' }],
        groups: [{ id: 'g1', name: 'IT', color: '#4a90d9' }, { id: 'g2' }],
      });
      const warns = loadWarns();
      expect(warns.map((w) => w.msg)).toEqual([
        expect.stringMatching(/group entries .* were unusable/),
        expect.stringMatching(/named a group that is not in it/),
      ]);
      expect(warns[0].fields).toMatchObject({ dropped: 1, kept: 1 });
      expect(warns[1].fields).toMatchObject({ file, sessionIds: ['a'] });
    });

    it('a list that is not a list loses everything in it — and says which list', () => {
      write({ version: 1, sessions: { a: 1 }, groups: 'nope' });
      expect(loadWarns().map((w) => w.msg)).toEqual([
        expect.stringMatching(/^the group list .* was not a list/),
        expect.stringMatching(/^the session list .* was not a list/),
      ]);
    });

    it('an ignored window rect says so, and which field was unusable', () => {
      write({
        version: 1,
        window: { bounds: { x: 0, y: 0, width: 10, height: 10 }, displayFingerprint: 'fp' },
      });
      const warns = loadWarns();
      expect(warns).toHaveLength(1);
      expect(warns[0].msg).toMatch(/saved window position .* unusable — opening centred/);
      expect(warns[0].fields).toMatchObject({ file, unusable: ['bounds'] });
    });

    it('a window record with no fingerprint is ignored whole', () => {
      write({ version: 1, window: { bounds: { x: 1, y: 2, width: 800, height: 600 } } });
      expect(loadWarns()[0].fields).toMatchObject({ unusable: ['displayFingerprint'] });
    });

    // The rect survived, so the window opens exactly where it was saved: a line
    // promising a centred window would be a confidently wrong diagnosis.
    it('a repair that does NOT move the window says the smaller thing', () => {
      write({
        version: 1,
        window: {
          bounds: { x: 1, y: 2, width: 800, height: 600 },
          isMaximized: 'yes',
          displayFingerprint: 'fp',
        },
      });
      const warns = loadWarns();
      expect(warns).toHaveLength(1);
      expect(warns[0].msg).toMatch(/^part of the saved window state/);
      expect(warns[0].msg).not.toMatch(/centred/);
      expect(warns[0].fields).toMatchObject({ unusable: ['isMaximized'] });
    });

    it('a rescued window (bounds legitimately null) stays silent', () => {
      write({ version: 1, window: { bounds: null, isMaximized: true, displayFingerprint: 'fp' } });
      expect(loadWarns()).toEqual([]);
    });

    it('defaulted notification prefs name the keys that were thrown out', () => {
      write({ version: 1, notifications: { enabled: 'yes', quietStart: 7 } });
      const warns = loadWarns();
      expect(warns).toHaveLength(1);
      expect(warns[0].msg).toMatch(/notification settings .* were unusable/);
      expect(warns[0].fields).toMatchObject({ file, unusable: ['enabled', 'quietStart'] });
    });

    it('defaulted update prefs name the keys that were thrown out', () => {
      write({ version: 1, updates: { autoCheck: 'yes', skippedVersion: null, lastCheck: 7 } });
      const warns = loadWarns();
      expect(warns).toHaveLength(1);
      expect(warns[0].msg).toMatch(/update settings .* were unusable/);
      // `skippedVersion: null` is "nothing skipped", not a broken value
      expect(warns[0].fields).toMatchObject({ unusable: ['autoCheck', 'lastCheck'] });
    });

    it('a prefs block that is not an object is one repair, not four', () => {
      write({ version: 1, notifications: 'off', updates: 3 });
      expect(loadWarns().map((w) => w.fields?.unusable)).toEqual([['notifications'], ['updates']]);
    });

    // `typeof [] === 'object'`, so an array block would otherwise slip past the
    // block check, find no bad FIELDS, and lose every setting in silence.
    it('an array where a settings block belongs is caught, not walked', () => {
      write({ version: 1, notifications: [], updates: [], window: [] });
      expect(loadWarns().map((w) => w.fields?.unusable)).toEqual([
        ['window'],
        ['notifications'],
        ['updates'],
      ]);
    });

    it('a non-boolean auto-trust says it stayed on', () => {
      write({ version: 1, autoTrust: 'sure' });
      const warns = loadWarns();
      expect(warns).toHaveLength(1);
      expect(warns[0].msg).toMatch(/auto-trust .* leaving it on/);
    });
  });

  // A file from the FUTURE is not damaged — this build just cannot read all of
  // it, and never writes it back. "those cards do not come back" would be a lie
  // about a file that still has them, and it would bury the one line that
  // explains the whole situation.
  it('a file from a newer version reports only that — its unread fields are not "repairs"', () => {
    write({
      version: CURRENT_VERSION + 1,
      sessions: [sess('a'), { shapeThisBuildCannotRead: true }],
      notifications: { enabled: 'sometimes' },
    });
    const warns = loadWarns();
    expect(warns).toHaveLength(1);
    expect(warns[0].msg).toMatch(/newer version/i);
  });

  // The whole reason the notes are collected and emitted after the load: a warn
  // raised inside the try would be caught by the corrupt-file handler, and a
  // dangling groupId would cost the user their entire workspace.
  it('a logger that throws costs nothing — no wipe, no .corrupt, no exception', () => {
    write({ version: 1, sessions: [{ ...sess('a'), groupId: 'ghost' }] });
    const angry: Logger = {
      debug: () => {},
      info: () => {},
      warn: () => {
        throw new Error('the log volume is full');
      },
      error: () => {},
      child: () => angry,
    };
    const st = makeStore(file, angry);

    let loaded: ReturnType<typeof st.load> | undefined;
    expect(() => (loaded = st.load())).not.toThrow();
    expect(loaded?.sessions.map((s) => s.id)).toEqual(['a']); // the repair still happened
    expect(setAsides()).toEqual([]); // and nothing was thrown away
  });

  it('a whole, healthy file is silent — every field set, nothing repaired', () => {
    write({
      version: 1,
      sessions: [{ ...sess('a'), groupId: 'g1' }],
      groups: [{ id: 'g1', name: 'IT', color: '#4a90d9' }],
      window: {
        bounds: { x: 0, y: 0, width: 1200, height: 800 },
        isMaximized: false,
        displayFingerprint: 'fp',
      },
      layout: { grid: 'opaque' },
      ui: { focusedCardId: 'a' },
      notifications: { enabled: true, osToasts: false, quietStart: '22:00', quietEnd: '07:00' },
      autoTrust: false,
      updates: { autoCheck: false, skippedVersion: '0.2.0' },
    });
    expect(loadWarns()).toEqual([]);
  });

  it('a file this app just wrote reloads silently — the repairs never fire on our own output', () => {
    const a = makeStore(file);
    a.load();
    a.upsertGroup({ id: 'g1', name: 'IT', color: '#4a90d9' });
    a.upsertSession({ ...sess('a'), groupId: 'g1' });
    a.setWindow({
      bounds: { x: 10, y: 20, width: 1200, height: 800 },
      isMaximized: false,
      displayFingerprint: displayFingerprint([primary]),
    });
    a.setNotificationPrefs({ osToasts: true });
    a.setUpdatePrefs({ skippedVersion: '0.2.0' });
    a.save();
    expect(loadWarns()).toEqual([]);
  });
});

// The set-aside used to be one fixed path, `workspace.json.corrupt`, so a
// SECOND bad load overwrote the copy of the FIRST corruption — the file that
// explains how the damage started, gone at exactly the moment there is a
// pattern worth looking at. Post-mortems are now write-once and bounded.
describe('set-asides are never overwritten (#349)', () => {
  const warnsFor = (content: string): Line[] => {
    fs.writeFileSync(file, content);
    const warns: Line[] = [];
    makeStore(file, fakeLogger(warns)).load();
    return warns;
  };
  const read = (name: string): string => fs.readFileSync(path.join(dir, name), 'utf8');
  /** A post-mortem already on disk, with a stamp of our choosing. */
  const seed = (stamp: string): string => {
    const name = `workspace.json.corrupt-${stamp}`;
    fs.writeFileSync(path.join(dir, name), `old post-mortem ${stamp}`);
    return name;
  };
  /** `count` seeded post-mortems, oldest first. */
  const seedMany = (count: number): string[] =>
    Array.from({ length: count }, (_, i) =>
      seed(`2026-01-${String(i + 1).padStart(2, '0')}T00-00-00.000Z`)
    );

  it('a second bad load keeps the FIRST post-mortem, bytes intact', () => {
    warnsFor('{first corruption');
    warnsFor('{second corruption');

    const kept = setAsides();
    expect(kept).toHaveLength(2);
    expect(kept.map(read)).toEqual(['{first corruption', '{second corruption']);
  });

  it('two set-asides in the same millisecond both survive', () => {
    vi.useFakeTimers({ now: new Date('2026-08-08T14:23:05.123Z') });
    try {
      warnsFor('{first corruption');
      const warns = warnsFor('{second corruption');
      // the clock did not move, so the second copy had to find its own name
      expect(warns[0].fields?.setAside).toMatch(/\.corrupt-2026-08-08T14-23-05\.123Z\.2$/);
    } finally {
      vi.useRealTimers();
    }
    expect(setAsides().map(read)).toEqual(['{first corruption', '{second corruption']);
  });

  it('bounds the folder at five, keeping the OLDEST and the newest', () => {
    const seeded = seedMany(6); // the newcomer makes seven, so two have to go
    const warns = warnsFor('{corrupt again');

    const kept = setAsides();
    expect(kept).toHaveLength(5);
    // the origin (first) survives, the middle two go, the recent ones stay
    expect(kept.slice(0, 4)).toEqual([seeded[0], seeded[3], seeded[4], seeded[5]]);
    expect(read(kept[4])).toBe('{corrupt again'); // and this load's own copy
    expect(warns[0].fields).toMatchObject({
      pruned: [seeded[1], seeded[2]].map((n) => path.join(dir, n)),
      prunedCount: 2,
    });
  });

  it('nothing is deleted while there is room', () => {
    const seeded = seedMany(2);
    const warns = warnsFor('{corrupt again');
    expect(setAsides()).toHaveLength(3);
    expect(seeded.every((n) => fs.existsSync(path.join(dir, n)))).toBe(true);
    expect(warns[0].fields?.pruned).toBeUndefined(); // no line about a loss there wasn't
  });

  // If the clock ran backwards — a VM snapshot, an NTP correction — the copy
  // this load just wrote sorts among the OLD ones. Pruning by name alone would
  // delete it and then log a `setAside` path that is not there.
  it('never prunes the copy it just wrote, even with a clock that went backwards', () => {
    const seeded = ['2027-01-01', '2027-01-02', '2027-01-03', '2027-01-04', '2027-01-05'].map((d) =>
      seed(`${d}T00-00-00.000Z`)
    );
    vi.useFakeTimers({ now: new Date('2026-08-08T14:23:05.123Z') }); // a year "before" them
    let warns: Line[];
    try {
      warns = warnsFor('{corrupt again');
    } finally {
      vi.useRealTimers();
    }

    const mine = String(warns[0].fields?.setAside);
    expect(fs.existsSync(mine)).toBe(true);
    expect(warns[0].fields?.pruned).not.toContain(mine);
    // it sorts FIRST here, and is still not what got spared as "the oldest"
    expect(setAsides()[0]).toBe(path.basename(mine));
    expect(setAsides()).toHaveLength(5);
    expect(fs.existsSync(path.join(dir, seeded[0]))).toBe(true); // the spared origin
  });

  // Both of these are deliberately named so they sort INTO the range that gets
  // pruned — only being the wrong shape, or not a file, saves them.
  it('leaves names it did not write alone — a renamed keepsake and a stray folder', () => {
    const keepsake = 'workspace.json.corrupt-2026-01-03-MINE'; // right prefix, not a stamp
    const strayDir = 'workspace.json.corrupt-2026-01-02T12-00-00.000Z'; // perfect stamp, a folder
    fs.writeFileSync(path.join(dir, keepsake), 'the one I care about');
    fs.mkdirSync(path.join(dir, strayDir));
    const seeded = seedMany(6);
    const warns = warnsFor('{corrupt again');

    expect(read(keepsake)).toBe('the one I care about');
    expect(fs.existsSync(path.join(dir, strayDir))).toBe(true);
    // neither was even a candidate: only this code's own files were pruned, and
    // the folder never became a permanent, un-clearable prune error
    expect(warns[0].fields).toMatchObject({
      pruned: [seeded[1], seeded[2]].map((n) => path.join(dir, n)),
    });
    expect(warns[0].fields?.pruneError).toBeUndefined();
  });

  it('a bare `.corrupt` from an older build is neither overwritten nor pruned', () => {
    // the 0.1.2 manual told the user to keep this file; nothing here may touch it
    fs.writeFileSync(`${file}.corrupt`, 'pre-#349 post-mortem');
    seedMany(6);
    warnsFor('{corrupt again');
    expect(fs.readFileSync(`${file}.corrupt`, 'utf8')).toBe('pre-#349 post-mortem');
  });

  it('a set-aside that cannot be copied prunes nothing', () => {
    const seeded = seedMany(6);
    const spy = vi.spyOn(fs, 'copyFileSync').mockImplementation(() => {
      throw new Error('EPERM: operation not permitted, copyfile');
    });
    let warns: Line[];
    try {
      warns = warnsFor('{corrupt again');
    } finally {
      spy.mockRestore();
    }
    // spending the history to make room for a copy that never happened would be
    // the original bug with extra steps
    expect(setAsides()).toEqual(seeded);
    expect(warns[0].fields?.pruned).toBeUndefined();
    expect(warns[0].fields?.setAsideError).toMatch(/EPERM/);
  });

  it('a prune that fails is reported, and the new post-mortem still stands', () => {
    seedMany(7); // enough that a prune is definitely attempted
    const spy = vi.spyOn(fs, 'rmSync').mockImplementation(() => {
      throw new Error('EBUSY: resource busy or locked');
    });
    let warns: Line[];
    try {
      warns = warnsFor('{corrupt again');
    } finally {
      spy.mockRestore();
    }
    expect(warns[0].fields?.setAside).toBeDefined();
    expect(warns[0].fields?.pruneError).toMatch(/EBUSY/);
    expect(warns[0].fields?.pruned).toBeUndefined(); // nothing actually went
  });

  it('a folder it cannot even list is its own field, not a failed delete', () => {
    const spy = vi.spyOn(fs, 'readdirSync').mockImplementation(() => {
      throw new Error('EACCES: permission denied, scandir');
    });
    let warns: Line[];
    try {
      warns = warnsFor('{corrupt again');
    } finally {
      spy.mockRestore();
    }
    expect(warns[0].fields?.setAside).toBeDefined(); // the post-mortem still landed
    expect(warns[0].fields?.pruneListError).toMatch(/EACCES/);
    expect(warns[0].fields?.pruneError).toBeUndefined();
  });

  it('running out of unused names says so instead of going quiet', () => {
    const spy = vi.spyOn(fs, 'copyFileSync').mockImplementation(() => {
      throw Object.assign(new Error('EEXIST: file already exists, copyfile'), { code: 'EEXIST' });
    });
    let warns: Line[];
    try {
      warns = warnsFor('{corrupt again');
    } finally {
      spy.mockRestore();
    }
    expect(warns[0].fields?.setAside).toBeUndefined();
    expect(warns[0].fields?.setAsideError).toMatch(/no unused set-aside name/);
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
    expect(setAsides()).toHaveLength(1);
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
