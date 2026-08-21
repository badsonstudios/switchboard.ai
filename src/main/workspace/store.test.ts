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
import { SOUND_IDS } from '../../shared/sounds';
import { SUPPRESSED_CAP, SuppressedEvent } from '../../shared/suppressed';
import { MAX_HISTORY_REPAIR_NOTICES } from '../../shared/history-repair';
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

describe('notification rules (P2-E14-03, §5.9)', () => {
  const rule = (id: string, session?: string) => ({
    id,
    event: 'done' as const,
    ...(session ? { session } : {}),
    visibility: ['visible' as const, 'hidden' as const],
    actions: [{ type: 'os-toast' }],
    source: 'notify-when-done',
  });

  it('a rule round-trips a save/load — the checkbox survives a restart', () => {
    const a = makeStore(file);
    a.load();
    a.upsertRule(rule('notify-when-done:a', 'a'));
    a.save();
    const b = makeStore(file);
    expect(b.load().rules).toEqual([rule('notify-when-done:a', 'a')]);
    expect(b.listRules()).toHaveLength(1);
  });

  it('upsert replaces by id; remove answers whether there was anything to remove', () => {
    const st = makeStore(file);
    st.load();
    st.upsertRule(rule('r1', 'a'));
    st.upsertRule({ ...rule('r1', 'a'), enabled: false });
    expect(st.listRules()).toHaveLength(1);
    expect(st.listRules()[0].enabled).toBe(false);
    expect(st.removeRule('r1')).toBe(true);
    expect(st.removeRule('r1')).toBe(false);
    expect(st.listRules()).toEqual([]);
  });

  it('refuses to store a rule it could not load back', () => {
    const st = makeStore(file);
    st.load();
    expect(st.upsertRule({ id: '', event: 'done', actions: [] })).toBe(false);
    expect(st.listRules()).toEqual([]);
  });

  it('hands out copies — a caller cannot mutate the store through its answer', () => {
    const st = makeStore(file);
    st.load();
    st.upsertRule(rule('r1', 'a'));
    st.listRules()[0].actions.push({ type: 'push' });
    expect(st.listRules()[0].actions).toHaveLength(1);
  });

  it('closing a card takes its rules with it — nothing else ever would', () => {
    const st = makeStore(file);
    st.load();
    st.upsertSession(sess('a'));
    st.upsertRule(rule('notify-when-done:a', 'a'));
    st.upsertRule(rule('notify-when-done:b', 'b'));
    st.upsertRule(rule('global')); // unscoped: not this card's to delete
    st.removeSession('a');
    expect(st.listRules().map((r) => r.id)).toEqual(['notify-when-done:b', 'global']);
  });

  it('load drops rules this build cannot use and keeps the rest', () => {
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        sessions: [],
        rules: [rule('r1', 'a'), { id: 7 }, 'nope', { id: 'r2', event: 'done' }, null],
        window: null,
      })
    );
    const st = makeStore(file);
    expect(st.load().rules.map((r) => r.id)).toEqual(['r1']);
  });

  it('a rules field that is not a list costs the rules, not the workspace', () => {
    fs.writeFileSync(
      file,
      JSON.stringify({ version: 1, sessions: [sess('a')], rules: 'all of them', window: null })
    );
    const st = makeStore(file);
    const s = st.load();
    expect(s.rules).toEqual([]);
    expect(s.sessions).toHaveLength(1);
  });

  it('a file written before rules existed loads with none, silently', () => {
    fs.writeFileSync(file, JSON.stringify({ version: 1, sessions: [sess('a')], window: null }));
    const st = makeStore(file);
    expect(st.load().rules).toEqual([]);
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
      // P2-E14-05a's two switches survive the same patch, for the same reason
      sounds: false,
      speak: false,
      quietStart: '22:00',
      quietEnd: '07:00',
    });
    st.setNotificationPrefs({ osToasts: false });
    expect(st.getNotificationPrefs()).toMatchObject({ enabled: false, osToasts: false });
  });

  // P2-E14-05b. The window is the ONE pref where "stored but unreadable" and
  // "not stored" used to look identical from the outside and behave completely
  // differently — a `quietStart` of "10pm" made the dialog say quiet hours were
  // configured while silencing nothing at all.
  it('refuses a time it cannot parse rather than storing it', () => {
    const st = makeStore(file);
    st.load();
    st.setNotificationPrefs({ quietStart: '10pm', quietEnd: '07:00' });
    expect(st.getNotificationPrefs().quietStart).toBeUndefined();
    expect(st.getNotificationPrefs().quietEnd).toBeUndefined();
  });

  it('takes both ends or neither — half a window is not a window', () => {
    const st = makeStore(file);
    st.load();
    st.setNotificationPrefs({ quietEnd: '07:00' });
    expect(st.getNotificationPrefs().quietEnd).toBeUndefined();
    st.setNotificationPrefs({ quietStart: '22:00', quietEnd: '07:00' });
    expect(st.getNotificationPrefs()).toMatchObject({ quietStart: '22:00', quietEnd: '07:00' });
    // …and clearing takes both away, which is how the dialog switches it off.
    // Empty strings are what the renderer actually sends (App.tsx): they mean
    // the same thing to the sanitizer and survive the IPC hop unambiguously.
    st.setNotificationPrefs({ quietStart: '', quietEnd: '' });
    expect(st.getNotificationPrefs().quietStart).toBeUndefined();
    expect(st.getNotificationPrefs().quietEnd).toBeUndefined();
    st.setNotificationPrefs({ quietStart: '22:00', quietEnd: '07:00' });
    st.setNotificationPrefs({ quietStart: undefined, quietEnd: undefined });
    expect(st.getNotificationPrefs().quietStart).toBeUndefined();
  });
});

// ── the missed-events digest's input (P2-E14-05b, feeding #483) ────────────
describe('suppressed notifications', () => {
  const held = (id: string, at = 1): SuppressedEvent => ({
    id,
    at,
    kind: 'done',
    cardId: 'card-a',
    title: 'TradingApp',
    body: 'done',
    actions: ['os-toast'],
    ruleIds: ['r'],
    reason: 'quiet-hours',
  });

  it('survives quit -> relaunch, which is the whole reason it is persisted', () => {
    // Quiet hours run overnight and the app gets closed; a held list that lived
    // in memory would be empty exactly when the digest needs it.
    const st = makeStore(file);
    st.load();
    st.recordSuppressed(held('a'));
    st.save();
    const again = makeStore(file);
    again.load();
    expect(again.listSuppressed().map((e) => e.id)).toEqual(['a']);
    expect(again.listSuppressed()[0]).toMatchObject({ kind: 'done', reason: 'quiet-hours' });
  });

  it('is bounded — the oldest go first, and the cap is the stated one', () => {
    const st = makeStore(file);
    st.load();
    for (let i = 0; i < SUPPRESSED_CAP + 25; i++) st.recordSuppressed(held(`e${i}`, i));
    const list = st.listSuppressed();
    expect(list).toHaveLength(SUPPRESSED_CAP);
    expect(list[0].id).toBe('e25'); // FIFO: the first 25 were dropped
    expect(list[list.length - 1].id).toBe(`e${SUPPRESSED_CAP + 24}`);
  });

  it('trims an over-long list on the way IN as well as out', () => {
    // A hand-edited or older-build file must not be able to make the digest
    // unbounded just by already being unbounded.
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: CURRENT_VERSION,
        suppressed: Array.from({ length: SUPPRESSED_CAP + 10 }, (_, i) => held(`e${i}`, i)),
      })
    );
    const st = makeStore(file);
    st.load();
    expect(st.listSuppressed()).toHaveLength(SUPPRESSED_CAP);
  });

  it('clears everything, or just the ids the digest marked read', () => {
    const st = makeStore(file);
    st.load();
    st.recordSuppressed(held('a'));
    st.recordSuppressed(held('b'));
    st.recordSuppressed(held('c'));
    expect(st.clearSuppressed(['a', 'c'])).toBe(2);
    expect(st.listSuppressed().map((e) => e.id)).toEqual(['b']);
    expect(st.clearSuppressed()).toBe(1);
    expect(st.listSuppressed()).toEqual([]);
    expect(st.clearSuppressed()).toBe(0); // nothing to clear ≠ it did not work
  });

  it('drops a record this build cannot read, rather than half-loading it', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: CURRENT_VERSION,
        suppressed: [held('good'), { id: 'bad', at: 'yesterday' }, null, 'nope'],
      })
    );
    const st = makeStore(file);
    st.load();
    expect(st.listSuppressed().map((e) => e.id)).toEqual(['good']);
  });

  it('refuses to WRITE an unloadable record — no point storing what will be dropped', () => {
    const st = makeStore(file);
    st.load();
    st.recordSuppressed({ ...held('x'), at: Number.NaN });
    expect(st.listSuppressed()).toEqual([]);
  });

  it('hands out copies — the digest renders the list, it does not own it', () => {
    const st = makeStore(file);
    st.load();
    st.recordSuppressed(held('a'));
    st.listSuppressed()[0].actions.push('sound');
    expect(st.listSuppressed()[0].actions).toEqual(['os-toast']);
  });
});

