// The step 2 projects IPC (#1506): project settings (a shared folder must be
// ignored by git; copy and share entries must stay inside the checkout; the
// worktree folder must be outside the repo), the app-wide folder, the
// busy-folder read and Open in editor. Refusals answer a value and log; none
// throws. Real store on a temp file; git is a stand-in.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import { registerProjectIpc, type ProjectIpcExtras } from './project-ipc';
import { WorkspaceStore } from './store';
import { WorktreeJobs } from './worktree-jobs';
import { IpcBroker } from '../ipc/broker';
import type { Logger } from '../log/logger';
import type { CheckoutInfo, ProjectDefaults, ProjectRecord, WorktreeInfo } from '../../shared/projects';
import { cleanupTempDirs, tempDir } from '../../test-temp-dirs';

type Handler = (e: unknown, ...args: unknown[]) => unknown;

let dir: string;
let repo: string;
let store: WorkspaceStore;

beforeEach(() => {
  dir = tempDir('sb-projw-');
  repo = tempDir('sb-projw-repo-');
  store = new WorkspaceStore(path.join(dir, 'workspace.json'));
  store.load();
});

afterEach(() => {
  try {
    store.save();
  } catch {
    /* a failed flush is a leaked dir, not a red test */
  }
  cleanupTempDirs();
});

function harness(over: Partial<ProjectIpcExtras['git']> = {}, editor?: ProjectIpcExtras['openInEditor']) {
  const handlers = new Map<string, Handler>();
  const warnings: string[] = [];
  const broker = { handle: (c: string, fn: Handler) => handlers.set(c, fn) } as unknown as IpcBroker;
  const log: Logger = {
    debug: () => {},
    info: () => {},
    warn: (m: string) => warnings.push(m),
    error: () => {},
    child: () => log,
  };
  const worktrees: WorktreeInfo[] = [
    { path: repo, primary: true, branch: 'main', head: 'a', detached: false },
    { path: path.join(repo, '..', 'wt-1'), primary: false, branch: 'feat/x', head: 'b', detached: false },
  ];
  const git = {
    commonDir: async () => path.join(repo, '.git'),
    worktreeList: async () => worktrees,
  };
  const extrasGit: ProjectIpcExtras['git'] = {
    root: async () => repo,
    branches: async () => ({ local: ['main'], remote: [], defaultBase: 'main' }),
    isIgnored: async (_f, rel) => rel === 'node_modules' || rel === 'build',
    status: async () => ({ branch: 'main', files: [1, 2, 3] }),
    ...over,
  };
  const jobs = new WorktreeJobs({
    git: {} as never,
    store,
    root: () => path.join(dir, 'wts'),
    log,
    emit: () => {},
  });
  registerProjectIpc(store, git, broker, log, {
    jobs,
    defaultRoot: path.join(dir, 'default-wts'),
    git: extrasGit,
    ...(editor ? { openInEditor: editor } : {}),
  });
  const call = (c: string, ...args: unknown[]) => handlers.get(c)!({}, ...args);
  return { call, warnings, worktrees };
}

async function openProject(h: ReturnType<typeof harness>): Promise<ProjectRecord> {
  return (await h.call('projects:open', { folder: repo })) as ProjectRecord;
}

