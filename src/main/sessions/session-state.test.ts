// #290 — the per-session state directory has an owner.
//
// FIXTURES ONLY. Every `stateDir` in this file is a registered temp directory
// (`src/test-temp-dirs.ts`, #213). Nothing here may be aimed at a real
// per-user state directory: the module under test deletes trees recursively,
// and the run-10 incident behind `withTempDirAt`'s comment — a sweeper pointed
// at a live `%TEMP%`, ~81,600 directories gone — is exactly what that rule is
// made of. If you add a test, point it at `tempDir()` and nothing else.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { cleanupTempDirs, tempDir } from '../../test-temp-dirs';
import { SessionManager, PtyLike } from './session-manager';
import { ContributionRegistry } from '../../shared/extensibility/registry';
import { MainContributions } from '../extensibility/contributions';
import { Logger } from '../log/logger';
import { writeSessionSettings } from '../providers/claude';
import {
  isSessionStateDirName,
  removeSessionStateDir,
  sweepOrphanSessionStateDirs,
  DEFAULT_ORPHAN_MIN_AGE_MS,
} from './session-state';

// ---- harness ----------------------------------------------------------------

interface CapturedLog extends Logger {
  warnings: string[];
  infos: string[];
}
function captureLog(): CapturedLog {
  const warnings: string[] = [];
  const infos: string[] = [];
  const log = {
    debug: () => {},
    info: (m: string) => infos.push(m),
    warn: (m: string) => warnings.push(m),
    error: () => {},
    child: () => log,
    warnings,
    infos,
  } as CapturedLog;
  return log;
}

/** A directory shaped exactly like a real one: both files, real content. */
function seedSessionDir(stateDir: string, id = randomUUID()): string {
  const dir = path.join(stateDir, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'settings.json'), '{"hooks":{}}');
  fs.writeFileSync(path.join(dir, 'hook-token'), 'deadbeef');
  return id;
}

function age(stateDir: string, id: string, ms: number): void {
  const t = new Date(Date.now() - ms);
  fs.utimesSync(path.join(stateDir, id), t, t);
}

let stateDir: string;
beforeEach(() => {
  stateDir = tempDir('sb-ss-');
});
afterEach(() => {
  vi.restoreAllMocks();
  cleanupTempDirs();
});

// ---- the guard --------------------------------------------------------------
//
// `removeSessionStateDir` builds a path from a string and then deletes it
// recursively. The name filter is what stands between that and the rest of the
// tree, so it is pinned before anything that uses it.
describe('only a session-id-shaped name is ever a candidate', () => {
  it('accepts what randomUUID actually mints', () => {
    for (let i = 0; i < 20; i++) expect(isSessionStateDirName(randomUUID())).toBe(true);
  });

  it('refuses every way a path could escape the state dir', () => {
    for (const name of ['', '.', '..', '../..', 'a/b', 'a\\b', '/', 'C:\\Windows']) {
      expect(isSessionStateDirName(name)).toBe(false);
    }
  });

  it('refuses the neighbours in the same directory', () => {
    // stateDir's root holds the generated forwarder; a support session or a
    // curious user can leave anything else beside it.
    for (const name of ['hook-forwarder.cjs', 'notes.txt', 'backup', 'sessions']) {
      expect(isSessionStateDirName(name)).toBe(false);
    }
  });

  it('refuses near-misses on the UUID shape', () => {
    const id = randomUUID();
    for (const name of [id + 'x', id.slice(0, -1), id.replace(/-/g, ''), `${id} `, `.${id}`]) {
      expect(isSessionStateDirName(name)).toBe(false);
    }
  });
});

