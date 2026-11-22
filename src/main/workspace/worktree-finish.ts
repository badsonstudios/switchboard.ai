// Finishing a worktree (E42 step 3, #1638; mockup screen D): where it stands
// against the base, "Update from main", "Push & open pull request…", "Merge
// into main locally" (no remote only) and "Remove worktree…".
//
// Every action is re-checked HERE against git's own answers; the window only
// asks. The renderer hands us a project id and a folder, and the folder must
// be one git lists for that project, read fresh, before anything runs.
//
// ── UPDATE FROM MAIN IS A MERGE, NOT A REBASE ───────────────────────────────
// `spike/findings/1638-parallel-branch-conflicts.md`: a worktree's branch is
// usually pushed and often has a PR open. A rebase rewrites it (a force-push
// afterwards) and turns one conflict into a loop of them; a merge is one step,
// `merge --abort` undoes it, and the PR's squash removes the merge commit from
// main anyway. On conflicts the folder is LEFT mid-merge and the window says
// so, lists the files, and hands them to the worktree's session or the user.
// Nothing is ever resolved, stashed or aborted silently.
//
// ── REMOVAL ─────────────────────────────────────────────────────────────────
// Refuses uncommitted work unless the user insists; keeps a branch with
// commits that are not on the base (and no merged PR) unless the user unticks
// it; refuses when a different checkout now sits at that path; and UNLINKS
// SHARED FOLDERS BEFORE DELETING ANYTHING (#916) through `worktree-links.ts`.
// It never touches the conversations Claude Code filed for the folder: the
// CLI resumes a conversation by id from any folder, even once its own folder
// is gone (measured, CLI 2.1.322; see the findings note), so History keeps it.
import fs from 'fs';
import path from 'path';
import {
  baseBranchName,
  pathKey,
  PR_BODY_MAX,
  PR_TITLE_MAX,
  type FinishRefusal,
  type LocalMergeOutcome,
  type ProjectBranches,
  type ProjectRecord,
  type ProjectStats,
  type PullRequestContext,
  type PullRequestOutcome,
  type PullRequestRequest,
  type RemoveCheck,
  type RemoveOutcome,
  type RemoveRequest,
  type UpdateOutcome,
  type WorktreeInfo,
  type WorktreeStats,
} from '../../shared/projects';
import type { GitWriteResult } from '../git/git-write';
import { isAbsoluteLocal } from '../git/worktree-git';
import type { Logger } from '../log/logger';
import { errorText } from '../../shared/error-text';
import { createPr, prsForBranch, type GhFailure, type GhRunner } from './gh-cli';
import { forgetWorktree } from './worktree-jobs';
import { findLinks, isLink, linkDir, removeWorktreeFolder } from './worktree-links';

/** A read that feeds the card gets this long; the card shows nothing past it. */
const STATS_BUDGET_MS = 8_000;
/** How long a project's default base is reused before it is asked again. */
const BASE_TTL_MS = 60_000;
/** How many dirty files a refusal lists. */
const FILES_MAX = 50;

export interface FinishGit {
  worktreeList(folder: string, budgetMs?: number): Promise<WorktreeInfo[] | null>;
  root(folder: string, budgetMs?: number): Promise<string | null>;
  commonDir(folder: string, budgetMs?: number): Promise<string | null>;
  branches(folder: string, budgetMs?: number): Promise<ProjectBranches | null>;
  status(
    folder: string,
    budgetMs?: number
  ): Promise<{ branch?: string; files: ReadonlyArray<{ path: string }>; unreadable?: string }>;
  aheadBehind(folder: string, base: unknown, budgetMs?: number): Promise<{ ahead: number; behind: number } | null>;
  lineStats(folder: string, base: unknown, budgetMs?: number): Promise<{ added: number; removed: number } | null>;
  mergeInProgress(folder: string): Promise<boolean | null>;
  unmergedFiles(folder: string): Promise<string[] | null>;
  mergeRef(folder: string, ref: unknown, opts?: { noFf?: boolean }): Promise<GitWriteResult>;
  mergeAbort(folder: string): Promise<GitWriteResult>;
  remoteNames(folder: string): Promise<string[] | null>;
  countNotOn(folder: string, rev: unknown, base: unknown): Promise<number | null>;
  fetch(folder: string): Promise<GitWriteResult>;
  push(folder: string, opts?: { setUpstream?: boolean }): Promise<GitWriteResult>;
  worktreeRemove(repo: string, target: string, force: boolean): Promise<GitWriteResult>;
  worktreePrune(repo: string): Promise<GitWriteResult>;
  deleteBranch(repo: string, branch: unknown): Promise<GitWriteResult>;
  deleteMergedBranch(repo: string, branch: unknown): Promise<GitWriteResult>;
  revParse(folder: string, rev: unknown): Promise<string | null>;
}

