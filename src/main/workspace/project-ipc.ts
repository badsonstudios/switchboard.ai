// Projects IPC (E42 step 1, #1637). CRUD over the store's project records, plus
// the two git READS the project card and the Open project dialog need.
//
// Step 2 (#1506) adds making a worktree (the build itself is
// `worktree-jobs.ts`), the project settings that feed it, the app-wide
// worktree folder, and the read the busy-folder prompt needs. Removing a
// worktree is #1638.
//
// Refuses the way `group-ipc.ts` does (#326): resolve `null` (or `false`) and
// write one log line, never throw. Ids are minted here, never accepted from the
// renderer on create.
//
// Capabilities reuse existing words rather than adding a vocabulary entry:
// the list and the record edits are `groups.*` (organising the rail, the same
// power a group has), and the two calls that run git are `git.read`.
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { WorkspaceStore } from './store';
import { GROUP_PALETTE } from '../../shared/group-palette';
import {
  cleanRelative,
  isInside,
  isInsideRelative,
  pathKey,
  PROJECT_LIST_MAX,
  SETUP_COMMAND_MAX,
  type CheckoutInfo,
  type NewWorktreeRequest,
  type ProjectBranches,
  type ProjectDefaults,
  type ProjectInspection,
  type ProjectRecord,
  type ProjectSettingProblem,
  type ProjectWorktrees,
  type WorktreeInfo,
} from '../../shared/projects';
import { isRev } from '../git/git-log';
import { isAbsoluteLocal } from '../git/worktree-git';
import type { WorktreeJobs } from './worktree-jobs';
import { IpcBroker } from '../ipc/broker';
import { LogFields, Logger } from '../log/logger';

const NAME_MAX = 60;
/** git answers these in milliseconds; a hung one must not hang the dialog */
const GIT_BUDGET_MS = 5_000;

export interface ProjectGit {
  commonDir(folder: string, budgetMs?: number): Promise<string | null>;
  worktreeList(folder: string, budgetMs?: number): Promise<WorktreeInfo[] | null>;
}

/** What step 2 (#1506) adds; optional so a harness can register step 1 alone. */
export interface ProjectIpcExtras {
  jobs: WorktreeJobs;
  /** the app-wide default folder, for the settings page */
  defaultRoot: string;
  git: {
    root(folder: string, budgetMs?: number): Promise<string | null>;
    branches(folder: string, budgetMs?: number): Promise<ProjectBranches | null>;
    isIgnored(folder: string, rel: string, budgetMs?: number): Promise<boolean | null>;
    /** branch and changed-file count, for the busy-folder prompt */
    status(folder: string, budgetMs?: number): Promise<{ branch?: string; files: unknown[]; unreadable?: string }>;
  };
  /** "Open folder in editor" on a worktree, after main checked it is one */
  openInEditor?: (folder: string) => 'opened' | 'no-editor';
}

function cleanName(n: unknown): string | null {
  if (typeof n !== 'string') return null;
  const t = n.trim().slice(0, NAME_MAX);
  return t.length > 0 ? t : null;
}

function isPaletteColor(c: unknown): c is string {
  return typeof c === 'string' && (GROUP_PALETTE as readonly string[]).includes(c.toLowerCase());
}

/**
 * A folder the renderer may hand us to run git in: absolute and LOCAL (#1637
 * review). Every other git handler is scoped to known session folders; these
 * two take a picked folder, so a UNC path (\\host\share, //host/share) is
 * refused outright: a stat and a git run against a remote host would leak NTLM
 * credentials and wait out the budget.
 */
function isLocalAbsolute(p: unknown): p is string {
  return typeof p === 'string' && path.isAbsolute(p) && !/^[\\/]{2}/.test(p);
}

const HIDDEN_MAX = 200;

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/** The folder's name, from a path git printed (forward slashes) or a native one. */
function baseName(p: string): string {
  return p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;
}

