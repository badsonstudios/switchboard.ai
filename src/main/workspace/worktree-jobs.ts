// Building a worktree in the background (E42 step 2, #1506; mockup screen C).
//
// The new-worktree dialog closes at once; this does the work and pushes every
// step to the window, which draws it on the project's card:
//
//   creating  `git worktree add` in one app-managed folder OUTSIDE the repo
//   copying   the project's "copy" files from the primary checkout
//   linking   the project's "share" folders, as links (git-ignored only)
//   setup     the project's setup command, in the new folder
//   ready     the window claims the job and starts the session there
//
// Fail-open throughout (P6): a copy or share entry that cannot be done is a
// warning and the build carries on; a failed `git worktree add` leaves nothing
// behind; a failed setup command keeps the worktree and asks (start anyway,
// keep it, or discard it). Nothing here touches a running session.
//
// Never silent (decision 6): a job only exists because a person pressed
// "Create & start" in the dialog.
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  branchSlug,
  cleanRelative,
  isInside,
  isInsideRelative,
  pathKey,
  type NewWorktreeRequest,
  type ProjectRecord,
  type WorktreeJob,
  type WorktreeWarning,
} from '../../shared/projects';
import { MAX_SESSION_TITLE } from '../../shared/sessions';
import type { GitWriteResult } from '../git/git-write';
import { errorText } from '../../shared/error-text';
import { isRev } from '../git/git-log';
import { isBranchName } from '../git/git-remote';
import { isAbsoluteLocal } from '../git/worktree-git';
import { killTree } from '../transport/kill-tree';
import type { Logger } from '../log/logger';
import { linkDir, removeWorktreeFolder } from './worktree-links';

/** The folder under the home directory that worktrees go in by default. */
export const WORKTREE_ROOT_NAME = 'switchboard-worktrees';

/**
 * The app-wide default: `~/switchboard-worktrees`. Home rather than the app's
 * data folder because that is `AppData\Roaming` on Windows (roamed, hidden, and
 * a long path for a `node_modules` to sit under), and a person opens these
 * folders in an editor. Each repo gets its own folder under it.
 */
export function defaultWorktreeRoot(home = os.homedir()): string {
  return path.join(home, WORKTREE_ROOT_NAME);
}

/** Builds (and finished-but-unclaimed jobs) held at once. */
const MAX_JOBS = 16;

/** A setup command gets this long before it is stopped. */
export const SETUP_TIMEOUT_MS = 30 * 60_000;
/** How much of the setup command's output is kept to say why it failed. */
const SETUP_TAIL = 4_000;

export interface WorktreeJobGit {
  worktreeAdd(
    repo: string,
    opts: { target: string; branch: unknown; newBranch: boolean; base?: unknown }
  ): Promise<GitWriteResult>;
  worktreeRemoveForce(repo: string, target: string): Promise<GitWriteResult>;
  deleteBranch(repo: string, branch: unknown): Promise<GitWriteResult>;
  revParse(folder: string, rev: unknown): Promise<string | null>;
  isIgnored(folder: string, rel: string): Promise<boolean | null>;
  /** git's own spelling of a checkout's folder */
  root(folder: string): Promise<string | null>;
}

export interface WorktreeJobStore {
  listProjects(): ProjectRecord[];
  upsertProject(p: ProjectRecord): boolean;
}

export type SetupRunner = (
  command: string,
  cwd: string,
  onLine: (line: string) => void
) => Promise<{ ok: boolean; detail: string }>;

export interface WorktreeJobDeps {
  git: WorktreeJobGit;
  store: WorktreeJobStore;
  /** the app-wide folder (Settings), or the default when unset */
  root: () => string;
  log: Logger;
  emit: (job: WorktreeJob) => void;
  runSetup?: SetupRunner;
}

/** What main keeps about a job beyond what the window sees. */
interface JobState {
  job: WorktreeJob;
  repo: string;
  primary: string;
  newBranch: boolean;
  /** the commit a new branch was made at: it is deleted on discard only if still there */
  madeAt: string | null;
  /** the `made` key recorded for it (git's spelling of the folder) */
  madeKey: string | null;
  links: string[];
  sharedDirs: string[];
}


