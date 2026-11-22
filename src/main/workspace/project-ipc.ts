// Projects IPC (E42 step 1, #1637). CRUD over the store's project records, plus
// the two git READS the project card and the Open project dialog need.
// Nothing here creates, removes or repairs a worktree; that is #1506 and #1638.
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
  pathKey,
  type ProjectInspection,
  type ProjectRecord,
  type ProjectWorktrees,
  type WorktreeInfo,
} from '../../shared/projects';
import { IpcBroker } from '../ipc/broker';
import { LogFields, Logger } from '../log/logger';

const NAME_MAX = 60;
/** git answers these in milliseconds; a hung one must not hang the dialog */
const GIT_BUDGET_MS = 5_000;

export interface ProjectGit {
  commonDir(folder: string, budgetMs?: number): Promise<string | null>;
  worktreeList(folder: string, budgetMs?: number): Promise<WorktreeInfo[] | null>;
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
  log: Logger
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
}