describe('per-session sounds (P2-E14-05a, §5.11)', () => {
  it('gives the first cards different cues without anyone configuring one', () => {
    // the done-when — "two sessions ring distinguishably" — before any UI
    const st = makeStore(file);
    st.load();
    st.upsertSession(sess('one'));
    st.upsertSession(sess('two'));
    st.upsertSession(sess('three'));
    const ids = ['one', 'two', 'three'].map((id) => st.cardSound(id).id);
    expect(new Set(ids).size).toBe(3);
    for (const id of ids) expect(SOUND_IDS).toContain(id);
  });

  it('an auto cue is not pinned, and a chosen one is', () => {
    const st = makeStore(file);
    st.load();
    st.upsertSession(sess('one'));
    expect(st.cardSound('one').pinned).toBe(false);
    st.setCardSound('one', 'bell');
    expect(st.cardSound('one')).toEqual({ id: 'bell', pinned: true });
  });

  it('a pinned cue survives quit -> relaunch', () => {
    const a = makeStore(file);
    a.load();
    a.upsertSession(sess('one'));
    a.setCardSound('one', 'knock');
    a.save();
    const b = makeStore(file);
    b.load();
    expect(b.cardSound('one')).toEqual({ id: 'knock', pinned: true });
  });

  it('null hands the card back to auto', () => {
    const st = makeStore(file);
    st.load();
    st.upsertSession(sess('one'));
    st.setCardSound('one', 'knock');
    st.setCardSound('one', null);
    expect(st.cardSound('one').pinned).toBe(false);
  });

  it('a cue this build cannot play is refused rather than stored', () => {
    // a hand-edited file or a newer renderer must not leave a name behind that
    // resolves to nothing
    const st = makeStore(file);
    st.load();
    st.upsertSession(sess('one'));
    st.setCardSound('one', 'airhorn');
    expect(st.cardSound('one').pinned).toBe(false);
  });

  it('setting a cue on a card that is not there is a no-op, not a throw', () => {
    const st = makeStore(file);
    st.load();
    expect(() => st.setCardSound('ghost', 'bell')).not.toThrow();
    expect(st.listSessions()).toEqual([]);
  });

  it('an unknown card still gets a cue — silence is the wrong failure', () => {
    const st = makeStore(file);
    st.load();
    expect(SOUND_IDS).toContain(st.cardSound('ghost').id);
    expect(st.cardSound('ghost').pinned).toBe(false);
  });

  it('a pinned cue does not move when the card ahead of it is closed', () => {
    // the stated cost of assigning by position, and the reason pinning exists
    const st = makeStore(file);
    st.load();
    st.upsertSession(sess('one'));
    st.upsertSession(sess('two'));
    st.setCardSound('two', 'ping');
    st.removeSession('one');
    expect(st.cardSound('two')).toEqual({ id: 'ping', pinned: true });
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
    // auto labels default ON for a file that predates them (P2-E7-06): the
    // feature is what the setting is for, and off is the exception
    expect(st.getAutoLabels()).toBe(true);
  });

  it('the auto-label switch survives a reload (P2-E7-06)', () => {
    const a = makeStore(file);
    a.load();
    expect(a.getAutoLabels()).toBe(true);
    a.setAutoLabels(false);
    a.save();

    const b = makeStore(file);
    b.load();
    expect(b.getAutoLabels()).toBe(false);
  });

  it('a card remembers who set its label (P2-E7-06)', () => {
    // `labelSource` is what makes "typing pins it forever" survive a restart.
    const a = makeStore(file);
    a.load();
    a.upsertSession({ ...sess('a'), taskLabel: 'mine', labelSource: 'user' });
    a.save();

    const b = makeStore(file);
    b.load();
    expect(b.listSessions()[0].labelSource).toBe('user');
    expect(b.listSessions()[0].taskLabel).toBe('mine');
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

describe('service-health prefs (P2-E14-07)', () => {
  it('defaults to polling ON', () => {
    const st = makeStore(file);
    st.load();
    expect(st.getServiceHealthPrefs()).toEqual({ poll: true });
  });

  it('round-trips the About-panel toggle through the file', () => {
    const a = makeStore(file);
    a.load();
    a.setServiceHealthPrefs({ poll: false });
    a.save();
    const b = makeStore(file);
    b.load();
    expect(b.getServiceHealthPrefs()).toEqual({ poll: false });
  });

  it('a mangled value leaves the feature working rather than silently off', () => {
    // the claim `sanitizeHealth` makes about itself: an unusable pref must not
    // be the way this quietly stops running
    fs.writeFileSync(file, JSON.stringify({ version: 1, health: { poll: 'nope' } }));
    const st = makeStore(file);
    st.load();
    expect(st.getServiceHealthPrefs()).toEqual({ poll: true });
  });

  it('a file written before this feature existed simply gets the default', () => {
    fs.writeFileSync(file, JSON.stringify({ version: 1, sessions: [], autoTrust: false }));
    const st = makeStore(file);
    st.load();
    expect(st.getServiceHealthPrefs()).toEqual({ poll: true });
    expect(st.getAutoTrust()).toBe(false); // …and nothing else moved
  });

  it('two stores do not share the defaults object', () => {
    const a = makeStore(file);
    a.load();
    a.setServiceHealthPrefs({ poll: false });
    const b = makeStore(path.join(dir, 'health-other.json'));
    b.load();
    expect(b.getServiceHealthPrefs()).toEqual({ poll: true });
  });
});

describe('phone-push prefs (P2-E14-06)', () => {
  it('defaults to both channels OFF — the app is fully functional unconfigured', () => {
    const st = makeStore(file);
    st.load();
    expect(st.getPushPrefs()).toEqual({ push: false, service: 'ntfy', webhook: false });
  });

  it('round-trips the switches and the server through the file', () => {
    const a = makeStore(file);
    a.load();
    a.setPushPrefs({ push: true, service: 'pushover' });
    a.setPushPrefs({ ntfyServer: 'https://ntfy.example.test' }); // merge-patch
    a.save();
    const b = makeStore(file);
    b.load();
    expect(b.getPushPrefs()).toEqual({
      push: true,
      service: 'pushover',
      webhook: false,
      ntfyServer: 'https://ntfy.example.test',
    });
  });

  // The §5.29 claim, asserted against the BYTES. This shape has nowhere to put
  // a credential, and this test is what keeps it that way.
  it('cannot persist a credential, however it is handed one', () => {
    const st = makeStore(file);
    st.load();
    st.setPushPrefs({
      push: true,
      // a caller (or a hand-edited file) trying to sneak one through
      topic: 'topic-9f3a-SECRET',
      token: 'app-token',
    } as unknown as Parameters<typeof st.setPushPrefs>[0]);
    st.save();
    const bytes = fs.readFileSync(file, 'utf8');
    expect(bytes).not.toContain('topic-9f3a-SECRET');
    expect(bytes).not.toContain('app-token');
    expect(st.getPushPrefs()).toEqual({ push: true, service: 'ntfy', webhook: false });
  });

  it('a mangled value leaves the channels OFF rather than sending something', () => {
    fs.writeFileSync(
      file,
      JSON.stringify({ version: 1, push: { push: 'yes', webhook: 1, service: 'telegram' } })
    );
    const st = makeStore(file);
    st.load();
    expect(st.getPushPrefs()).toEqual({ push: false, service: 'ntfy', webhook: false });
  });

  it('a file written before this feature existed simply gets the defaults', () => {
    fs.writeFileSync(file, JSON.stringify({ version: 1, sessions: [], autoTrust: false }));
    const st = makeStore(file);
    st.load();
    expect(st.getPushPrefs()).toEqual({ push: false, service: 'ntfy', webhook: false });
    expect(st.getAutoTrust()).toBe(false);
  });

  it('two stores do not share the defaults object', () => {
    const a = makeStore(file);
    a.load();
    a.setPushPrefs({ push: true });
    const b = makeStore(path.join(dir, 'push-other.json'));
    b.load();
    expect(b.getPushPrefs().push).toBe(false);
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

// #165 made a failed write audible in the LOG. This is the other half: it was
// still invisible in the app, which is the same silent-loss shape #168 fixed
// for read-only mode — the layout on disk quietly stops keeping up with the one
// on screen, and the next launch restores a stale workspace with no hint why.
//
// The three things this design is: a THRESHOLD (one EBUSY blip is not news),
// a RETRY (the only thing that can still save the run's work, and the only
// thing that can notice the disk recovering), and RECOVERY (the notice has to
// come down, which #168's never had to).
describe('saving that keeps failing is said on screen (#207)', () => {
  /** Mirrors `SAVE_FAILURES_BEFORE_NOTICE`, deliberately not exported. */
  const BEFORE_NOTICE = 3;
  /** Mirrors `SAVE_RETRY_MS`; the schedule doubles from here. */
  const RETRY_MS = 1000;
  /** Mirrors `MAX_SAVE_RETRY_MS` — where that doubling stops. */
  const MAX_RETRY_MS = 10_000;

  type Level = 'warn' | 'info';
  type Said = { level: Level; msg: string; fields?: Record<string, unknown> };
  /** `fakeLogger`, but it keeps the good news too — recovery is an info line. */
  const recordingLogger = (said: Said[]): Logger => {
    const at =
      (level: Level) =>
      (msg: string, fields?: Record<string, unknown>): void => {
        said.push({ level, msg, fields });
      };
    const l: Logger = {
      debug: () => {},
      info: at('info'),
      warn: at('warn'),
      error: () => {},
      child: () => l,
    };
    return l;
  };

  /** Break the rename that finishes every save — the real Windows failure
   *  (a scanner or an indexer holding the file for a moment). */
  const failSaves = () =>
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw Object.assign(new Error('EBUSY: resource busy or locked, rename'), { code: 'EBUSY' });
    });

  /** A store wired to a listener, with everything the assertions need. */
  function failingStore(): {
    st: WorkspaceStore;
    said: Said[];
    pushed: Array<{ failing: boolean; file: string }>;
  } {
    const said: Said[] = [];
    const pushed: Array<{ failing: boolean; file: string }> = [];
    const st = makeStore(file, recordingLogger(said), (s) => pushed.push({ ...s }));
    st.load();
    st.upsertSession(sess('a', 0));
    return { st, said, pushed };
  }

  it('one failure is not news — nothing is pushed and no notice is raised', () => {
    // A backup agent or an indexer touching workspace.json for a moment is an
    // ordinary event; a banner for it is noise, and noise is how a warning
    // stops being read.
    const { st, said, pushed } = failingStore();
    const spy = failSaves();
    try {
      st.save();
    } finally {
      spy.mockRestore();
    }
    expect(pushed).toEqual([]);
    expect(st.saveState()).toEqual({ failing: false, file });
    // #165's line is still said, first time, unchanged
    expect(said.filter((s) => s.level === 'warn')).toHaveLength(1);
    expect(said[0].msg).toMatch(/workspace save failed/);
  });

  it('three in a row raises it — once — naming the file the user has to go look at', () => {
    const { st, said, pushed } = failingStore();
    const spy = failSaves();
    try {
      for (let i = 0; i < BEFORE_NOTICE + 2; i++) st.save();
    } finally {
      spy.mockRestore();
    }
    // pushed exactly once, on the transition, not once per failure
    expect(pushed).toEqual([{ failing: true, file }]);
    expect(st.saveState()).toEqual({ failing: true, file });
    // and the log did not repeat #165's line five times: the first failure,
    // then the one that put it on screen
    const warns = said.filter((s) => s.level === 'warn');
    expect(warns).toHaveLength(2);
    expect(warns[1].msg).toMatch(/keeps failing/);
    expect(warns[1].fields).toMatchObject({ attempts: BEFORE_NOTICE, file });
  });

  it('retries on its own, backing off, with nothing else touching the store', () => {
    // Without this a run that goes quiet after one failed save sits unsaved
    // until the user happens to change something else — which may be never.
    vi.useFakeTimers();
    const { st, pushed } = failingStore();
    const spy = failSaves();
    try {
      st.save(); // failure 1 — retry armed at RETRY_MS
      vi.advanceTimersByTime(RETRY_MS - 1);
      expect(pushed).toEqual([]);
      vi.advanceTimersByTime(1); // failure 2 — next retry at 2x
      expect(pushed).toEqual([]);
      vi.advanceTimersByTime(2 * RETRY_MS - 1);
      expect(pushed).toEqual([]); // to the millisecond: still two failures
      vi.advanceTimersByTime(1); // failure 3 — the threshold
      expect(pushed).toEqual([{ failing: true, file }]);
    } finally {
      spy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('stops backing off at the cap, so a fixed disk is noticed within seconds', () => {
    // Without the ceiling the delays keep doubling — 16s, 32s, a minute — and a
    // user who frees up space sits under a stale banner long after the problem
    // is gone. Deleting the `Math.min` used to leave every other test green.
    vi.useFakeTimers();
    const { st, pushed } = failingStore();
    const spy = failSaves();
    try {
      st.save(); // failure 1; the schedule from here is 1s, 2s, 4s, 8s, 10s, 10s…
      for (const ms of [1000, 2000, 4000, 8000]) vi.advanceTimersByTime(ms);
      spy.mockRestore(); // failure 5 has been and gone; the next retry is the capped one
      vi.advanceTimersByTime(MAX_RETRY_MS - 1);
      expect(pushed).toEqual([{ failing: true, file }]); // not yet — still waiting
      vi.advanceTimersByTime(1);
      expect(pushed).toEqual([
        { failing: true, file },
        { failing: false, file },
      ]);
    } finally {
      spy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('a re-load drops a pending retry along with the streak', () => {
    vi.useFakeTimers();
    const { st, pushed } = failingStore();
    const spy = failSaves();
    try {
      for (let i = 0; i < BEFORE_NOTICE; i++) st.save();
      expect(st.saveState().failing).toBe(true);
      st.load(); // a fresh file: nothing from the last one carries over
      expect(st.saveState().failing).toBe(false);
      expect(pushed).toEqual([
        { failing: true, file },
        { failing: false, file },
      ]);
      // and no retry survived it — the writes would still fail if one fired
      vi.advanceTimersByTime(60_000);
      expect(pushed).toHaveLength(2);
    } finally {
      spy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('takes the notice back down when saving works again, and says so', () => {
    // The half #168 never needed. A notice that outlives its condition teaches
    // people to ignore notices.
    vi.useFakeTimers();
    const { st, said, pushed } = failingStore();
    const spy = failSaves();
    try {
      for (let i = 0; i < BEFORE_NOTICE; i++) st.save();
      expect(st.saveState().failing).toBe(true);
      spy.mockRestore();
      // the disk relents; the store's OWN retry is what finds out
      vi.advanceTimersByTime(4 * RETRY_MS);
    } finally {
      spy.mockRestore();
      vi.useRealTimers();
    }
    expect(pushed).toEqual([
      { failing: true, file },
      { failing: false, file },
    ]);
    expect(st.saveState()).toEqual({ failing: false, file });
    // and the run's work is actually on disk, which is the point of retrying
    expect(makeStore(file).load().sessions.map((x) => x.id)).toEqual(['a']);
    const recovered = said.find((s) => s.msg.includes('recovered'));
    expect(recovered?.level).toBe('info');
    expect(recovered?.fields).toMatchObject({ attempts: BEFORE_NOTICE });
  });

  it('starts counting again from scratch after a recovery', () => {
    // "three failures ever" would put a banner up over three unrelated blips
    // spread across an afternoon. It is three IN A ROW.
    const { st, pushed } = failingStore();
    for (let i = 0; i < BEFORE_NOTICE - 1; i++) {
      const spy = failSaves();
      try {
        st.save();
      } finally {
        spy.mockRestore();
      }
      st.save(); // works — the streak is over
    }
    expect(pushed).toEqual([]);
    expect(st.saveState().failing).toBe(false);
  });

  it('a listener that throws costs the save nothing (P6)', () => {
    // The notice must never become the failure it is reporting.
    const st = makeStore(file, undefined, () => {
      throw new Error('the renderer went away mid-push');
    });
    st.load();
    st.upsertSession(sess('a', 0));
    const spy = failSaves();
    try {
      for (let i = 0; i < BEFORE_NOTICE; i++) expect(() => st.save()).not.toThrow();
    } finally {
      spy.mockRestore();
    }
    expect(st.saveState().failing).toBe(true);
    expect(() => st.save()).not.toThrow(); // and recovery pushes through it too
    expect(st.saveState().failing).toBe(false);
  });

  it('a read-only workspace never raises it — it attempts no writes at all', () => {
    // #168's banner already owns that case, and a second one behind it would
    // be a notice for a failure that cannot happen.
    fs.writeFileSync(file, JSON.stringify({ version: CURRENT_VERSION + 1, sessions: [] }));
    const pushed: unknown[] = [];
    const st = makeStore(file, undefined, (s) => pushed.push(s));
    st.load();
    expect(st.isReadOnly()).toBe(true);
    for (let i = 0; i < BEFORE_NOTICE + 2; i++) st.save();
    expect(pushed).toEqual([]);
    expect(st.saveState().failing).toBe(false);
  });

  it('a save HELD BACK for a post-mortem rescue is not a failed save', () => {
    // #352's deferral is bounded, self-resolving, and ends in a save that
    // works. Counting it would flash "saving is failing" at a user whose saving
    // is about to be fine — and the deferral already logs its own line.
    fs.writeFileSync(file, '{half a workspace');
    const pushed: unknown[] = [];
    const st = makeStore(file, undefined, (s) => pushed.push(s));
    const copy = vi.spyOn(fs, 'copyFileSync').mockImplementation(() => {
      throw Object.assign(new Error('EPERM: copyFileSync refused'), { code: 'EPERM' });
    });
    try {
      st.load(); // the set-aside failed, so the first saves are held back
      st.upsertSession(sess('a', 0));
      for (let i = 0; i < BEFORE_NOTICE; i++) st.save();
    } finally {
      copy.mockRestore();
    }
    expect(pushed).toEqual([]);
    expect(st.saveState().failing).toBe(false);
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

    it('a mangled provider-status pref says polling stayed on', () => {
      write({ version: 1, health: { poll: 'nope' } });
      const warns = loadWarns();
      expect(warns).toHaveLength(1);
      expect(warns[0].msg).toMatch(/provider-status setting .* was unusable/);
      expect(warns[0].fields).toMatchObject({ unusable: ['poll'] });
    });

    it('a non-boolean auto-trust says it stayed on', () => {
      write({ version: 1, autoTrust: 'sure' });
      const warns = loadWarns();
      expect(warns).toHaveLength(1);
      expect(warns[0].msg).toMatch(/auto-trust .* leaving it on/);
    });

    it('a non-boolean auto-label setting says it stayed on too (P2-E7-06)', () => {
      write({ version: 1, autoLabels: 'sure' });
      const warns = loadWarns();
      expect(warns).toHaveLength(1);
      expect(warns[0].msg).toMatch(/auto-label .* leaving it on/);
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
      health: { poll: false },
      push: { push: true, service: 'ntfy', webhook: false, ntfyServer: 'https://ntfy.example.test' },
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

// #349 made the set-aside SUCCESS path safe. This is the other half: when the
// copy itself CANNOT be made — a full disk, an anti-virus sitting on the folder
// — the damaged `workspace.json` is the only evidence there is, and it is the
// exact file the first save of the fresh empty workspace lands on. It used to
// go without a trace, on precisely the machines whose owner needs the
// post-mortem most. Now the save waits, and tries again three different ways.
describe('a failed set-aside is retried before the file is overwritten (#352)', () => {
  const CORRUPT = '{half a workspace';
  /** How many saves may be held back before the live workspace wins. Mirrors
   *  `MAX_RESCUE_ATTEMPTS`, which is deliberately not exported. */
  const RESCUE_ATTEMPTS = 5;

  const read = (name: string): string => fs.readFileSync(path.join(dir, name), 'utf8');
  const savedIds = (): string[] =>
    (JSON.parse(fs.readFileSync(file, 'utf8')) as { sessions: PersistedSession[] }).sessions.map(
      (s) => s.id
    );
  const last = (warns: Line[]): Line => warns[warns.length - 1];
  const boom = (code: string, op: string): Error =>
    Object.assign(new Error(`${code}: ${op} refused`), { code });
  /** Fail `fs[name]` only for the post-mortem names, so the store's own tmp +
   *  rename still work and a blocked rescue never masquerades as a dead disk. */
  const blockPostMortems = (name: 'writeFileSync' | 'renameSync', code: string) => {
    const real = fs[name] as (...args: unknown[]) => unknown;
    return vi.spyOn(fs, name).mockImplementation((...args: unknown[]) => {
      // renameSync's DESTINATION is the second argument; writeFileSync's is the first
      const target = String(name === 'renameSync' ? args[1] : args[0]);
      if (target.includes('.corrupt-')) throw boom(code, name);
      return real(...args);
    });
  };
  const failCopies = () =>
    vi.spyOn(fs, 'copyFileSync').mockImplementation(() => {
      throw boom('EPERM', 'copyFileSync');
    });
  /** Make the READ of the workspace file fail, so the store holds no bytes. */
  const failTheRead = () => {
    const real = fs.readFileSync as (...args: unknown[]) => unknown;
    return vi.spyOn(fs, 'readFileSync').mockImplementation(((...args: unknown[]) => {
      if (String(args[0]) === file) throw boom('EACCES', 'readFileSync');
      return real(...args);
    }) as never);
  };

  it('writes the bytes it read when the save comes, instead of losing them', () => {
    fs.writeFileSync(file, CORRUPT);
    const warns: Line[] = [];
    const st = makeStore(file, fakeLogger(warns));
    const copy = failCopies();
    try {
      st.load();
      // nothing on disk yet — and the log says the attempt is still pending
      expect(setAsides()).toEqual([]);
      expect(warns[0].fields).toMatchObject({
        setAsideError: expect.stringContaining('EPERM'),
        setAsideRetry: true,
      });
      st.upsertSession(sess('a'));
      st.save(); // the write that used to eat the evidence
    } finally {
      copy.mockRestore();
    }

    const kept = setAsides();
    expect(kept).toHaveLength(1);
    expect(read(kept[0])).toBe(CORRUPT); // the damaged file, byte for byte
    expect(savedIds()).toEqual(['a']); // and the save itself still happened
    expect(last(warns).msg).toMatch(/set aside on a later try/);
    expect(last(warns).fields).toMatchObject({ setAsideHow: 'written-from-memory' });
  });

  it('a file it could not even READ is rescued by copying it', () => {
    fs.writeFileSync(file, CORRUPT);
    const warns: Line[] = [];
    const st = makeStore(file, fakeLogger(warns));
    const readSpy = failTheRead();
    const copy = failCopies();
    try {
      st.load(); // no bytes to hold, and the copy refused
    } finally {
      readSpy.mockRestore();
      copy.mockRestore();
    }
    st.upsertSession(sess('a'));
    st.save();

    const kept = setAsides();
    expect(kept).toHaveLength(1);
    expect(read(kept[0])).toBe(CORRUPT);
    expect(savedIds()).toEqual(['a']);
    expect(last(warns).fields).toMatchObject({ setAsideHow: 'copied' });
  });

  // The case a copy can never win: no room for a second copy of anything. A
  // rename inside the directory needs none, and we are about to destroy that
  // file anyway, so moving it is pure gain.
  it('a disk too full to take a copy still gets the file MOVED out of the way', () => {
    fs.writeFileSync(file, CORRUPT);
    const warns: Line[] = [];
    const st = makeStore(file, fakeLogger(warns));
    const copy = failCopies();
    const write = blockPostMortems('writeFileSync', 'ENOSPC');
    try {
      st.load();
      st.upsertSession(sess('a'));
      st.save();
    } finally {
      copy.mockRestore();
      write.mockRestore();
    }

    const kept = setAsides();
    expect(kept).toHaveLength(1);
    expect(read(kept[0])).toBe(CORRUPT);
    expect(last(warns).fields).toMatchObject({ setAsideHow: 'moved' });
    expect(savedIds()).toEqual(['a']); // the move left the name free for the save
  });

  // A `wx` write that dies two thirds of the way through (the disk filling up
  // as it goes) leaves a TRUNCATED post-mortem squatting on the honest name —
  // worse than none, and it would push the route that actually works onto `.2`.
  it('a write that dies partway leaves no truncated post-mortem behind', () => {
    fs.writeFileSync(file, CORRUPT);
    const warns: Line[] = [];
    const st = makeStore(file, fakeLogger(warns));
    const copy = failCopies();
    const real = fs.writeFileSync;
    const write = vi.spyOn(fs, 'writeFileSync').mockImplementation((...args: unknown[]) => {
      const target = String(args[0]);
      if (!target.includes('.corrupt-')) return (real as (...a: unknown[]) => unknown)(...args);
      real(target, CORRUPT.slice(0, 4)); // got some of it down, then...
      throw boom('ENOSPC', 'writeFileSync');
    });
    try {
      st.load();
      st.upsertSession(sess('a'));
      st.save();
    } finally {
      copy.mockRestore();
      write.mockRestore();
    }

    const kept = setAsides();
    expect(kept).toHaveLength(1); // the half-file was taken back out
    expect(read(kept[0])).toBe(CORRUPT);
    expect(kept[0]).not.toMatch(/\.\d$/); // and the move got the honest name
    expect(last(warns).fields).toMatchObject({ setAsideHow: 'moved' });
  });

  it('the late set-aside is pruned like any other — the folder stays bounded', () => {
    // six already there; the rescued one makes seven, so two go
    const seeded = Array.from({ length: 6 }, (_, i) => {
      const name = `workspace.json.corrupt-2026-01-0${i + 1}T00-00-00.000Z`;
      fs.writeFileSync(path.join(dir, name), `old post-mortem ${i}`);
      return name;
    });
    fs.writeFileSync(file, CORRUPT);
    const warns: Line[] = [];
    const st = makeStore(file, fakeLogger(warns));
    const copy = failCopies();
    try {
      st.load();
      expect(setAsides()).toEqual(seeded); // a failed copy prunes nothing (#349)
      st.save();
    } finally {
      copy.mockRestore();
    }
    expect(setAsides()).toHaveLength(5);
    expect(last(warns).fields).toMatchObject({
      pruned: [seeded[1], seeded[2]].map((n) => path.join(dir, n)),
      prunedCount: 2,
    });
  });

  it('holds the save back rather than overwrite, then gives up loudly', () => {
    fs.writeFileSync(file, CORRUPT);
    const warns: Line[] = [];
    const st = makeStore(file, fakeLogger(warns));
    const copy = failCopies();
    const write = blockPostMortems('writeFileSync', 'ENOSPC');
    const rename = blockPostMortems('renameSync', 'EPERM');
    try {
      st.load();
      st.upsertSession(sess('a'));
      for (let i = 1; i < RESCUE_ATTEMPTS; i++) expect(() => st.save()).not.toThrow();
      // every route is refused, so the only copy of the damage is still there
      expect(fs.readFileSync(file, 'utf8')).toBe(CORRUPT);
      expect(setAsides()).toEqual([]);
      // said once, not once per held-back save
      expect(warns.filter((w) => /not saving over the damaged/.test(w.msg))).toHaveLength(1);

      st.save(); // the last attempt: the live workspace wins from here
      expect(last(warns).msg).toMatch(/could not set the damaged workspace file aside/);
      expect(last(warns).fields).toMatchObject({ attempts: RESCUE_ATTEMPTS });
      expect(savedIds()).toEqual(['a']);

      // and it really did give up — no further save is held back or re-reported
      const after = warns.length;
      st.upsertSession(sess('b'));
      st.save();
      expect(savedIds()).toEqual(['a', 'b']);
      expect(warns).toHaveLength(after);
    } finally {
      copy.mockRestore();
      write.mockRestore();
      rename.mockRestore();
    }
  });

  it('stops holding the save back when the damaged file has gone anyway', () => {
    fs.writeFileSync(file, CORRUPT);
    const warns: Line[] = [];
    const st = makeStore(file, fakeLogger(warns));
    const readSpy = failTheRead();
    const copy = failCopies();
    try {
      st.load(); // nothing held: the read failed too
    } finally {
      readSpy.mockRestore();
      copy.mockRestore();
    }
    fs.rmSync(file); // someone took the damaged file away themselves
    st.upsertSession(sess('a'));
    st.save();

    expect(savedIds()).toEqual(['a']); // straight through, nothing to protect
    expect(setAsides()).toEqual([]);
    expect(warns).toHaveLength(1); // just the load's own line
  });

  // The move is the one operation in the store that CAN destroy a post-mortem:
  // `renameSync` replaces its destination on both platforms. #349's whole
  // guarantee rests on the check in front of it.
  it('the move refuses to land on a post-mortem that is already there', () => {
    vi.useFakeTimers({ now: new Date('2026-08-08T14:23:05.123Z') });
    const taken = 'workspace.json.corrupt-2026-08-08T14-23-05.123Z'; // the name this load will pick
    fs.writeFileSync(path.join(dir, taken), 'the post-mortem from last time');
    fs.writeFileSync(file, CORRUPT);
    const warns: Line[] = [];
    const st = makeStore(file, fakeLogger(warns));
    const copy = failCopies();
    const write = blockPostMortems('writeFileSync', 'ENOSPC'); // forces the move route
    try {
      st.load();
      st.save();
    } finally {
      copy.mockRestore();
      write.mockRestore();
      vi.useRealTimers();
    }

    expect(read(taken)).toBe('the post-mortem from last time'); // untouched
    expect(setAsides()).toEqual([taken, `${taken}.2`]);
    expect(read(`${taken}.2`)).toBe(CORRUPT);
    expect(last(warns).fields).toMatchObject({ setAsideHow: 'moved' });
  });

  // The retry is a TIMER, not something the next mutation happens to trigger:
  // a run that goes quiet after one save must still end up with its evidence.
  it('retries on its own a second later, with nothing else touching the store', () => {
    vi.useFakeTimers();
    fs.writeFileSync(file, CORRUPT);
    const warns: Line[] = [];
    const st = makeStore(file, fakeLogger(warns));
    const copy = failCopies();
    const write = blockPostMortems('writeFileSync', 'ENOSPC');
    const rename = blockPostMortems('renameSync', 'EPERM');
    try {
      st.load();
      st.upsertSession(sess('a'));
      st.save(); // every route refused: held back, and a retry armed
      expect(setAsides()).toEqual([]);
      expect(fs.readFileSync(file, 'utf8')).toBe(CORRUPT);

      copy.mockRestore();
      write.mockRestore();
      rename.mockRestore();
      vi.advanceTimersByTime(999); // RESCUE_RETRY_MS, to the millisecond
      expect(setAsides()).toEqual([]);
      vi.advanceTimersByTime(1);
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
    }

    const kept = setAsides();
    expect(kept).toHaveLength(1);
    expect(read(kept[0])).toBe(CORRUPT);
    expect(savedIds()).toEqual(['a']); // and the save it was holding went through
  });

  // A file from the FUTURE is loaded read-only, and a read-only store never
  // writes — so there is nothing for a rescue to protect the file from. The one
  // way to get here: a future file whose reader then chokes (see `load`).
  it('a read-only future file promises no retry — nothing will overwrite it', () => {
    const onDisk = '{"version":99}';
    fs.writeFileSync(file, onDisk);
    const warns: Line[] = [];
    const st = makeStore(file, fakeLogger(warns));
    const realParse = JSON.parse;
    const parse = vi.spyOn(JSON, 'parse').mockImplementation(((text: string) =>
      text === onDisk
        ? {
            version: 99,
            get groups(): never {
              throw new Error('a shape this build cannot read');
            },
          }
        : realParse(text)) as never);
    const copy = failCopies();
    try {
      st.load();
    } finally {
      parse.mockRestore();
      copy.mockRestore();
    }

    expect(st.isReadOnly()).toBe(true);
    const failed = warns.find((w) => /could not be read/.test(w.msg));
    expect(failed?.fields).toMatchObject({ setAsideError: expect.stringContaining('EPERM') });
    expect(failed?.fields?.setAsideRetry).toBeUndefined(); // no promise that cannot be kept
    // and no save ever comes for it, so the file is exactly as it was
    st.upsertSession(sess('a'));
    st.save();
    expect(fs.readFileSync(file, 'utf8')).toBe(onDisk);
    expect(setAsides()).toEqual([]);
  });

  it('an absurdly large damaged file is not pinned in memory — it is copied instead', () => {
    const huge = `{${'x'.repeat(4 * 1024 * 1024)}`; // one byte over MAX_HELD_POST_MORTEM_BYTES
    fs.writeFileSync(file, huge);
    const warns: Line[] = [];
    const st = makeStore(file, fakeLogger(warns));
    const copy = failCopies();
    try {
      st.load();
    } finally {
      copy.mockRestore();
    }
    st.save();

    const kept = setAsides();
    expect(kept).toHaveLength(1);
    // held bytes would have made this 'written-from-memory'; they were not held
    expect(last(warns).fields).toMatchObject({ setAsideHow: 'copied' });
    expect(fs.statSync(path.join(dir, kept[0])).size).toBe(huge.length);
    expect(savedIds()).toEqual([]);
  });

  it('says nothing about retrying when the set-aside worked first time', () => {
    fs.writeFileSync(file, CORRUPT);
    const warns: Line[] = [];
    const st = makeStore(file, fakeLogger(warns));
    st.load();
    st.upsertSession(sess('a'));
    st.save();
    expect(warns).toHaveLength(1);
    expect(warns[0].fields?.setAsideRetry).toBeUndefined();
    expect(savedIds()).toEqual(['a']);
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

// P2-E18-17 — the #404 audit's fifth finding.
//
// `transport` survives a quit and a relaunch today by deep-clone happenstance:
// `upsertSession` and `listSessions` `JSON.parse(JSON.stringify(...))` whole
// records and the loader hands `raw.sessions` through, so nothing ever names
// the field. That is exactly the shape #153's follow-up already broke ONCE, on
// this same field, in `sessions:create` — where a record rebuilt field by field
// wiped it on every start and Direct mode could not survive a relaunch.
//
// What this protects is not a preference, it is the promise that makes flipping
// the default safe (#381): a card that explicitly chose Terminal keeps Terminal.
// Lose the field on disk and "never chose" is what comes back — which follows
// the default, i.e. silently migrates that card to Direct.
describe('PersistedSession.transport survives quit -> relaunch (P2-E18-17)', () => {
  const withTransport = (id: string, transport: 'pty' | 'stream'): PersistedSession => ({
    ...sess(id),
    transport,
  });

  // `pty` and not `stream`: with Direct the default, a card that came back
  // saying `stream` proves nothing — that is what an ABSENT field produces
  // downstream too. `pty` is the value no default can supply.
  it('an explicit Terminal choice is still Terminal after a reload', () => {
    const a = makeStore(file);
    a.load();
    a.upsertSession(withTransport('one', 'pty'));
    a.save();

    const b = makeStore(file); // "relaunch"
    expect(b.load().sessions[0].transport).toBe('pty');
    expect(b.listSessions()[0].transport).toBe('pty'); // the path sessions:create reads
  });

  it('an explicit Direct choice round-trips as a VALUE, not as silence', () => {
    const a = makeStore(file);
    a.load();
    a.upsertSession(withTransport('one', 'stream'));
    a.save();

    const b = makeStore(file);
    b.load();
    // `toBe('stream')` alone would pass on a record that lost the field and was
    // re-defaulted somewhere; `in` is what says the card's own answer is there.
    expect('transport' in b.listSessions()[0]).toBe(true);
    expect(b.listSessions()[0].transport).toBe('stream');
  });

  // The third population, and the one a "helpful" migration would destroy:
  // absent means "never chose" and must come back absent, so the card keeps
  // following whatever the default is at the time it starts.
  it('a card that never chose comes back with no transport at all', () => {
    const a = makeStore(file);
    a.load();
    a.upsertSession(sess('one'));
    a.save();

    const b = makeStore(file);
    b.load();
    expect(b.listSessions()[0].transport).toBeUndefined();
  });

  // Named for what it actually pins: `upsertSession` REPLACES the record whole
  // (`store.ts`: `this.state.sessions[i] = copy`), so this is de-duplication by
  // id plus the field riding along on a FULL record — not preservation across a
  // partial upsert, which the store does not offer and a caller must not assume.
  it('upserting the same card replaces rather than duplicates, transport included', () => {
    const st = makeStore(file);
    st.load();
    st.upsertSession(withTransport('one', 'pty'));
    st.upsertSession({ ...withTransport('one', 'pty'), layoutSlot: 4 });

    expect(st.snapshot().sessions).toHaveLength(1);
    expect(st.snapshot().sessions[0].transport).toBe('pty');
  });

  // Not shared refs with the caller, on the field's own account: the store
  // clones in and out, so a caller mutating its copy cannot rewrite a stored
  // transport choice from under the next session start.
  it('the caller cannot mutate a stored choice through its own object', () => {
    const st = makeStore(file);
    st.load();
    const mine = withTransport('one', 'pty');
    st.upsertSession(mine);

    mine.transport = 'stream';

    expect(st.listSessions()[0].transport).toBe('pty');
  });
});

// #484 — a card's conversation identity is a CHAIN, and the chain is the only
// thing standing between a resume that never got a turn and an orphaned
// conversation. It has to survive the round trip the same way the id does.
describe('PersistedSession.nativeSessionLineage survives quit -> relaunch (#484)', () => {
  const withChain = (id: string, lineage?: string[]): PersistedSession => ({
    ...sess(id),
    nativeSessionId: 'conv-c',
    nativeSessionLineage: lineage,
  });

  it('round-trips the ancestors, in order', () => {
    const a = makeStore(file);
    a.load();
    a.upsertSession(withChain('one', ['conv-b', 'conv-a']));
    a.save();

    const b = makeStore(file); // "relaunch"
    b.load();
    expect(b.listSessions()[0].nativeSessionLineage).toEqual(['conv-b', 'conv-a']);
    expect(b.listSessions()[0].nativeSessionId).toBe('conv-c');
  });

  it('a card written before the field existed comes back with no chain, not a broken one', () => {
    // every card in every existing workspace file is in this shape
    const a = makeStore(file);
    a.load();
    a.upsertSession({ ...sess('one'), nativeSessionId: 'conv-a' });
    a.save();

    const b = makeStore(file);
    b.load();
    expect(b.listSessions()[0].nativeSessionLineage).toBeUndefined();
    expect(b.listSessions()[0].nativeSessionId).toBe('conv-a');
  });

  it('a hand-edited chain is normalized rather than dropping the card', () => {
    // the resume walk asks the provider about each of these in turn, so a
    // number or a blank in the list would become a question about `''`
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        sessions: [
          {
            ...sess('one'),
            nativeSessionId: 'conv-c',
            nativeSessionLineage: ['conv-b', 7, '', 'conv-b', null, 'conv-a'],
          },
        ],
        groups: [],
        window: null,
        layout: null,
      })
    );

    const st = makeStore(file);
    st.load();
    expect(st.listSessions()).toHaveLength(1); // the card survives
    expect(st.listSessions()[0].nativeSessionLineage).toEqual(['conv-b', 'conv-a']);
  });

  it('a chain that is not a list at all degrades to no chain, keeping the head', () => {
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        sessions: [{ ...sess('one'), nativeSessionId: 'conv-c', nativeSessionLineage: 'conv-b' }],
        groups: [],
        window: null,
        layout: null,
      })
    );

    const st = makeStore(file);
    st.load();
    expect(st.listSessions()[0].nativeSessionLineage).toBeUndefined();
    expect(st.listSessions()[0].nativeSessionId).toBe('conv-c');
  });
});

// #539 — two cards pointing at ONE conversation is a state #484's repair sweep
// was fenced against creating but could not undo. The load unties it, once, and
// nothing is destroyed doing so: the loser keeps the pointer in `cededNativeIds`.
describe('duplicate conversation pointers are untied at load (#539)', () => {
  const write = (sessions: unknown[], version = CURRENT_VERSION): void => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({ version, sessions, groups: [], window: null, layout: null })
    );
  };
  /**
   * A card in THE SAME FOLDER as its neighbours — which is what makes two cards
   * duplicates at all. `sess()` gives every card a folder of its own, and a
   * conversation is `<root>/<slug of the folder>/<id>.jsonl`, so two cards in
   * different folders holding one id name two different files and are correctly
   * left alone.
   */
  const inFolder = (id: string) => ({
    ...sess(id),
    identity: { ...sess(id).identity, folder: 'C:/Projects/shared' },
  });

  it('leaves one owner and hands the other card its pointer back on the ceded list', () => {
    // the owner-reported pair: `Switchboard.ai` and `Switchboard.ai-2`, one id
    write([
      { ...inFolder('one'), nativeSessionId: 'conv-x' },
      { ...inFolder('two'), nativeSessionId: 'conv-x' },
    ]);
    const st = makeStore(file);
    st.load();

    const [a, b] = st.listSessions();
    expect(a.nativeSessionId).toBe('conv-x');
    expect(b.nativeSessionId).toBeUndefined();
    expect(b.cededNativeIds).toEqual(['conv-x']); // NOT deleted
    expect(st.listUntangled()).toEqual([
      {
        cardId: 'two',
        cardTitle: 'two',
        nativeSessionId: 'conv-x',
        keptByCardId: 'one',
        keptByTitle: 'one',
      },
    ]);
  });

  it('says so in the log — a repair the user cannot see is the bug it repairs', () => {
    write([
      { ...inFolder('one'), nativeSessionId: 'conv-x' },
      { ...inFolder('two'), nativeSessionId: 'conv-x' },
    ]);
    const notes: string[] = [];
    const st = makeStore(file, { warn: (m: string) => notes.push(m) } as never);
    st.load();
    expect(notes.some((n) => n.includes('same conversation'))).toBe(true);
  });

  it('persists the cede, so the next launch does not undo it', () => {
    write([
      { ...inFolder('one'), nativeSessionId: 'conv-x' },
      { ...inFolder('two'), nativeSessionId: 'conv-x' },
    ]);
    const a = makeStore(file);
    a.load();
    a.save();

    const b = makeStore(file); // "relaunch"
    b.load();
    expect(b.listSessions()[1].cededNativeIds).toEqual(['conv-x']);
    expect(b.listUntangled()).toEqual([]); // nothing left to untie
  });


  it('leaves alone two cards holding one id in DIFFERENT folders', () => {
    // a conversation is `<root>/<slug of the folder>/<id>.jsonl`, so this is two
    // files, not one — and `sess()` gives every card its own folder, which is
    // why the fixtures above have to opt into sharing one
    write([
      { ...sess('one'), nativeSessionId: 'conv-x' },
      { ...sess('two'), nativeSessionId: 'conv-x' },
    ]);
    const st = makeStore(file);
    st.load();
    expect(st.listSessions().map((x) => x.nativeSessionId)).toEqual(['conv-x', 'conv-x']);
    expect(st.listUntangled()).toEqual([]);
  });

  it('changes nothing, and says nothing, on an ordinary workspace', () => {
    write([
      { ...sess('one'), nativeSessionId: 'conv-a' },
      { ...sess('two'), nativeSessionId: 'conv-b' },
    ]);
    const st = makeStore(file);
    st.load();
    expect(st.listSessions().map((x) => x.nativeSessionId)).toEqual(['conv-a', 'conv-b']);
    expect(st.listUntangled()).toEqual([]);
  });

  it('does NOT untie a file from the future — nothing on that path is written', () => {
    // read-only: this build cannot see all of the file, so it must not act on a
    // reading it already knows is partial
    write(
      [
        { ...inFolder('one'), nativeSessionId: 'conv-x' },
        { ...inFolder('two'), nativeSessionId: 'conv-x' },
      ],
      CURRENT_VERSION + 1
    );
    const st = makeStore(file);
    st.load();
    expect(st.isReadOnly()).toBe(true);
    expect(st.listSessions().map((x) => x.nativeSessionId)).toEqual(['conv-x', 'conv-x']);
    expect(st.listUntangled()).toEqual([]);
  });

  it('round-trips a ceded list and normalizes a hand-edited one', () => {
    write([{ ...sess('one'), nativeSessionId: 'conv-a', cededNativeIds: ['x', 7, '', 'x', 'y'] }]);
    const st = makeStore(file);
    st.load();
    expect(st.listSessions()[0].cededNativeIds).toEqual(['x', 'y']);
  });

  it('leaves a card written before the field existed with no ceded list', () => {
    write([{ ...sess('one'), nativeSessionId: 'conv-a' }]);
    const st = makeStore(file);
    st.load();
    expect(st.listSessions()[0].cededNativeIds).toBeUndefined();
  });

  it('schedules the save itself — a cede that only lived in memory is a lie', () => {
    // NOTHING else here writes: no `save()` call, no upsert. If `load()` does
    // not arm the debounce, the next launch undoes the untangle and re-shows the
    // notice the user already read.
    write([
      { ...inFolder('one'), nativeSessionId: 'conv-x' },
      { ...inFolder('two'), nativeSessionId: 'conv-x' },
    ]);
    vi.useFakeTimers();
    try {
      makeStore(file).load();
      vi.advanceTimersByTime(1000);
    } finally {
      vi.useRealTimers();
    }
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      sessions: { cededNativeIds?: string[] }[];
    };
    expect(onDisk.sessions[1].cededNativeIds).toEqual(['conv-x']);
  });

  it('arms nothing on an ordinary workspace', () => {
    write([{ ...sess('one'), nativeSessionId: 'conv-a' }]);
    const before = fs.readFileSync(file, 'utf8');
    vi.useFakeTimers();
    try {
      makeStore(file).load();
      vi.advanceTimersByTime(1000);
    } finally {
      vi.useRealTimers();
    }
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });
});

// #539 — the notice outlives the run, because both repairs happen once and then
// the state that produced them is gone. Held in memory it would be lost the
// first time the user quit without opening the drawer.
describe('unacknowledged history repairs survive a quit (#539)', () => {
  const notice = (id: string) => ({
    id,
    kind: 'ceded' as const,
    cardId: 'two',
    cardTitle: 'Switchboard.ai-2',
    nativeSessionId: 'conv-x',
    keptByTitle: 'Switchboard.ai',
  });

  it('round-trips', () => {
    const a = makeStore(file);
    a.load();
    a.setHistoryRepairs([notice('ceded:two:conv-x')]);
    a.save();

    const b = makeStore(file); // "relaunch"
    b.load();
    expect(b.listHistoryRepairs()).toEqual([notice('ceded:two:conv-x')]);
  });

  it('a fresh workspace has none, rather than undefined', () => {
    const st = makeStore(file);
    st.load();
    expect(st.listHistoryRepairs()).toEqual([]);
  });

  it('drops a record this build cannot render rather than half-saying it', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: CURRENT_VERSION,
        historyRepairs: [notice('ok'), { id: 'bad', kind: 'invented' }, 7],
      })
    );
    const st = makeStore(file);
    st.load();
    expect(st.listHistoryRepairs().map((n) => n.id)).toEqual(['ok']);
  });

  it('caps what it takes off disk as well as what it writes', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: CURRENT_VERSION,
        historyRepairs: Array.from({ length: 40 }, (_, i) => notice(`n-${i}`)),
      })
    );
    const st = makeStore(file);
    st.load();
    expect(st.listHistoryRepairs()).toHaveLength(MAX_HISTORY_REPAIR_NOTICES);
  });

  it('the caller cannot mutate the list through its own array', () => {
    const st = makeStore(file);
    st.load();
    const mine = [notice('ceded:two:conv-x')];
    st.setHistoryRepairs(mine);
    mine[0].cardTitle = 'tampered';
    expect(st.listHistoryRepairs()[0].cardTitle).toBe('Switchboard.ai-2');
  });
});

// Found in review of P2-E14-05b: the sanitizer's all-or-nothing rule was doing
// the right thing silently, which #344 says a repair may not do — and it was
// still letting an EQUAL pair through, which is the exact "looks configured,
// silences nothing" failure the item set out to close.
describe('the quiet window is all-or-nothing, and says when it dropped one', () => {
  const load = (notifications: unknown): { prefs: ReturnType<WorkspaceStore['getNotificationPrefs']>; notes: string[] } => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: CURRENT_VERSION, notifications }));
    const notes: string[] = [];
    const st = makeStore(file, {
      warn: (m: string) => void notes.push(m),
      info: () => {},
      error: () => {},
      debug: () => {},
    } as unknown as Logger);
    st.load();
    return { prefs: st.getNotificationPrefs(), notes };
  };

  it('refuses an equal pair — a zero-length window, not a 24-hour one', () => {
    const { prefs } = load({ enabled: true, quietStart: '09:00', quietEnd: '09:00' });
    expect(prefs.quietStart).toBeUndefined();
    expect(prefs.quietEnd).toBeUndefined();
  });

  it('drops a lone end, and NAMES the good half it took with it (#344)', () => {
    const { prefs, notes } = load({ enabled: true, quietStart: '22:00' });
    expect(prefs.quietStart).toBeUndefined();
    expect(notes.some((n) => n.includes('notification settings'))).toBe(true);
  });

  it('names both ends when one is unparseable, because both are lost', () => {
    const { prefs, notes } = load({ enabled: true, quietStart: '22:00', quietEnd: '10pm' });
    expect(prefs.quietStart).toBeUndefined();
    expect(prefs.quietEnd).toBeUndefined();
    expect(notes.some((n) => n.includes('notification settings'))).toBe(true);
  });

  it('a good pair is kept and says nothing', () => {
    const { prefs, notes } = load({ enabled: true, quietStart: '22:00', quietEnd: '07:00' });
    expect(prefs).toMatchObject({ quietStart: '22:00', quietEnd: '07:00' });
    expect(notes.filter((n) => n.includes('notification settings'))).toEqual([]);
  });
});