export interface FinishStore {
  listProjects(): ProjectRecord[];
  upsertProject(p: ProjectRecord): boolean;
}

export interface WorktreeFinishDeps {
  git: FinishGit;
  gh: GhRunner;
  store: FinishStore;
  log: Logger;
}

type Located = {
  project: ProjectRecord;
  repo: string;
  wt: WorktreeInfo;
  all: WorktreeInfo[];
};

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

function ghCode(f: GhFailure): 'gh-missing' | 'gh-auth' | 'gh-failed' {
  return f === 'missing' ? 'gh-missing' : f === 'auth' ? 'gh-auth' : 'gh-failed';
}

const refused = <C extends FinishRefusal>(code: C, detail?: string, files?: string[]) => ({
  kind: 'refused' as const,
  code,
  ...(detail ? { detail: detail.slice(0, 400) } : {}),
  ...(files ? { files: files.slice(0, FILES_MAX) } : {}),
});

export class WorktreeFinisher {
  /** worktrees with an action running: a second one on the same folder waits its turn by refusing */
  private readonly busy = new Set<string>();
  private readonly bases = new Map<string, { base: string | null; at: number }>();

  constructor(private readonly deps: WorktreeFinishDeps) {}

  // ── where each worktree stands ─────────────────────────────────────────────

  /** `↑ahead ↓behind +added −removed` per worktree, for the card. Fail-open to nulls. */
  async stats(projectId: unknown): Promise<ProjectStats | null> {
    const project = this.find(projectId);
    if (!project) return null;
    const repo = await repoFolder(project);
    const list = await this.deps.git.worktreeList(repo, STATS_BUDGET_MS);
    if (!list) return null;
    const base = await this.baseOf(project, repo);
    const remotes = await this.deps.git.remoteNames(repo).catch(() => null);
    const live = list.filter((w) => !w.bare && !w.prunable && isAbsoluteLocal(w.path));
    const worktrees = await Promise.all(
      live.map(async (w): Promise<WorktreeStats> => {
        if (!base) return { path: w.path, base: null, ahead: null, behind: null, added: null, removed: null };
        const [ab, lines] = await Promise.all([
          this.deps.git.aheadBehind(w.path, base, STATS_BUDGET_MS).catch(() => null),
          this.deps.git.lineStats(w.path, base, STATS_BUDGET_MS).catch(() => null),
        ]);
        return {
          path: w.path,
          base,
          ahead: ab?.ahead ?? null,
          behind: ab?.behind ?? null,
          added: lines?.added ?? null,
          removed: lines?.removed ?? null,
        };
      })
    );
    return { projectId: project.id, hasRemote: remotes === null ? null : remotes.length > 0, base, worktrees };
  }

  // ── update from main ───────────────────────────────────────────────────────

  async update(projectId: unknown, folder: unknown): Promise<UpdateOutcome> {
    return this.exclusive(projectId, folder, async (at): Promise<UpdateOutcome> => {
      const { git, log } = this.deps;
      const { project, repo, wt } = at;
      if (!wt.branch) return refused('detached');
      if (await git.mergeInProgress(wt.path)) {
        return refused('merge-in-progress', undefined, (await git.unmergedFiles(wt.path)) ?? []);
      }
      const dirty = await this.dirtyFiles(wt.path);
      if (dirty === null) return refused('git-failed', 'git could not read what is changed in that folder');
      if (dirty.length > 0) return refused('dirty', undefined, dirty);
      const base = await this.baseOf(project, repo, true);
      if (!base) return refused('no-base');
      // bring the remote's base up to date first, when the base is a remote's
      const remotes = (await git.remoteNames(repo)) ?? [];
      if (remotes.some((r) => base.startsWith(`${r}/`))) {
        const f = await git.fetch(wt.path);
        if (!f.ok) return refused('fetch-failed', f.reason);
      }
      const ab = await git.aheadBehind(wt.path, base);
      if (ab && ab.behind === 0) return { kind: 'up-to-date', base };
      const m = await git.mergeRef(wt.path, base);
      if (m.ok) {
        log.info('worktree updated from its base', { projectId: project.id, commits: ab?.behind ?? null });
        return { kind: 'merged', base, commits: ab?.behind ?? 0 };
      }
      // stopped mid-merge: LEFT that way, on purpose, and said so
      if (await git.mergeInProgress(wt.path)) {
        const files = (await git.unmergedFiles(wt.path)) ?? [];
        log.info('worktree update stopped on conflicts', { projectId: project.id, files: files.length });
        return { kind: 'conflicts', base, files: files.slice(0, FILES_MAX) };
      }
      return refused('git-failed', m.reason);
    });
  }