describe('projects:configure', () => {
  it('keeps ignored shared folders and inside-the-repo copy entries, and says why it dropped the rest', async () => {
    const h = harness();
    const p = await openProject(h);
    const r = (await h.call('projects:configure', p.id, {
      copyFiles: ['.claude/.env', '../outside', '', 'C:/abs'],
      sharedDirs: ['node_modules', 'src'],
      setupCommand: '  npm ci  ',
      baseRef: 'origin/main',
    })) as { project: ProjectRecord; problems: string[] };
    expect(r.project.copyFiles).toEqual(['.claude/.env']);
    expect(r.project.sharedDirs).toEqual(['node_modules']);
    expect(r.project.setupCommand).toBe('npm ci');
    expect(r.project.baseRef).toBe('origin/main');
    expect(r.problems).toHaveLength(3);
    expect(r.problems.some((x) => x.includes('"src"') && x.includes('not ignored'))).toBe(true);
    // and it is what the store now holds
    expect(store.listProjects()[0].sharedDirs).toEqual(['node_modules']);
  });

  it('refuses a worktree folder inside the repo, or a relative one; null clears it', async () => {
    const h = harness();
    const p = await openProject(h);
    let r = (await h.call('projects:configure', p.id, { worktreeRoot: path.join(repo, 'wts') })) as {
      project: ProjectRecord;
      problems: string[];
    };
    expect(r.project.worktreeRoot).toBeUndefined();
    expect(r.problems[0]).toMatch(/outside the repo/);
    r = (await h.call('projects:configure', p.id, { worktreeRoot: 'relative' })) as typeof r;
    expect(r.problems[0]).toMatch(/full path/);
    const outside = path.join(dir, 'elsewhere');
    r = (await h.call('projects:configure', p.id, { worktreeRoot: outside })) as typeof r;
    expect(r.project.worktreeRoot).toBe(outside);
    r = (await h.call('projects:configure', p.id, { worktreeRoot: null, setupCommand: null })) as typeof r;
    expect(r.project.worktreeRoot).toBeUndefined();
  });

  it('refuses a base that could be a flag, and an unknown project', async () => {
    const h = harness();
    const p = await openProject(h);
    const r = (await h.call('projects:configure', p.id, { baseRef: '--all' })) as { problems: string[] };
    expect(r.problems).toHaveLength(1);
    expect(await h.call('projects:configure', 'nope', {})).toBeNull();
    expect(h.warnings.some((w) => w.includes('projects:configure refused'))).toBe(true);
  });

  it('survives a reload with the settings repaired, not the project dropped', async () => {
    const h = harness();
    const p = await openProject(h);
    store.upsertProject({ ...p, copyFiles: ['ok.txt', '../evil'], made: ['x'] });
    store.save();
    const again = new WorkspaceStore(path.join(dir, 'workspace.json'));
    again.load();
    expect(again.listProjects()[0]).toMatchObject({ id: p.id, copyFiles: ['ok.txt'], made: ['x'] });
  });
});

describe('projects:defaults', () => {
  it('answers the default folder, and stores a chosen one until cleared', async () => {
    const h = harness();
    expect(((await h.call('projects:defaults')) as ProjectDefaults).defaultRoot).toBe(path.join(dir, 'default-wts'));
    const chosen = path.join(dir, 'mine');
    expect(((await h.call('projects:setDefaults', { worktreeRoot: chosen })) as ProjectDefaults).worktreeRoot).toBe(
      chosen
    );
    expect(await h.call('projects:setDefaults', { worktreeRoot: '//host/share' })).toBeNull();
    expect(((await h.call('projects:setDefaults', { worktreeRoot: null })) as ProjectDefaults).worktreeRoot).toBeUndefined();
  });
});

describe('projects:checkout', () => {
  it('names the checkout, its branch and how many files are changed', async () => {
    const h = harness();
    const info = (await h.call('projects:checkout', repo)) as CheckoutInfo;
    expect(info).toMatchObject({ toplevel: path.normalize(repo), branch: 'main', dirty: 3 });
  });

  it('answers null outside a repo, and refuses a UNC path', async () => {
    const h = harness({ root: async () => null });
    expect(await h.call('projects:checkout', repo)).toBeNull();
    expect(await h.call('projects:checkout', '//host/share')).toBeNull();
    expect(h.warnings).toHaveLength(1);
  });
});

describe('projects:openInEditor', () => {
  it('opens only a folder git lists as one of the project’s worktrees', async () => {
    const opened: string[] = [];
    const h = harness({}, (f) => {
      opened.push(f);
      return 'opened';
    });
    const p = await openProject(h);
    expect(await h.call('projects:openInEditor', p.id, repo)).toBe('opened');
    expect(await h.call('projects:openInEditor', p.id, path.join(dir, 'not-a-worktree'))).toBe('no-folder');
    expect(opened).toEqual([repo]);
  });
});
