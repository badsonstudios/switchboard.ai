// A system crash mid-save must not cost the workspace (#1410).
//
// On 2026-10-21 a video-driver crash left `workspace.json` as 28,581 zero bytes
// — the size had reached the disk, the data had not — and the next launch
// started empty: every session, group and setting (the theme included) gone.
// These pin the two halves of the fix: the save flushes before it renames, and
// a last-good backup stands behind the main file when it cannot be read.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp' },
  screen: { getAllDisplays: () => [] },
  BrowserWindow: class {},
}));

import { WorkspaceStore, backupPathOf, type PersistedSession } from './store';
import { Logger } from '../log/logger';
import { cleanupTempDirs, tempDir } from '../../test-temp-dirs';

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

const sess = (id: string): PersistedSession => ({
  id,
  identity: { title: id, folder: `C:/tmp/${id}`, providerId: 'claude-code' },
  layoutSlot: 0,
  nativeSessionId: `native-${id}`,
  suspendedAt: '2026-07-19T00:00:00.000Z',
});

let dir: string;
let file: string;
let bak: string;
const stores: WorkspaceStore[] = [];
const makeStore = (log?: Logger): WorkspaceStore => {
  const s = new WorkspaceStore(file, log);
  stores.push(s);
  return s;
};

beforeEach(() => {
  dir = tempDir('sb-ws-bak-');
  file = path.join(dir, 'workspace.json');
  bak = backupPathOf(file);
});

// flush before the rm, for the reason store.test.ts gives (#213)
afterEach(() => {
  vi.restoreAllMocks();
  for (const s of stores.splice(0)) {
    try {
      s.save();
    } catch {
      /* teardown never throws — a failed flush is a leaked dir, not a red test */
    }
  }
  cleanupTempDirs();
});

/** What the crash left: the right length, every byte zero. */
const zeroOut = (target: string): void => {
  fs.writeFileSync(target, Buffer.alloc(fs.statSync(target).size));
};

/**
 * Two saves of a workspace with a card, a group and a theme — the first save
 * has no backup to keep (nothing good was loaded), the second keeps the first.
 */
function buildWorkspace(): void {
  const st = makeStore();
  st.load();
  st.upsertGroup({ id: 'g1', name: 'Work', color: '#4a90d9' });
  st.upsertSession({ ...sess('a'), groupId: 'g1' });
  st.setUi({ theme: 'nordic' });
  st.save();
  st.upsertSession(sess('b'));
  st.save();
}

describe('a workspace file the crash zeroed comes back from the backup (#1410)', () => {
  it('restores the sessions, groups and settings of the save before', () => {
    buildWorkspace();
    expect(fs.existsSync(bak)).toBe(true);
    zeroOut(file);

    const warns: Line[] = [];
    const s = makeStore(fakeLogger(warns)).load();

    expect(s.sessions.map((x) => x.id)).toEqual(['a']);
    expect(s.sessions[0].groupId).toBe('g1');
    expect(s.groups.map((g) => g.name)).toEqual(['Work']);
    expect(s.ui).toEqual({ theme: 'nordic' });
    expect(warns).toHaveLength(1);
    expect(warns[0].msg).toContain('restored the sessions, groups and settings from the last good backup');
    expect(warns[0].fields).toMatchObject({ backup: bak });
    expect(typeof warns[0].fields?.backupSavedAt).toBe('string');
  });

  it('still sets the damaged file aside for the post-mortem', () => {
    buildWorkspace();
    zeroOut(file);
    makeStore().load();

    const asides = fs.readdirSync(dir).filter((n) => n.startsWith('workspace.json.corrupt-'));
    expect(asides).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir, asides[0])).every((b) => b === 0)).toBe(true);
  });

  it('writes the restored workspace back, so the main file loads cleanly again', () => {
    buildWorkspace();
    zeroOut(file);
    const st = makeStore();
    st.load();
    st.save();

    const warns: Line[] = [];
    const again = makeStore(fakeLogger(warns)).load();
    expect(again.sessions.map((x) => x.id)).toEqual(['a']);
    expect(warns).toEqual([]);
  });

  it('a missing main file with a good backup is restored too, and says so', () => {
    buildWorkspace();
    fs.rmSync(file);

    const warns: Line[] = [];
    const s = makeStore(fakeLogger(warns)).load();
    expect(s.sessions.map((x) => x.id)).toEqual(['a']);
    expect(warns[0].msg).toContain('workspace file was missing');
  });

  it('starts empty — with the old warning, naming the backup — when both are unreadable', () => {
    buildWorkspace();
    zeroOut(file);
    zeroOut(bak);

    const warns: Line[] = [];
    const s = makeStore(fakeLogger(warns)).load();
    expect(s.sessions).toEqual([]);
    expect(s.groups).toEqual([]);
    expect(warns).toHaveLength(1);
    expect(warns[0].msg).toContain('starting with an empty workspace');
    expect(warns[0].fields).toMatchObject({ backup: bak });
    expect(typeof warns[0].fields?.backupError).toBe('string');
  });

  it('a first launch — no file, no backup — is still silent and empty', () => {
    const warns: Line[] = [];
    const s = makeStore(fakeLogger(warns)).load();
    expect(s.sessions).toEqual([]);
    expect(warns).toEqual([]);
  });
});