  /** "Abort the update": `merge --abort`, only when a merge is stopped there. */
  async abortUpdate(projectId: unknown, folder: unknown): Promise<boolean> {
    const r = await this.exclusive(projectId, folder, async (at) => {
      if (!(await this.deps.git.mergeInProgress(at.wt.path))) return refused('git-failed', 'no update is stopped there');
      const a = await this.deps.git.mergeAbort(at.wt.path);
      return a.ok ? { kind: 'ok' as const } : refused('git-failed', a.reason);
    });
    return r.kind === 'ok';
  }

  // ── push & open pull request ───────────────────────────────────────────────

  async prContext(projectId: unknown, folder: unknown): Promise<PullRequestContext | null> {
    const at = await this.locate(projectId, folder);
    if ('code' in at || !at.wt.branch) return null;
    const { repo, wt, project } = at;
    const base = await this.baseOf(project, repo);
    const hasRemote = ((await this.deps.git.remoteNames(repo)) ?? []).length > 0;
    const ctx: PullRequestContext = {
      branch: wt.branch!,
      base: base ? baseBranchName(base) : null,
      existing: null,
      hasRemote,
      gh: null,
    };
    if (!hasRemote) return ctx;
    const found = await prsForBranch(this.deps.gh, wt.path, wt.branch!);
    if ('failure' in found) return { ...ctx, gh: ghCode(found.failure), ...(found.detail ? { detail: found.detail } : {}) };
    return { ...ctx, existing: found.prs.find((p) => p.state === 'OPEN') ?? null };
  }

  async openPr(req: PullRequestRequest): Promise<PullRequestOutcome> {
    if (!req || typeof req !== 'object') return refused('bad-request');
    const title = typeof req.title === 'string' ? req.title.replace(/[\r\n]+/g, ' ').trim() : '';
    const body = typeof req.body === 'string' ? req.body : '';
    if (title === '' || title.length > PR_TITLE_MAX || body.length > PR_BODY_MAX) return refused('bad-request');
    return this.exclusive(req.projectId, req.path, async (at): Promise<PullRequestOutcome> => {
      const { git, gh, log } = this.deps;
      const { project, repo, wt } = at;
      if (!wt.branch) return refused('detached');
      const remotes = (await git.remoteNames(repo)) ?? [];
      if (remotes.length === 0) return refused('no-remote');
      const base = await this.baseOf(project, repo, true);
      if (!base) return refused('no-base');
      // gh first: missing or signed out means nothing is pushed either
      const found = await prsForBranch(gh, wt.path, wt.branch);
      if ('failure' in found) return refused(ghCode(found.failure), found.detail);
      const open = found.prs.find((p) => p.state === 'OPEN');
      const pushed = await git.push(wt.path, { setUpstream: true });
      // an open PR is never doubled: its new commits are pushed to it instead
      if (open) return pushed.ok ? { kind: 'opened', pr: open } : refused('push-failed', pushed.reason);
      if (!pushed.ok) return refused('push-failed', pushed.reason);
      const made = await createPr(gh, wt.path, {
        branch: wt.branch,
        base: baseBranchName(base),
        title,
        body,
        draft: req.draft === true,
      });
      if ('failure' in made) return refused(ghCode(made.failure), made.detail);
      log.info('pull request opened for a worktree', { projectId: project.id, pr: made.pr.number });
      return { kind: 'opened', pr: made.pr };
    });
  }

  // ── merge into main locally (no remote only) ───────────────────────────────