// ---- the targeted delete ----------------------------------------------------
describe('removeSessionStateDir', () => {
  it('takes the directory and everything in it', () => {
    const log = captureLog();
    const id = seedSessionDir(stateDir);

    expect(removeSessionStateDir(stateDir, id, log)).toBe(true);

    expect(fs.existsSync(path.join(stateDir, id))).toBe(false);
    expect(log.warnings).toEqual([]);
  });

  it('is idempotent and silent the second time — the lifecycle calls it twice', () => {
    const log = captureLog();
    const id = seedSessionDir(stateDir);
    removeSessionStateDir(stateDir, id, log);

    expect(removeSessionStateDir(stateDir, id, log)).toBe(false);

    // ENOENT on the second pass is the ORDINARY case (`remove()` then the
    // exit, or an exit then a card close). A warning here would fire on every
    // single session close.
    expect(log.warnings).toEqual([]);
  });

  it('a session that never spawned has nothing to remove, quietly', () => {
    const log = captureLog();
    expect(removeSessionStateDir(stateDir, randomUUID(), log)).toBe(false);
    expect(log.warnings).toEqual([]);
  });

  it('refuses an id that is not session-shaped, and leaves the state dir standing', () => {
    const log = captureLog();
    fs.writeFileSync(path.join(stateDir, 'hook-forwarder.cjs'), '// forwarder');
    const keep = seedSessionDir(stateDir);

    for (const bad of ['', '.', '..', 'hook-forwarder.cjs']) {
      expect(removeSessionStateDir(stateDir, bad, log)).toBe(false);
    }

    expect(fs.existsSync(stateDir)).toBe(true);
    expect(fs.existsSync(path.join(stateDir, 'hook-forwarder.cjs'))).toBe(true);
    expect(fs.existsSync(path.join(stateDir, keep))).toBe(true);
  });

  it('a delete that fails is one log line, never a throw (P6)', () => {
    const log = captureLog();
    const id = seedSessionDir(stateDir);
    vi.spyOn(fs, 'rmSync').mockImplementation(() => {
      throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
    });

    expect(removeSessionStateDir(stateDir, id, log)).toBe(false);

    expect(log.warnings).toEqual(['could not remove session state dir']);
  });
});

// ---- the lifecycle, through the manager -------------------------------------
//
// Driven through a registry whose `buildSpawn` writes the REAL settings file,
// so what these tests delete is what the app actually creates.
class Ptys implements PtyLike {
  exits = new Map<string, (code: number) => void>();
  /** does `remove()` produce an exit? A corpse's does not — it already fired. */
  constructor(private readonly exitOnRemove = true) {}
  spawn(opts: { id: string; command: string; args: string[] }) {
    return {
      pid: 4242,
      onExit: (l: (code: number) => void) => {
        this.exits.set(opts.id, l);
        return () => {};
      },
      kill: () => this.exits.get(opts.id)?.(0),
    };
  }
  remove(id: string): void {
    if (this.exitOnRemove) this.exits.get(id)?.(0);
  }
  exit(id: string, code = 0): void {
    this.exits.get(id)?.(code);
  }
}

function settingsWritingRegistry(): ContributionRegistry<MainContributions> {
  const r = new ContributionRegistry<MainContributions>();
  r.register('provider-adapter', {
    manifest: { id: 'fake', displayName: 'Fake', version: '0', capabilities: ['sessions.spawn'] },
    buildSpawn: (o) => {
      const args: string[] = [];
      if (o.resumeSessionId) args.push('--resume', o.resumeSessionId);
      // the real coupling: the settings file exists before the process does
      args.push('--settings', writeSessionSettings(o.stateDir, o.sessionId, o.settings ?? {}));
      return { command: 'fake-cli', args, env: {} };
    },
  });
  return r;
}

const identity = { title: 't', folder: 'C:/tmp/x', providerId: 'fake' };

function manager(ptys: Ptys, log = captureLog()): { m: SessionManager; log: CapturedLog } {
  return { m: new SessionManager(settingsWritingRegistry(), ptys, log, stateDir), log };
}

describe('a live session owns its state dir; a dead one does not (#290)', () => {
  it('spawning writes the directory the leak was made of', () => {
    const { m } = manager(new Ptys());
    const s = m.create(identity);
    expect(fs.existsSync(path.join(stateDir, s.id, 'settings.json'))).toBe(true);
  });

  it('a session that EXITS ON ITS OWN loses its directory — no card teardown needed', () => {
    // The path #282 was careful about and the reason "delete on card forget"
    // is the wrong lifecycle: nothing else ever runs for this session again.
    const ptys = new Ptys();
    const { m, log } = manager(ptys);
    const s = m.create(identity);

    ptys.exit(s.id, 1);

    expect(fs.existsSync(path.join(stateDir, s.id))).toBe(false);
    expect(log.warnings).toEqual([]);
    // the corpse itself stays — only its disk state went (#187)
    expect(m.get(s.id)?.exitCode).toBe(1);
  });

  it('closing the card of a session whose exit never came still takes it', () => {
    const ptys = new Ptys(false); // transport that reports no exit on remove
    const { m, log } = manager(ptys);
    const s = m.create(identity);

    m.remove(s.id);

    expect(fs.existsSync(path.join(stateDir, s.id))).toBe(false);
    expect(log.warnings).toEqual([]);
  });

  it('remove() then a late exit is silent — the two deletes do not fight', () => {
    const ptys = new Ptys(false);
    const { m, log } = manager(ptys);
    const s = m.create(identity);

    m.remove(s.id);
    expect(() => ptys.exit(s.id, 0)).not.toThrow();

    expect(log.warnings).toEqual([]);
  });

  it('one session ending never touches a LIVE session’s directory', () => {
    const ptys = new Ptys();
    const { m } = manager(ptys);
    const dying = m.create(identity);
    const live = m.create(identity);

    ptys.exit(dying.id, 0);

    expect(fs.existsSync(path.join(stateDir, dying.id))).toBe(false);
    expect(fs.existsSync(path.join(stateDir, live.id, 'settings.json'))).toBe(true);
  });

  it('a RESUMED session gets its own fresh directory — nothing a resume needs was deleted', () => {
    // The load-bearing claim behind deleting at exit rather than at card
    // forget: `create()` mints a NEW id every spawn, and `buildSpawn` writes a
    // NEW settings file for it. Nothing under stateDir carries across.
    const ptys = new Ptys();
    const { m, log } = manager(ptys);
    const first = m.create(identity);
    const nativeId = 'claude-conversation-1234';
    ptys.exit(first.id, 0);
    expect(fs.existsSync(path.join(stateDir, first.id))).toBe(false);

    const resumed = m.create(identity, { resumeSessionId: nativeId });

    expect(resumed.id).not.toBe(first.id);
    const settings = path.join(stateDir, resumed.id, 'settings.json');
    expect(fs.existsSync(settings)).toBe(true);
    expect(JSON.parse(fs.readFileSync(settings, 'utf8'))).toEqual({});
    expect(log.warnings).toEqual([]);
  });
});