export function registerProjectIpc(
  store: WorkspaceStore,
  git: ProjectGit,
  broker: IpcBroker,
  log: Logger,
  extras?: ProjectIpcExtras
): void {
  const refuse = <T extends null | false>(
    channel: string,
    reason: string,
    value: T,
    fields: LogFields = {}
  ): T => {
    log.warn(`${channel} refused: ${reason}`, fields);
    return value;
  };

  /**
   * What a folder is, as a project: its common dir, its primary checkout and
   * its worktrees. null when it is not a git repo (or git is missing), which
   * the dialog turns into "this folder isn't a git repository".
   */
  const inspect = async (folder: string): Promise<ProjectInspection | null> => {
    const commonDir = await git.commonDir(folder, GIT_BUDGET_MS);
    if (!commonDir) return null;
    const worktrees = (await git.worktreeList(folder, GIT_BUDGET_MS)) ?? [];
    // The primary checkout is git's first entry. A bare repo has no checkout
    // of its own: fall back to the folder the user picked.
    const first = worktrees[0];
    const primaryPath = first && !first.bare ? first.path : folder;
    const existing = store
      .listProjects()
      .find((p) => pathKey(p.commonDir) === pathKey(commonDir));
    return {
      commonDir,
      primaryPath,
      suggestedName: baseName(primaryPath),
      worktrees,
      ...(existing ? { existingProjectId: existing.id } : {}),
    };
  };

  broker.handle('projects:list', () => store.listProjects());

  broker.handle('projects:inspect', async (_e, folder: unknown) => {
    if (!isLocalAbsolute(folder))
      return refuse('projects:inspect', 'folder must be a local absolute path', null);
    if (!(await isDirectory(folder)))
      return refuse('projects:inspect', 'folder is not a directory', null);
    return inspect(folder);
  });

  broker.handle('projects:open', async (_e, opts: { folder?: unknown; name?: unknown }) => {
    const folder = opts?.folder;
    if (!isLocalAbsolute(folder))
      return refuse('projects:open', 'folder must be a local absolute path', null);
    if (!(await isDirectory(folder)))
      return refuse('projects:open', 'folder is not a directory', null);
    const found = await inspect(folder);
    if (!found) return refuse('projects:open', 'folder is not in a git repository', null);
    // Opening a repo that is already a project answers that project: the
    // dialog then just reveals it, rather than failing on a double click.
    if (found.existingProjectId) {
      const existing = store.listProjects().find((p) => p.id === found.existingProjectId);
      if (existing) return existing;
    }
    const name = opts?.name === undefined ? found.suggestedName : cleanName(opts.name);
    if (!name) return refuse('projects:open', 'a project needs a non-empty name', null);
    const used = store.listProjects().length + store.listGroups().length;
    const project: ProjectRecord = {
      id: randomUUID(),
      name,
      color: GROUP_PALETTE[used % GROUP_PALETTE.length],
      commonDir: found.commonDir,
      primaryPath: found.primaryPath,
      hiddenWorktrees: [],
    };
    if (!store.upsertProject(project)) {
      // two opens raced: answer the one that won, the same as a re-open above
      const winner = store
        .listProjects()
        .find((p) => pathKey(p.commonDir) === pathKey(found.commonDir));
      return winner ?? refuse('projects:open', 'that repo is already a project', null);
    }
    log.info('project opened', { projectId: project.id, worktrees: found.worktrees.length });
    return project;
  });

  broker.handle(
    'projects:update',
    (_e, id: unknown, patch: { name?: unknown; color?: unknown; hiddenWorktrees?: unknown }) => {
      if (typeof id !== 'string') return refuse('projects:update', 'id must be a string', null);
      const prior = store.listProjects().find((p) => p.id === id);
      if (!prior) {
        // removed elsewhere while a menu was open: nothing to fix
        log.debug('projects:update for an unknown project — ignored', { projectId: id });
        return null;
      }
      const next: ProjectRecord = { ...prior };
      if (patch?.name !== undefined) {
        const name = cleanName(patch.name);
        if (!name)
          return refuse('projects:update', 'project name must be non-empty', null, { projectId: id });
        next.name = name;
      }
      if (patch?.color !== undefined) {
        if (!isPaletteColor(patch.color))
          return refuse('projects:update', 'color must be one of the group palette', null, {
            projectId: id,
          });
        next.color = patch.color.toLowerCase();
      }
      if (patch?.hiddenWorktrees !== undefined) {
        const h = patch.hiddenWorktrees;
        if (
          !Array.isArray(h) ||
          h.length > HIDDEN_MAX ||
          // pathKey form, compared and never run: either platform's absolute
          // spelling is a well-formed key
          !h.every(
            (x) => typeof x === 'string' && (path.win32.isAbsolute(x) || path.posix.isAbsolute(x))
          )
        )
          return refuse('projects:update', 'hiddenWorktrees must be a list of paths', null, {
            projectId: id,
          });
        next.hiddenWorktrees = [...new Set(h.map(pathKey))];
      }
      store.upsertProject(next);
      return next;
    }
  );

  broker.handle('projects:remove', (_e, id: unknown) => {
    if (typeof id !== 'string') return refuse('projects:remove', 'id must be a string', false);
    const removed = store.removeProject(id);
    if (removed) log.info('project removed from the sessions list', { projectId: id });
    return removed;
  });

  /**
   * A project's worktrees, read fresh. `worktrees: null` when git could not be
   * read (the primary checkout moved, git missing): the card says so and still
   * lists the sessions it can match (P6).
   */
  broker.handle('projects:worktrees', async (_e, id: unknown): Promise<ProjectWorktrees | null> => {
    if (typeof id !== 'string') return refuse('projects:worktrees', 'id must be a string', null);
    const project = store.listProjects().find((p) => p.id === id);
    if (!project) return null;
    // The common dir works as a place to ask from even when the primary
    // checkout's folder has gone: git runs fine with its cwd in the .git dir.
    const from = (await isDirectory(project.primaryPath))
      ? project.primaryPath
      : project.commonDir;
    const worktrees = await git.worktreeList(from, GIT_BUDGET_MS);
    if (!worktrees) log.debug('could not read a project’s worktrees', { projectId: id });
    return { projectId: id, worktrees };
  });

  if (extras) registerWorktreeIpc(store, git, broker, extras, refuse);
}

