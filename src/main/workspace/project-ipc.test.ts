// The projects IPC seam (E42 step 1, #1637): what it validates, what it writes,
// and that it refuses with a value and a log line, never a throw (#326's shape).
//
// A real `WorkspaceStore` on a temp file, so the one-card-per-repo rule and the
// persisted shape are the store's own; git is a stand-in, because what is under
// test is what the handler does with git's answers.
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { registerProjectIpc, type ProjectGit } from './project-ipc';
import { WorkspaceStore } from './store';
import { GROUP_PALETTE } from '../../shared/group-palette';
import { IpcBroker } from '../ipc/broker';
import { Logger } from '../log/logger';
import type { ProjectInspection, ProjectRecord, WorktreeInfo } from '../../shared/projects';
import { cleanupTempDirs, tempDir } from '../../test-temp-dirs';

type Handler = (e: unknown, ...args: unknown[]) => unknown;

let dir: string;
let repo: string;
let store: WorkspaceStore;
const stores: WorkspaceStore[] = [];

beforeEach(() => {
  dir = tempDir('sb-proj-');
  // a real directory, because the handlers check that the folder exists
  repo = tempDir('sb-repo-');
  store = new WorkspaceStore(path.join(dir, 'workspace.json'));
  stores.push(store);
  store.load();
});

afterEach(() => {
  for (const s of stores.splice(0)) {
    try {
      s.save();
    } catch {
      /* a failed flush is a leaked dir, not a red test */
    }
  }
  cleanupTempDirs();
});

function harness(git: Partial<ProjectGit> = {}) {
  const handlers = new Map<string, Handler>();
  const warnings: string[] = [];
  const broker = {
    handle: (channel: string, fn: Handler) => handlers.set(channel, fn),
  } as unknown as IpcBroker;
  const log: Logger = {
    debug: () => {},
    info: () => {},
    warn: (msg: string) => warnings.push(msg),
    error: () => {},
    child: () => log,
  };
  const worktrees: WorktreeInfo[] = [
    { path: repo, primary: true, branch: 'main', head: 'a', detached: false },
    { path: path.join(repo, '..', 'wt-1'), primary: false, branch: 'feat/x', head: 'b', detached: false },
  ];
  const fakeGit: ProjectGit = {
    commonDir: async () => path.join(repo, '.git'),
    worktreeList: async () => worktrees,
    ...git,
  };
  registerProjectIpc(store, fakeGit, broker, log);
  const call = (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args);
  return { call, warnings, worktrees };
}

describe('projects:inspect', () => {
  it('describes a repo folder: common dir, primary checkout, worktrees, a name', async () => {
    const h = harness();
    const info = (await h.call('projects:inspect', repo)) as ProjectInspection;
    expect(info.commonDir).toBe(path.join(repo, '.git'));
    expect(info.primaryPath).toBe(repo);
    expect(info.suggestedName).toBe(path.basename(repo));
    expect(info.worktrees).toHaveLength(2);
    expect(info.existingProjectId).toBeUndefined();
  });

  it('answers null for a folder that is not in a repo', async () => {
    const h = harness({ commonDir: async () => null });
    expect(await h.call('projects:inspect', repo)).toBeNull();
  });

  it('refuses a relative path or a missing folder, with a warning', async () => {
    const h = harness();
    expect(await h.call('projects:inspect', 'relative/path')).toBeNull();
    expect(await h.call('projects:inspect', path.join(repo, 'nope'))).toBeNull();
    expect(h.warnings).toHaveLength(2);
  });

  it('refuses a UNC path before running git or touching the network (#1637 review)', async () => {
    let gitRan = false;
    const h = harness({
      commonDir: async () => {
        gitRan = true;
        return null;
      },
    });
    const unc = String.raw`\\host\share\repo`;
    expect(await h.call('projects:inspect', unc)).toBeNull();
    expect(await h.call('projects:inspect', '//host/share/repo')).toBeNull();
    expect(await h.call('projects:open', { folder: unc })).toBeNull();
    expect(gitRan).toBe(false);
    expect(h.warnings.every((w) => w.includes('local absolute path'))).toBe(true);
  });
});