describe('the backup only ever holds bytes known to load (#1410)', () => {
  it('a damaged backup is not overwritten by the first save of a run that started empty', () => {
    fs.writeFileSync(file, '{half a workspace');
    fs.writeFileSync(bak, '{half a backup');
    const st = makeStore();
    st.load();
    st.upsertSession(sess('a'));
    st.save();
    // nothing good was ever loaded, so nothing was promoted
    expect(fs.readFileSync(bak, 'utf8')).toBe('{half a backup');

    st.upsertSession(sess('b'));
    st.save();
    // …and the second save keeps the first, which this run wrote itself
    const kept = JSON.parse(fs.readFileSync(bak, 'utf8')) as { sessions: PersistedSession[] };
    expect(kept.sessions.map((x) => x.id)).toEqual(['a']);
  });

  it('a cleanly loaded file becomes the backup at the first save', () => {
    buildWorkspace();
    const before = fs.readFileSync(file, 'utf8');
    const st = makeStore();
    st.load();
    st.upsertSession(sess('c'));
    st.save();
    expect(fs.readFileSync(bak, 'utf8')).toBe(before);
  });

  it('a backup that cannot be written is said once, and the save itself still counts', () => {
    buildWorkspace();
    const real = fs.writeFileSync;
    vi.spyOn(fs, 'writeFileSync').mockImplementation((...args: Parameters<typeof fs.writeFileSync>) => {
      if (String(args[0]).endsWith('.bak.tmp')) throw new Error('EPERM: backup');
      return real(...args);
    });
    const warns: Line[] = [];
    const st = makeStore(fakeLogger(warns));
    st.load();
    for (const id of ['c', 'd', 'e']) {
      st.upsertSession(sess(id));
      st.save();
    }
    expect(warns.map((w) => w.msg)).toEqual([
      'could not keep the workspace backup — saving itself is unaffected',
    ]);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as { sessions: PersistedSession[] };
    expect(saved.sessions.map((x) => x.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });
});

describe('the save flushes before it renames (#1410)', () => {
  it('writes the temp file with flush on, then renames it over the workspace file', () => {
    const order: string[] = [];
    const write = fs.writeFileSync;
    const rename = fs.renameSync;
    vi.spyOn(fs, 'writeFileSync').mockImplementation((...args: Parameters<typeof fs.writeFileSync>) => {
      const opts = args[2];
      if (String(args[0]) === `${file}.tmp`)
        order.push(typeof opts === 'object' && opts?.flush === true ? 'flushed write' : 'unflushed write');
      return write(...args);
    });
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(to) === file) order.push('rename');
      return rename(from, to);
    });
    const st = makeStore();
    st.load();
    st.upsertSession(sess('a'));
    st.save();
    expect(order).toEqual(['flushed write', 'rename']);
  });
});

describe('the backup and the rest of the store (#1410)', () => {
  it('a save that fails leaves the backup alone, and promotes nothing', () => {
    buildWorkspace();
    const bakBefore = fs.readFileSync(bak, 'utf8');
    const st = makeStore();
    st.load();
    const rename = fs.renameSync;
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(to) === file) throw new Error('EPERM: rename');
      return rename(from, to);
    });
    st.upsertSession(sess('c'));
    st.save();
    spy.mockRestore();
    expect(fs.readFileSync(bak, 'utf8')).toBe(bakBefore);
  });

  it('a backup from a newer version is restored read-only, and says so', () => {
    buildWorkspace();
    const kept = JSON.parse(fs.readFileSync(bak, 'utf8')) as Record<string, unknown>;
    fs.writeFileSync(bak, JSON.stringify({ ...kept, version: 999 }));
    zeroOut(file);

    const warns: Line[] = [];
    const st = makeStore(fakeLogger(warns));
    const s = st.load();
    expect(s.sessions.map((x) => x.id)).toEqual(['a']);
    expect(warns.map((w) => w.msg)).toEqual([
      expect.stringContaining('restored the sessions, groups and settings from the last good backup') as unknown,
      expect.stringContaining('written by a newer version') as unknown,
    ]);
    // read-only: the restore is NOT written back over a file this build cannot fully read
    // (the set-aside COPIES the damaged bytes, so the zeroed file is still
    // there — and still zeroed)
    st.save();
    expect(fs.readFileSync(file).every((b) => b === 0)).toBe(true);
  });
});