type Refuse = <T extends null | false>(channel: string, reason: string, value: T, fields?: LogFields) => T;

/** Where a project's git runs from: its primary checkout, else its common dir. */
async function repoFolder(project: ProjectRecord): Promise<string> {
  return (await isDirectory(project.primaryPath)) ? project.primaryPath : project.commonDir;
}

/** The settings patch `projects:configure` accepts; null clears a value. */
interface ConfigurePatch {
  baseRef?: unknown;
  worktreeRoot?: unknown;
  copyFiles?: unknown;
  sharedDirs?: unknown;
  setupCommand?: unknown;
}

/**
 * Step 2 (#1506). Capabilities: making a worktree and storing the command its
 * setup runs are `sessions.spawn` (they start processes); the branch list and
 * the busy-folder read are `git.read`; discarding a failed build is
 * `git.write`; the job list and dismissing one organise the rail (`groups.*`).
 */
function registerWorktreeIpc(
  store: WorkspaceStore,
  git: ProjectGit,
  broker: IpcBroker,
  extras: ProjectIpcExtras,
  refuse: Refuse
): void {
  const find = (id: unknown): ProjectRecord | undefined =>
    typeof id === 'string' ? store.listProjects().find((p) => p.id === id) : undefined;

  broker.handle('projects:branches', async (_e, id: unknown): Promise<ProjectBranches | null> => {
    const project = find(id);
    if (!project) return refuse('projects:branches', 'no such project', null);
    return extras.git.branches(await repoFolder(project), GIT_BUDGET_MS);
  });

  broker.handle('projects:createWorktree', async (_e, req: NewWorktreeRequest) => {
    if (!req || typeof req !== 'object') return refuse('projects:createWorktree', 'no request', null);
    return extras.jobs.start({
      projectId: String(req.projectId),
      branch: req.branch,
      newBranch: req.newBranch === true,
      ...(typeof req.base === 'string' && req.base !== '' ? { base: req.base } : {}),
      ...(typeof req.title === 'string' ? { title: req.title } : {}),
      runSetup: req.runSetup !== false,
    });
  });

  broker.handle('projects:jobs', () => extras.jobs.list());
  broker.handle('projects:claimJob', (_e, id: unknown) =>
    typeof id === 'string' ? extras.jobs.claim(id) : refuse('projects:claimJob', 'id must be a string', null)
  );
  broker.handle('projects:dismissJob', (_e, id: unknown) =>
    typeof id === 'string' ? extras.jobs.dismiss(id) : refuse('projects:dismissJob', 'id must be a string', false)
  );
  broker.handle('projects:discardJob', async (_e, id: unknown) =>
    typeof id === 'string' ? extras.jobs.discard(id) : refuse('projects:discardJob', 'id must be a string', false)
  );

  /**
   * Project settings (screen E). Answers the saved project and the entries it
   * would not keep, each with why; a bad entry is left out, never the patch.
   * A shared folder must be ignored by git: a tracked folder linked into a
   * worktree would put one branch's files under another.
   */
  broker.handle('projects:configure', async (_e, id: unknown, patch: ConfigurePatch) => {
    const project = find(id);
    if (!project) return refuse('projects:configure', 'no such project', null);
    if (!patch || typeof patch !== 'object') return refuse('projects:configure', 'no settings', null);
    const next: ProjectRecord = { ...project };
    const problems: ProjectSettingProblem[] = [];
    if (patch.baseRef !== undefined) {
      if (patch.baseRef === null || patch.baseRef === '') delete next.baseRef;
      else if (isRev(patch.baseRef)) next.baseRef = patch.baseRef;
      else
        problems.push({
          code: 'base-invalid',
          field: 'base',
          entry: typeof patch.baseRef === 'string' ? patch.baseRef.slice(0, 80) : '',
        });
    }
    if (patch.worktreeRoot !== undefined) {
      if (patch.worktreeRoot === null || patch.worktreeRoot === '') delete next.worktreeRoot;
      else if (!isAbsoluteLocal(patch.worktreeRoot)) problems.push({ code: 'folder-not-local', field: 'folder' });
      else if (isInside(patch.worktreeRoot, project.primaryPath))
        problems.push({ code: 'folder-inside-repo', field: 'folder' });
      else next.worktreeRoot = patch.worktreeRoot;
    }
    const list = (raw: unknown, field: 'copy' | 'share'): string[] | null => {
      if (raw === undefined) return null;
      if (!Array.isArray(raw)) {
        problems.push({ code: 'not-a-list', field });
        return null;
      }
      const out: string[] = [];
      for (const x of raw.slice(0, PROJECT_LIST_MAX)) {
        if (typeof x === 'string' && x.trim() === '') continue;
        if (!isInsideRelative(x)) problems.push({ code: 'entry-outside', field, entry: String(x).slice(0, 80) });
        else out.push(cleanRelative(x));
      }
      return [...new Set(out)];
    };
    const copies = list(patch.copyFiles, 'copy');
    if (copies) next.copyFiles = copies;
    const shared = list(patch.sharedDirs, 'share');
    if (shared) {
      const from = await repoFolder(project);
      const kept: string[] = [];
      for (const rel of shared) {
        const ignored = await extras.git.isIgnored(from, rel, GIT_BUDGET_MS);
        if (ignored === true) kept.push(rel);
        else problems.push({ code: ignored === false ? 'share-not-ignored' : 'share-unknown', field: 'share', entry: rel });
      }
      next.sharedDirs = kept;
    }
    if (patch.setupCommand !== undefined) {
      if (patch.setupCommand === null || (typeof patch.setupCommand === 'string' && patch.setupCommand.trim() === ''))
        delete next.setupCommand;
      else if (typeof patch.setupCommand === 'string' && patch.setupCommand.length <= SETUP_COMMAND_MAX)
        next.setupCommand = patch.setupCommand.trim();
      else problems.push({ code: 'setup-too-long', field: 'setup' });
    }
    for (const k of ['copyFiles', 'sharedDirs'] as const) if (next[k]?.length === 0) delete next[k];
    store.upsertProject(next);
    return { project: next, problems };
  });

  broker.handle('projects:defaults', (): ProjectDefaults => ({
    ...store.getProjectDefaults(),
    defaultRoot: extras.defaultRoot,
  }));

  broker.handle('projects:setDefaults', (_e, d: { worktreeRoot?: unknown }): ProjectDefaults | null => {
    const root = d?.worktreeRoot;
    if (root === null || root === '' || root === undefined) store.setProjectDefaults({});
    else if (isAbsoluteLocal(root)) store.setProjectDefaults({ worktreeRoot: root });
    else return refuse('projects:setDefaults', 'the folder must be a local absolute path', null);
    return { ...store.getProjectDefaults(), defaultRoot: extras.defaultRoot };
  });

  /**
   * What the busy-folder prompt needs about a folder someone is about to start
   * a plain session in: its checkout (git's toplevel), repo, branch and how
   * many files are changed. null for a folder that is not in a repo.
   */
  broker.handle('projects:checkout', async (_e, folder: unknown): Promise<CheckoutInfo | null> => {
    if (!isLocalAbsolute(folder)) return refuse('projects:checkout', 'folder must be a local absolute path', null);
    if (!(await isDirectory(folder))) return null;
    const toplevel = await extras.git.root(folder, GIT_BUDGET_MS);
    const commonDir = toplevel ? await git.commonDir(folder, GIT_BUDGET_MS) : null;
    if (!toplevel || !commonDir) return null;
    // status bounds only its config guard; the count is a nicety, so a slow
    // one is given up on rather than holding the new session back
    const st = await Promise.race([
      extras.git.status(toplevel, GIT_BUDGET_MS).catch(() => null),
      new Promise<null>((r) => setTimeout(() => r(null), GIT_BUDGET_MS)),
    ]);
    return {
      toplevel: path.normalize(toplevel),
      commonDir,
      branch: st?.branch ?? null,
      dirty: st && !st.unreadable ? st.files.length : null,
    };
  });

  /** "Open folder in editor" on a worktree: only a folder git lists for this project. */
  broker.handle('projects:openInEditor', async (_e, id: unknown, folder: unknown) => {
    const project = find(id);
    if (!project || typeof folder !== 'string') return refuse('projects:openInEditor', 'no such project', false);
    const worktrees = (await git.worktreeList(await repoFolder(project), GIT_BUDGET_MS)) ?? [];
    const hit = worktrees.find((w) => !w.bare && pathKey(w.path) === pathKey(folder));
    if (!hit || !(await isDirectory(hit.path))) return 'no-folder';
    return extras.openInEditor ? extras.openInEditor(hit.path) : 'no-editor';
  });
}