describe('projects:open', () => {
  it('stores one record for the repo, named after its folder', async () => {
    const h = harness();
    const p = (await h.call('projects:open', { folder: repo })) as ProjectRecord;
    expect(p).toMatchObject({ name: path.basename(repo), primaryPath: repo, hiddenWorktrees: [] });
    expect(store.listProjects()).toEqual([p]);
  });

  it('opening the same repo again answers the project it already is', async () => {
    const h = harness();
    const first = (await h.call('projects:open', { folder: repo, name: 'Mine' })) as ProjectRecord;
    const again = (await h.call('projects:open', { folder: repo, name: 'Other' })) as ProjectRecord;
    expect(again.id).toBe(first.id);
    expect(store.listProjects()).toHaveLength(1);
    const info = (await h.call('projects:inspect', repo)) as ProjectInspection;
    expect(info.existingProjectId).toBe(first.id);
  });

  it('refuses a folder outside a repo, or a blank name, writing nothing', async () => {
    const h = harness();
    expect(await h.call('projects:open', { folder: repo, name: '   ' })).toBeNull();
    const notRepo = harness({ commonDir: async () => null });
    expect(await notRepo.call('projects:open', { folder: repo })).toBeNull();
    expect(store.listProjects()).toEqual([]);
  });
});

describe('projects:update and projects:remove', () => {
  it('renames, recolours and hides worktrees; refuses a colour off the palette', async () => {
    const h = harness();
    const p = (await h.call('projects:open', { folder: repo })) as ProjectRecord;
    expect(await h.call('projects:update', p.id, { name: ' Renamed ' })).toMatchObject({ name: 'Renamed' });
    expect(await h.call('projects:update', p.id, { color: '#123456' })).toBeNull();
    const hidden = (await h.call('projects:update', p.id, {
      hiddenWorktrees: ['C:\\Projects\\WT-1\\', 'c:/projects/wt-1'],
    })) as ProjectRecord;
    // stored in pathKey form, once
    expect(hidden.hiddenWorktrees).toEqual(['c:/projects/wt-1']);
    expect(store.listProjects()[0].name).toBe('Renamed');
  });

  it('removes the record and answers whether there was one', async () => {
    const h = harness();
    const p = (await h.call('projects:open', { folder: repo })) as ProjectRecord;
    expect(h.call('projects:remove', p.id)).toBe(true);
    expect(h.call('projects:remove', p.id)).toBe(false);
    expect(store.listProjects()).toEqual([]);
  });
});

describe('projects:worktrees', () => {
  it('reads the worktrees fresh, and answers null worktrees when git cannot', async () => {
    const h = harness();
    const p = (await h.call('projects:open', { folder: repo })) as ProjectRecord;
    expect(await h.call('projects:worktrees', p.id)).toEqual({ projectId: p.id, worktrees: h.worktrees });

    const broken = harness({ worktreeList: async () => null });
    expect(await broken.call('projects:worktrees', p.id)).toEqual({ projectId: p.id, worktrees: null });
  });
});

describe('the store keeps projects across a relaunch, and drops what it cannot use', () => {
  it('round-trips, and loads a duplicate repo as one card', async () => {
    const h = harness();
    const p = (await h.call('projects:open', { folder: repo })) as ProjectRecord;
    store.save();
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'workspace.json'), 'utf8')) as {
      projects: unknown[];
    };
    raw.projects.push({ ...p, id: 'dupe' }, { id: 'broken' });
    fs.writeFileSync(path.join(dir, 'workspace.json'), JSON.stringify(raw));

    const again = new WorkspaceStore(path.join(dir, 'workspace.json'));
    stores.push(again);
    again.load();
    expect(again.listProjects().map((x) => x.id)).toEqual([p.id]);
  });

  it('gives an off-palette colour a palette one, and keeps one record per id (#1637 review)', async () => {
    const h = harness();
    const p = (await h.call('projects:open', { folder: repo })) as ProjectRecord;
    store.save();
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'workspace.json'), 'utf8')) as {
      projects: ProjectRecord[];
    };
    raw.projects[0].color = 'red; background: url(x)';
    raw.projects.push({ ...p, commonDir: path.join(repo, 'other', '.git') });
    fs.writeFileSync(path.join(dir, 'workspace.json'), JSON.stringify(raw));

    const again = new WorkspaceStore(path.join(dir, 'workspace.json'));
    stores.push(again);
    again.load();
    const list = again.listProjects();
    expect(list.map((x) => x.id)).toEqual([p.id]);
    expect((GROUP_PALETTE as readonly string[]).includes(list[0].color)).toBe(true);
  });
});