// ---- the sweep --------------------------------------------------------------
describe('the bootstrap sweep takes what previous runs left (#290)', () => {
  const old = DEFAULT_ORPHAN_MIN_AGE_MS + 60_000;

  it('removes an aged session directory', () => {
    const log = captureLog();
    const id = seedSessionDir(stateDir);
    age(stateDir, id, old);

    expect(sweepOrphanSessionStateDirs(stateDir, { log })).toEqual({
      removed: 1,
      kept: 0,
      failed: 0,
    });

    expect(fs.existsSync(path.join(stateDir, id))).toBe(false);
    expect(log.infos).toEqual(['swept orphaned session state dirs']);
  });

  it('keeps one younger than the floor', () => {
    const log = captureLog();
    const id = seedSessionDir(stateDir);
    age(stateDir, id, DEFAULT_ORPHAN_MIN_AGE_MS - 60_000);

    expect(sweepOrphanSessionStateDirs(stateDir, { log })).toEqual({
      removed: 0,
      kept: 1,
      failed: 0,
    });

    expect(fs.existsSync(path.join(stateDir, id))).toBe(true);
    expect(log.infos).toEqual([]); // nothing happened, nothing said
  });

  it('never touches the forwarder, a stray file, or a directory that is not ours', () => {
    const log = captureLog();
    fs.writeFileSync(path.join(stateDir, 'hook-forwarder.cjs'), '// forwarder');
    fs.mkdirSync(path.join(stateDir, 'backup'));
    fs.writeFileSync(path.join(stateDir, 'backup', 'keep.txt'), 'x');
    // a FILE named like a session id — the isDirectory() gate, not the name one
    const fileNamedLikeADir = randomUUID();
    fs.writeFileSync(path.join(stateDir, fileNamedLikeADir), 'not a directory');
    for (const name of ['hook-forwarder.cjs', 'backup', fileNamedLikeADir]) {
      const t = new Date(Date.now() - old);
      fs.utimesSync(path.join(stateDir, name), t, t);
    }

    expect(sweepOrphanSessionStateDirs(stateDir, { log })).toEqual({
      removed: 0,
      kept: 0,
      failed: 0,
    });

    expect(fs.existsSync(path.join(stateDir, 'hook-forwarder.cjs'))).toBe(true);
    expect(fs.readFileSync(path.join(stateDir, 'backup', 'keep.txt'), 'utf8')).toBe('x');
    expect(fs.existsSync(path.join(stateDir, fileNamedLikeADir))).toBe(true);
  });

  it('sorts a mixed directory correctly in one pass', () => {
    const log = captureLog();
    const dead = [seedSessionDir(stateDir), seedSessionDir(stateDir)];
    const young = seedSessionDir(stateDir);
    for (const id of dead) age(stateDir, id, old);
    age(stateDir, young, 1_000);
    fs.writeFileSync(path.join(stateDir, 'hook-forwarder.cjs'), '// forwarder');

    expect(sweepOrphanSessionStateDirs(stateDir, { log })).toEqual({
      removed: 2,
      kept: 1,
      failed: 0,
    });

    for (const id of dead) expect(fs.existsSync(path.join(stateDir, id))).toBe(false);
    expect(fs.existsSync(path.join(stateDir, young))).toBe(true);
    expect(fs.existsSync(path.join(stateDir, 'hook-forwarder.cjs'))).toBe(true);
  });

  it('stops at the budget and leaves the rest for the next start', () => {
    const log = captureLog();
    const ids = [seedSessionDir(stateDir), seedSessionDir(stateDir), seedSessionDir(stateDir)];
    for (const id of ids) age(stateDir, id, old);
    // a clock that jumps a minute per read: the first candidate is inside the
    // budget, everything after it is not
    let t = Date.now();
    const now = (): number => {
      t += 60_000;
      return t;
    };

    const r = sweepOrphanSessionStateDirs(stateDir, { log, budgetMs: 90_000, now });

    expect(r.removed).toBe(1);
    expect(r.kept).toBe(2);
    expect(ids.filter((id) => fs.existsSync(path.join(stateDir, id)))).toHaveLength(2);
  });

  it('never takes a directory it was told is live, however old it is', () => {
    // A session left running for two days is older than any floor worth
    // having, so the age check cannot be what protects it.
    const log = captureLog();
    const live = seedSessionDir(stateDir);
    const dead = seedSessionDir(stateDir);
    for (const id of [live, dead]) age(stateDir, id, old * 10);

    expect(sweepOrphanSessionStateDirs(stateDir, { log, keep: new Set([live]) })).toEqual({
      removed: 1,
      kept: 0,
      failed: 0,
    });

    expect(fs.existsSync(path.join(stateDir, live))).toBe(true);
    expect(fs.existsSync(path.join(stateDir, dead))).toBe(false);
  });

  it('a state dir that does not exist yet is not a problem worth a word', () => {
    const log = captureLog();
    expect(sweepOrphanSessionStateDirs(path.join(stateDir, 'never-made'), { log })).toEqual({
      removed: 0,
      kept: 0,
      failed: 0,
    });
    expect(log.warnings).toEqual([]);
    expect(log.infos).toEqual([]);
  });

  it('a state dir it cannot read is one line, never a throw', () => {
    const log = captureLog();
    vi.spyOn(fs, 'readdirSync').mockImplementation(() => {
      throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
    });

    expect(() => sweepOrphanSessionStateDirs(stateDir, { log })).not.toThrow();

    expect(log.warnings).toEqual(['could not scan state dir for orphaned session dirs']);
  });

  it('a delete that fails is counted and reported, and the sweep carries on', () => {
    const log = captureLog();
    const ids = [seedSessionDir(stateDir), seedSessionDir(stateDir)];
    for (const id of ids) age(stateDir, id, old);
    const real = fs.rmSync;
    let first = true;
    vi.spyOn(fs, 'rmSync').mockImplementation(((p: fs.PathLike, o?: fs.RmOptions) => {
      if (first) {
        first = false;
        throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
      }
      return real(p, o);
    }) as typeof fs.rmSync);

    expect(sweepOrphanSessionStateDirs(stateDir, { log })).toEqual({
      removed: 1,
      kept: 0,
      failed: 1,
    });

    expect(log.infos).toEqual(['swept orphaned session state dirs']);
  });
});