  async mergeLocal(projectId: unknown, folder: unknown): Promise<LocalMergeOutcome> {
    return this.exclusive(projectId, folder, async (at): Promise<LocalMergeOutcome> => {
      const { git } = this.deps;
      const { project, repo, wt, all } = at;
      if (wt.primary) return refused('is-primary');
      if (!wt.branch) return refused('detached');
      // decision 1: a PR is the merge. Only a repo with nowhere to push merges here.
      const remotes = await git.remoteNames(repo);
      if (remotes === null) return refused('git-failed', 'git could not list the remotes');
      if (remotes.length > 0) return refused('has-remote');
      const base = await this.baseOf(project, repo, true);
      if (!base) return refused('no-base');
      const target = baseBranchName(base);
      const primary = all.find((w) => w.primary && !w.bare);
      if (!primary || primary.branch !== target) return refused('primary-not-on-base', target);
      // the merge happens in the PRIMARY checkout: hold it too, so a second
      // local merge (from another worktree) cannot race on its index
      const primaryKey = pathKey(primary.path);
      if (this.busy.has(primaryKey)) return refused('busy');
      this.busy.add(primaryKey);
      try {
        return await this.mergeInto(project, wt, primary, target);
      } finally {
        this.busy.delete(primaryKey);
      }
    });
  }

  /** The local merge itself, with the primary checkout held (see `mergeLocal`). */
  private async mergeInto(
    project: ProjectRecord,
    wt: WorktreeInfo,
    primary: WorktreeInfo,
    target: string
  ): Promise<LocalMergeOutcome> {
    const { git, log } = this.deps;
    if (!wt.branch) return refused('detached');
    const dirtyHere = await this.dirtyFiles(wt.path);
    if (dirtyHere === null || dirtyHere.length > 0) return refused('dirty', undefined, dirtyHere ?? []);
    const dirtyThere = await this.dirtyFiles(primary.path);
    if (dirtyThere === null || dirtyThere.length > 0) return refused('primary-dirty', undefined, dirtyThere ?? []);
    const m = await git.mergeRef(primary.path, wt.branch, { noFf: true });
    if (m.ok) {
      log.info('worktree merged into its base locally', { projectId: project.id });
      return { kind: 'merged', base: target };
    }
    // the primary checkout is never left mid-merge: abort, and say which files
    if (await git.mergeInProgress(primary.path)) {
      const files = (await git.unmergedFiles(primary.path)) ?? [];
      const a = await git.mergeAbort(primary.path);
      if (!a.ok)
        return refused('git-failed', `the merge stopped on conflicts and could not be aborted: ${a.reason ?? ''}`, files);
      return refused('conflicts', undefined, files);
    }
    return refused('git-failed', m.reason);
  }

  // ── remove ─────────────────────────────────────────────────────────────────

  async removeCheck(projectId: unknown, folder: unknown): Promise<RemoveCheck | null> {
    const at = await this.locate(projectId, folder);
    if ('code' in at || at.wt.primary) return null;
    const { project, repo, wt } = at;
    const exists = await isDirectory(wt.path);
    const base = await this.baseOf(project, repo);
    const [dirty, merged, links] = await Promise.all([
      exists ? this.dirtyFiles(wt.path) : Promise.resolve([] as string[]),
      this.mergedState(repo, wt, base),
      exists ? this.linksIn(project, wt.path) : Promise.resolve([] as string[]),
    ]);
    return {
      path: wt.path,
      branch: wt.branch,
      dirty,
      unmerged: merged.unmerged,
      mergedPr: merged.mergedPr,
      links,
      base: base ? baseBranchName(base) : null,
    };
  }