function folderName(p: string): string {
  return p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || 'repo';
}

/** A copy the caller can keep: main goes on changing the job it holds. */
function snapshot(j: WorktreeJob): WorktreeJob {
  return { ...j, warnings: j.warnings.map((w) => ({ ...w })) };
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.promises.lstat(p);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Where to reopen a conversation whose folder is gone (#1643): the main folder
 * of the project that folder belonged to, or undefined.
 *
 * "Belonged to" is a folder test, because the worktree's own records went with
 * it: the gone folder sat inside the project's main checkout (the CLI's own
 * `.claude/worktrees/<name>`), or inside the folder this app makes the
 * project's worktrees in (`worktreeRootFor`). Only a main folder that is still
 * a directory is offered. The deepest match wins, like `worktreeFor`.
 */
export function reopenFolderIn(
  gone: string,
  projects: readonly ProjectRecord[],
  appRoot: string,
  isDirectory: (p: string) => boolean = (p) => {
    try {
      return fs.statSync(p).isDirectory();
    } catch {
      return false;
    }
  }
): string | undefined {
  let best: { path: string; depth: number; tied: boolean } | undefined;
  for (const p of projects) {
    const roots = [p.primaryPath, worktreeRootFor(p, appRoot)].filter((r): r is string => !!r);
    for (const r of roots) {
      if (!isInside(gone, r) || pathKey(gone) === pathKey(r)) continue;
      const depth = pathKey(r).length;
      if (!best || depth > best.depth) best = { path: p.primaryPath, depth, tied: false };
      // two projects claiming it equally (repos with the same folder name
      // share an app worktree root): no guess, the user picks
      else if (depth === best.depth && pathKey(best.path) !== pathKey(p.primaryPath)) best.tied = true;
    }
  }
  return best && !best.tied && isDirectory(best.path) ? best.path : undefined;
}

/**
 * The folder a project's worktrees go in: `<root>/<repo folder name>`, or null
 * when that is unusable.
 *
 * Decision 2: OUTSIDE the repo, so a worktree never shows up as untracked
 * files in the primary checkout (which the CLI's own flag does). Two ways in
 * are closed (#1506 review): a root inside the repo, and a root that is the
 * folder HOLDING the repo (pick `C:\Projects` for `C:\Projects\app` and the
 * repo-named folder under it would be the repo itself). The second takes
 * `<repo>.worktrees` instead. Resolved first, so a `..` cannot walk around it.
 */
export function worktreeRootFor(project: ProjectRecord, appRoot: string): string | null {
  const raw = project.worktreeRoot ?? appRoot;
  if (!isAbsoluteLocal(raw)) return null;
  const root = path.resolve(raw);
  const primary = path.resolve(project.primaryPath);
  if (isInside(root, primary)) return null;
  const name = folderName(primary);
  let parent = path.join(root, name);
  if (isInside(parent, primary) || isInside(primary, parent)) parent = path.join(root, `${name}.worktrees`);
  if (isInside(parent, primary) || isInside(primary, parent)) return null;
  return parent;
}

export class WorktreeJobs {
  private readonly jobs = new Map<string, JobState>();
  /** folders chosen by a start that has not registered its job yet */
  private readonly reserved = new Set<string>();
  private readonly runSetup: SetupRunner;

  constructor(private readonly deps: WorktreeJobDeps) {
    this.runSetup = deps.runSetup ?? runSetupCommand;
  }

  list(): WorktreeJob[] {
    return [...this.jobs.values()].map((s) => snapshot(s.job));
  }

  /** Start a build. null (with a log line) when the request cannot be honoured. */
  async start(req: NewWorktreeRequest): Promise<WorktreeJob | null> {
    const { log } = this.deps;
    const project = this.deps.store.listProjects().find((p) => p.id === req?.projectId);
    if (!project) return this.refuse('no such project');
    // each build may run a setup command: a bound on how many at once
    if (this.jobs.size >= MAX_JOBS) return this.refuse('too many worktree builds at once');
    if (!isBranchName(req.branch)) return this.refuse('not a usable branch name');
    if (req.newBranch && req.base !== undefined && !isRev(req.base)) return this.refuse('not a usable base');
    const parent = worktreeRootFor(project, this.deps.root());
    if (!parent) return this.refuse('the worktree folder is not a local folder outside the repo');
    // an existing folder is never reused: the next free name beside it
    const slug = branchSlug(req.branch);
    let target = path.join(parent, slug);
    for (let n = 2; ; n++) {
      // checked again AFTER the await and claimed in the same tick, so two
      // builds started at once can never pick the same folder
      const free = !this.busyPath(target) && !(await exists(target)) && !this.busyPath(target);
      if (free) break;
      if (n > 99) return this.refuse('no free folder name for that branch');
      target = path.join(parent, `${slug}-${n}`);
    }
    this.reserved.add(pathKey(target));
    const title =
      (typeof req.title === 'string' ? req.title.trim().slice(0, MAX_SESSION_TITLE) : '') || req.branch;
    const primary = project.primaryPath;
    const repo = (await isDirectory(primary)) ? primary : project.commonDir;
    const state: JobState = {
      job: {
        id: randomUUID(),
        projectId: project.id,
        branch: req.branch,
        path: target,
        title,
        phase: 'creating',
        warnings: [],
      },
      repo,
      primary,
      newBranch: req.newBranch,
      madeAt: null,
      madeKey: null,
      links: [],
      sharedDirs: (project.sharedDirs ?? []).filter(isInsideRelative).map(cleanRelative),
    };
    this.jobs.set(state.job.id, state);
    this.reserved.delete(pathKey(target));
    this.push(state);
    log.info('worktree build started', { projectId: project.id, jobId: state.job.id, newBranch: req.newBranch });
    void this.build(state, project, req).catch((e) => {
      // every step catches its own; this is the backstop that keeps a bug from
      // leaving a card spinning for ever
      this.fail(state, errorText(e));
    });
    return { ...state.job, warnings: [] };
  }

  /** The window starts the session: only once, and only when there is a folder to start in. */
  claim(id: string): WorktreeJob | null {
    const s = this.jobs.get(id);
    if (!s || (s.job.phase !== 'ready' && s.job.phase !== 'setup-failed')) return null;
    s.job.phase = 'done';
    this.push(s);
    this.jobs.delete(id);
    return snapshot(s.job);
  }

  /** Clear a failed job from the card. A failed setup keeps its worktree. */
  dismiss(id: string): boolean {
    const s = this.jobs.get(id);
    if (!s || (s.job.phase !== 'failed' && s.job.phase !== 'setup-failed')) return false;
    s.job.phase = 'done';
    this.push(s);
    this.jobs.delete(id);
    return true;
  }

  /**
   * Throw away a build whose setup failed: unlink shared folders FIRST (#916),
   * remove the worktree, and delete the branch only if it is new and still
   * where it was made (nothing committed on it).
   */
  async discard(id: string): Promise<boolean> {
    const s = this.jobs.get(id);
    if (!s || s.job.phase !== 'setup-failed') return false;
    const { git, log } = this.deps;
    // set in the same tick as the check: a "Start session anyway" or a second
    // discard while this one is deleting finds nothing to act on (#1506 review)
    this.phase(s, 'discarding');
    const why = await removeWorktreeFolder(s.job.path, [...new Set([...s.links, ...s.sharedDirs])], async (dir) => {
      const r = await git.worktreeRemoveForce(s.repo, dir);
      if (!r.ok) throw new Error(r.reason ?? 'git could not remove the worktree');
    }).catch((e: unknown) => errorText(e));
    if (why) {
      s.job.phase = 'setup-failed';
      s.job.detail = why;
      this.push(s);
      log.warn('worktree discard stopped', { jobId: id, reason: why });
      return false;
    }
    if (s.newBranch && s.madeAt) {
      const tip = await git.revParse(s.repo, s.job.branch);
      if (tip === s.madeAt) await git.deleteBranch(s.repo, s.job.branch);
    }
    if (s.madeKey) this.forget(s.job.projectId, s.madeKey);
    s.job.phase = 'done';
    this.push(s);
    this.jobs.delete(id);
    log.info('worktree discarded', { jobId: id });
    return true;
  }

  // ── the build ──────────────────────────────────────────────────────────────

  private async build(s: JobState, project: ProjectRecord, req: NewWorktreeRequest): Promise<void> {
    const { git, log } = this.deps;
    try {
      await fs.promises.mkdir(path.dirname(s.job.path), { recursive: true });
    } catch (e) {
      return this.fail(s, errorText(e));
    }
    const added = await git.worktreeAdd(s.repo, {
      target: s.job.path,
      branch: req.branch,
      newBranch: req.newBranch,
      ...(req.newBranch && req.base ? { base: req.base } : {}),
    });
    if (!added.ok) return this.fail(s, added.reason ?? 'git could not make the worktree');
    s.madeAt = await git.revParse(s.job.path, 'HEAD');
    // Recorded in GIT's spelling, because the card matches it against `git
    // worktree list`: on Windows our own path can be an 8.3 short name
    // (`RUNNER~1`) where git answers the long one, and the two would never
    // match (#1506, Windows CI). Our spelling only when git cannot say.
    const top = await git.root(s.job.path);
    s.madeKey = pathKey(top ? path.normalize(top) : s.job.path);
    // what it is for (#1638): the dialog's "What's it for?", which prefills the PR title
    const purpose = typeof req.title === 'string' ? req.title.trim().slice(0, 200) : '';
    this.remember(project.id, s.madeKey, purpose);

    // ── copy ──
    const copies = (project.copyFiles ?? []).filter(isInsideRelative).map(cleanRelative);
    if (copies.length > 0) {
      this.phase(s, 'copying');
      for (const rel of copies) await this.copyOne(s, rel);
    }

    // ── share ──
    if (s.sharedDirs.length > 0) {
      this.phase(s, 'linking');
      for (const rel of s.sharedDirs) await this.linkOne(s, rel);
    }

    // ── setup ──
    const command = project.setupCommand?.trim();
    if (req.runSetup && command) {
      this.phase(s, 'setup');
      let last = 0;
      const r = await this.runSetup(command, s.job.path, (line) => {
        // a chatty install prints thousands of lines: four updates a second
        const now = Date.now();
        if (now - last < 250) return;
        last = now;
        s.job.detail = line.slice(0, 200);
        this.push(s);
      });
      if (!r.ok) {
        s.job.phase = 'setup-failed';
        s.job.detail = r.detail.slice(0, 400);
        this.push(s);
        log.warn('worktree setup failed', { jobId: s.job.id });
        return;
      }
    }
    s.job.detail = undefined;
    this.phase(s, 'ready');
    log.info('worktree ready', { jobId: s.job.id, warnings: s.job.warnings.length });
  }

  private async copyOne(s: JobState, rel: string): Promise<void> {
    const from = path.join(s.primary, rel);
    const to = path.join(s.job.path, rel);
    try {
      if (!(await exists(from))) return this.warn(s, { code: 'copy-missing', entry: rel });
      // tracked files arrived with the checkout; never overwrite them
      if (await exists(to)) return;
      await fs.promises.mkdir(path.dirname(to), { recursive: true });
      await fs.promises.cp(from, to, { recursive: true, errorOnExist: false, force: false, verbatimSymlinks: true });
    } catch (e) {
      this.warn(s, { code: 'copy-failed', entry: rel, detail: errorText(e) });
    }
  }

  private async linkOne(s: JobState, rel: string): Promise<void> {
    const from = path.join(s.primary, rel);
    const to = path.join(s.job.path, rel);
    try {
      if (!(await isDirectory(from))) return this.warn(s, { code: 'share-missing', entry: rel });
      const ignored = await this.deps.git.isIgnored(s.primary, rel);
      if (ignored !== true) return this.warn(s, { code: 'share-not-ignored', entry: rel });
      if (await exists(to)) return this.warn(s, { code: 'share-exists', entry: rel });
      await linkDir(from, to);
      s.links.push(rel);
    } catch (e) {
      this.warn(s, { code: 'share-failed', entry: rel, detail: errorText(e) });
    }
  }

  // ── bookkeeping ────────────────────────────────────────────────────────────

  private busyPath(p: string): boolean {
    const k = pathKey(p);
    return this.reserved.has(k) || [...this.jobs.values()].some((s) => pathKey(s.job.path) === k);
  }

  private remember(projectId: string, key: string, purpose = ''): void {
    const p = this.deps.store.listProjects().find((x) => x.id === projectId);
    if (!p) return;
    this.deps.store.upsertProject({
      ...p,
      made: [...new Set([...(p.made ?? []), key])],
      ...(purpose ? { purposes: { ...(p.purposes ?? {}), [key]: purpose } } : {}),
    });
  }

  private forget(projectId: string, key: string): void {
    const p = this.deps.store.listProjects().find((x) => x.id === projectId);
    if (!p) return;
    this.deps.store.upsertProject(forgetWorktree(p, key));
  }

  private phase(s: JobState, phase: WorktreeJob['phase']): void {
    s.job.phase = phase;
    this.push(s);
  }

  private warn(s: JobState, w: WorktreeWarning): void {
    s.job.warnings.push(w.detail ? { ...w, detail: w.detail.slice(0, 200) } : w);
    this.deps.log.warn('worktree build: step skipped', { jobId: s.job.id, code: w.code, entry: w.entry });
    this.push(s);
  }

  private fail(s: JobState, detail: string): void {
    s.job.phase = 'failed';
    s.job.detail = detail.slice(0, 400);
    this.push(s);
    this.deps.log.warn('worktree build failed', { jobId: s.job.id, reason: s.job.detail });
  }

  private push(s: JobState): void {
    try {
      this.deps.emit(snapshot(s.job));
    } catch {
      /* no window to tell: the job list answers on the next read */
    }
  }

  private refuse(reason: string): null {
    this.deps.log.warn(`projects:createWorktree refused: ${reason}`);
    return null;
  }
}

/**
 * A project record with every app record of one worktree dropped: made,
 * hidden, and what it was for (#1638). Used when a worktree is discarded,
 * removed, or found gone.
 */
export function forgetWorktree(p: ProjectRecord, key: string): ProjectRecord {
  const k = pathKey(key);
  const next: ProjectRecord = {
    ...p,
    hiddenWorktrees: p.hiddenWorktrees.filter((h) => pathKey(h) !== k),
    made: (p.made ?? []).filter((m) => pathKey(m) !== k),
  };
  if (p.purposes) {
    const purposes = Object.fromEntries(Object.entries(p.purposes).filter(([pk]) => pathKey(pk) !== k));
    if (Object.keys(purposes).length > 0) next.purposes = purposes;
    else delete next.purposes;
  }
  if (next.made?.length === 0) delete next.made;
  return next;
}

/** The environment a setup command runs in: ours, minus the switch that makes Electron a plain Node. */
function setupEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

/**
 * Run the project's setup command in the new worktree, through the system
 * shell (it is a command line the user typed, like `npm ci && npm run build`).
 * Bounded by `SETUP_TIMEOUT_MS`; the tree is killed past it.
 */
export const runSetupCommand: SetupRunner = (command, cwd, onLine) =>
  new Promise((resolve) => {
    let tail = '';
    let settled = false;
    const finish = (ok: boolean, detail: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok, detail });
    };
    const lastLine = (): string =>
      tail
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l !== '')
        .slice(-3)
        .join(' · ');
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, { cwd, shell: true, windowsHide: true, env: setupEnv() });
    } catch (e) {
      resolve({ ok: false, detail: errorText(e) });
      return;
    }
    const timer = setTimeout(() => {
      killTree(child);
      finish(false, `setup did not finish within ${Math.round(SETUP_TIMEOUT_MS / 60_000)} minutes`);
    }, SETUP_TIMEOUT_MS);
    const take = (chunk: Buffer): void => {
      tail = (tail + chunk.toString('utf8')).slice(-SETUP_TAIL);
      const line = lastLine().split(' · ').pop();
      if (line) onLine(line);
    };
    child.stdout?.on('data', take);
    child.stderr?.on('data', take);
    child.on('error', (e) => finish(false, e.message));
    child.on('close', (code) =>
      finish(code === 0, code === 0 ? '' : `setup exited with code ${code}${lastLine() ? `: ${lastLine()}` : ''}`)
    );
  });