// ---- the manager's seam onto the sweep --------------------------------------
describe('SessionManager.sweepOrphanStateDirs', () => {
  it('hands the sweep the sessions it currently has, so a live one survives', () => {
    const { m } = manager(new Ptys());
    const live = m.create(identity);
    // aged past every floor — the ONLY thing that can save it is `keep`
    age(stateDir, live.id, DEFAULT_ORPHAN_MIN_AGE_MS * 10);
    const dead = seedSessionDir(stateDir);
    age(stateDir, dead, DEFAULT_ORPHAN_MIN_AGE_MS * 10);

    expect(m.sweepOrphanStateDirs()).toEqual({ removed: 1, kept: 0, failed: 0 });

    expect(fs.existsSync(path.join(stateDir, live.id, 'settings.json'))).toBe(true);
    expect(fs.existsSync(path.join(stateDir, dead))).toBe(false);
  });

  it('sweeps the state dir it was constructed with, and nothing else', () => {
    const other = tempDir('sb-ss-other-');
    const otherId = seedSessionDir(other);
    fs.utimesSync(path.join(other, otherId), new Date(0), new Date(0));
    const mine = seedSessionDir(stateDir);
    age(stateDir, mine, DEFAULT_ORPHAN_MIN_AGE_MS + 60_000);
    const { m } = manager(new Ptys());

    expect(m.sweepOrphanStateDirs()).toEqual({ removed: 1, kept: 0, failed: 0 });

    expect(fs.existsSync(path.join(stateDir, mine))).toBe(false);
    expect(fs.existsSync(path.join(other, otherId))).toBe(true);
  });
});