  async remove(req: RemoveRequest): Promise<RemoveOutcome> {
    if (!req || typeof req !== 'object') return refused('bad-request');
    return this.exclusive(req.projectId, req.path, async (at): Promise<RemoveOutcome> => {
      const { git, log } = this.deps;
      const { project, repo, wt } = at;
      if (wt.primary) return refused('is-primary');
      const exists = await isDirectory(wt.path);
      if (exists) {
        // a DIFFERENT checkout at that path now (re-made by hand, another repo):
        // git's own answer for the folder must still be this worktree of this repo
        const [top, common] = await Promise.all([git.root(wt.path), git.commonDir(wt.path)]);
        if (
          !top ||
          !common ||
          pathKey(path.normalize(top)) !== pathKey(wt.path) ||
          pathKey(common) !== pathKey(project.commonDir)
        ) {
          return refused('other-checkout');
        }
        const dirty = await this.dirtyFiles(wt.path);
        if (dirty === null && !req.force) return refused('git-failed', 'git could not read what is changed in that folder');
        if (dirty && dirty.length > 0 && !req.force) return refused('dirty', undefined, dirty);
      }
      // the window asks this first, before it closes any session (#1638 review)
      if (req.dryRun === true) return { kind: 'ready' as const };
      const base = await this.baseOf(project, repo);
      const { unmerged } = await this.mergedState(repo, wt, base, false);
      // unlink first, then git, then a plain check that nothing is left
      if (exists) {
        const shared = (project.sharedDirs ?? []).filter((r) => typeof r === 'string');
        const why = await removeWorktreeFolder(wt.path, shared, async (dir) => {
          const r = await git.worktreeRemove(repo, dir, req.force === true);
          if (!r.ok) throw new Error(r.reason ?? 'git could not remove the worktree');
        }).catch((e: unknown) => errorText(e));
        if (why) {
          log.warn('worktree removal stopped', { projectId: project.id, reason: why });
          if (why.startsWith('a linked folder')) return refused('link-left', why);
          // git refused AFTER the links were taken out: put the shared folders back
          const relinked = await relink(project, wt.path);
          return refused('git-failed', relinked ? `${why} (${relinked})` : why);
        }
      }
      // re-check git's records: an entry for a folder that is gone is pruned
      let after = await git.worktreeList(repo);
      if (after?.some((w) => pathKey(w.path) === pathKey(wt.path))) {
        await git.worktreePrune(repo);
        after = await git.worktreeList(repo);
      }
      const stillListed = !!after?.some((w) => pathKey(w.path) === pathKey(wt.path));
      this.forgetAll(project.id, wt.path, req.path);
      let branchDeleted = false;
      let detail: string | undefined;
      if (wt.branch && req.keepBranch === false) {
        const d = unmerged === 0 ? await git.deleteMergedBranch(repo, wt.branch) : await git.deleteBranch(repo, wt.branch);
        branchDeleted = d.ok;
        if (!d.ok) detail = d.reason;
      }
      if (stillListed) detail = detail ?? 'git still lists the worktree';
      log.info('worktree removed', { projectId: project.id, branchDeleted, forced: req.force === true });
      return {
        kind: 'removed',
        branchDeleted,
        ...(wt.branch && !branchDeleted ? { branchKept: wt.branch } : {}),
        ...(detail ? { detail: detail.slice(0, 400) } : {}),
      };
    });
  }

  /**
   * A worktree removed OUTSIDE the app (#1638).
   *
   * - git marks it **prunable** (its folder is gone): its section leaves the
   *   card, but its records are KEPT, because a folder on an unplugged drive is
   *   prunable too and comes back (#1638 review).
   * - git **no longer lists it at all** (`git worktree remove` or `prune` in a
   *   terminal): its app records go as well.
   *
   * `before` is the project as it was BEFORE the list was read: a build that
   * records its worktree while git is being asked is not in it, so it can
   * never be forgotten by a list that was read a moment too early. git's own
   * record is left for git (`prune` is its housekeeping, not ours).
   */
  noticeGone(projectId: string, list: WorktreeInfo[], before?: ProjectRecord): WorktreeInfo[] {
    const project = this.find(projectId);
    if (!project) return list;
    const listed = new Set(list.map((w) => pathKey(w.path)));
    const snap = before ?? project;
    const recorded = [...(snap.made ?? []), ...Object.keys(snap.purposes ?? {})];
    const gone = [...new Set(recorded.map(pathKey))].filter((k) => !listed.has(k));
    if (gone.length > 0) {
      let next = project;
      for (const k of new Set(gone)) next = forgetWorktree(next, k);
      if (JSON.stringify(next) !== JSON.stringify(project)) {
        this.deps.store.upsertProject(next);
        this.deps.log.info('worktree gone outside the app: its records dropped', { projectId, count: gone.length });
      }
    }
    return list.filter((w) => !w.prunable || w.primary);
  }

  // ── shared ─────────────────────────────────────────────────────────────────

  private find(id: unknown): ProjectRecord | undefined {
    return typeof id === 'string' ? this.deps.store.listProjects().find((p) => p.id === id) : undefined;
  }

  private async locate(projectId: unknown, folder: unknown): Promise<Located | { code: FinishRefusal }> {
    const project = this.find(projectId);
    if (!project || !isAbsoluteLocal(folder)) return { code: 'no-worktree' };
    const repo = await repoFolder(project);
    const all = await this.deps.git.worktreeList(repo);
    const wt = all?.find((w) => !w.bare && pathKey(w.path) === pathKey(folder));
    if (!all || !wt) return { code: 'no-worktree' };
    return { project, repo, wt, all };
  }

  /** One action per worktree at a time; refusals and throws come back as values. */
  private async exclusive<T extends { kind: string }>(
    projectId: unknown,
    folder: unknown,
    fn: (at: Located) => Promise<T>
  ): Promise<T | ReturnType<typeof refused>> {
    const at = await this.locate(projectId, folder);
    if ('code' in at) {
      this.deps.log.warn('worktree action refused: not a worktree of that project');
      return refused(at.code);
    }
    const key = pathKey(at.wt.path);
    if (this.busy.has(key)) return refused('busy');
    this.busy.add(key);
    try {
      return await fn(at);
    } catch (e) {
      this.deps.log.warn('worktree action failed', { error: errorText(e) });
      return refused('git-failed', errorText(e));
    } finally {
      this.busy.delete(key);
    }
  }

  /** The base a project's worktrees are compared with and updated from. */
  private async baseOf(project: ProjectRecord, repo: string, fresh = false): Promise<string | null> {
    if (project.baseRef) return project.baseRef;
    const hit = this.bases.get(project.id);
    if (!fresh && hit && Date.now() - hit.at < BASE_TTL_MS) return hit.base;
    const b = await this.deps.git.branches(repo, STATS_BUDGET_MS);
    const base = b?.defaultBase ?? null;
    this.bases.set(project.id, { base, at: Date.now() });
    return base;
  }

  private async dirtyFiles(folder: string): Promise<string[] | null> {
    const st = await this.deps.git.status(folder).catch(() => null);
    if (!st || st.unreadable) return null;
    return st.files.map((f) => f.path).slice(0, FILES_MAX);
  }

  /**
   * Commits on the branch that the base lacks, and whether a merged PR exists
   * for it (a squash merge leaves the commits "not on main" for ever, so the
   * count alone would keep every merged branch).
   */
  private async mergedState(
    repo: string,
    wt: WorktreeInfo,
    base: string | null,
    askGh = true
  ): Promise<{ unmerged: number | null; mergedPr: boolean | null }> {
    if (!wt.branch || !base) return { unmerged: null, mergedPr: null };
    const unmerged = await this.deps.git.countNotOn(repo, wt.branch, base);
    if (!askGh) return { unmerged, mergedPr: null };
    const remotes = (await this.deps.git.remoteNames(repo)) ?? [];
    if (remotes.length === 0) return { unmerged, mergedPr: false };
    const cwd = (await isDirectory(wt.path)) ? wt.path : repo;
    const found = await prsForBranch(this.deps.gh, cwd, wt.branch);
    if ('failure' in found) return { unmerged, mergedPr: null };
    // Only a merged PR whose head IS the branch's tip (#1638 review): a branch
    // name reused after its PR merged, or commits added after the squash, are
    // work no PR carried, and must not default to being deleted.
    const tip = await this.deps.git.revParse(repo, wt.branch);
    return { unmerged, mergedPr: !!tip && found.prs.some((p) => p.state === 'MERGED' && p.headSha === tip) };
  }

  /** The links that will be unlinked first: the project's shares, and any other near the top. */
  private async linksIn(project: ProjectRecord, folder: string): Promise<string[]> {
    const out: string[] = [];
    for (const rel of project.sharedDirs ?? []) if (await isLink(path.join(folder, rel))) out.push(rel);
    for (const rel of await findLinks(folder, 3)) if (!out.includes(rel)) out.push(rel);
    return out;
  }

  private forgetAll(projectId: string, ...keys: unknown[]): void {
    let p = this.find(projectId);
    if (!p) return;
    for (const k of keys) if (typeof k === 'string') p = forgetWorktree(p, k);
    this.deps.store.upsertProject(p);
  }
}

/**
 * Put the project's shared folders back into a worktree whose removal git
 * refused after they had been unlinked. Says which ones could not be.
 */
async function relink(project: ProjectRecord, folder: string): Promise<string | null> {
  const missed: string[] = [];
  for (const rel of project.sharedDirs ?? []) {
    const from = path.join(project.primaryPath, rel);
    const to = path.join(folder, rel);
    try {
      if (!(await isDirectory(from)) || (await isLink(to)) || fs.existsSync(to)) continue;
      await linkDir(from, to);
    } catch {
      missed.push(rel);
    }
  }
  return missed.length > 0 ? `not linked back: ${missed.join(', ')}` : null;
}

/** Where a project's git runs from: its primary checkout, else its common dir. */
async function repoFolder(project: ProjectRecord): Promise<string> {
  return (await isDirectory(project.primaryPath)) ? project.primaryPath : project.commonDir;
}

