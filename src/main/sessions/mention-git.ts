// Which branch a mentioned session's folder is on (#1092).
//
// A brief states it as a FACT, so it is asked of git rather than read out of
// the conversation — and asking git is not instant, while the user has already
// pressed Enter. This is the part that decides how long a send may wait and
// what is said when the answer does not come.
//
// Here, and not inline in `main/index.ts`, because that file has no tests and
// every rule below is one a test should hold: the budget, the detached HEAD,
// the folder git could not read, and one lookup per folder however many sends
// are waiting on it.
import type { BriefGitFacts } from './mention-brief';

/** How long a send waits to learn a mentioned folder's branch. */
export const MENTION_GIT_BUDGET_MS = 1_500;

/** The part of `GitService.status`'s answer this reads. */
export interface GitStatusLike {
  isRepo: boolean;
  /** set when git ran and could not read the repository — then nothing else is true */
  unreadable?: unknown;
  branch?: string;
  files: ReadonlyArray<{ untracked: boolean }>;
}

/** Porcelain v2's `# branch.head` for a checkout that is on no branch. */
const DETACHED = '(detached)';

/**
 * What a status says about a checkout, or undefined when it says nothing we
 * may repeat — not a repository, or one git could not read.
 */
export function gitFactsFrom(status: GitStatusLike | undefined): BriefGitFacts | undefined {
  if (!status || !status.isRepo || status.unreadable) return undefined;
  const untracked = status.files.filter((f) => f.untracked).length;
  return {
    // `(detached)` is git's own placeholder, not a branch name — printing "on
    // branch `(detached)`" would be the app stating something false.
    ...(status.branch && status.branch !== DETACHED ? { branch: status.branch } : {}),
    changed: status.files.length - untracked,
    untracked,
  };
}

export interface MentionGitLookup {
  /** the facts for each folder that answered in time; a folder that did not is absent */
  lookup(folders: readonly string[]): Promise<Map<string, BriefGitFacts>>;
}

export interface MentionTreeLookup {
  /** each folder's working-tree root; a folder with none, or that did not answer in time, is absent */
  lookup(folders: readonly string[]): Promise<Map<string, string>>;
}

/**
 * Look folders up under a budget, sharing one read between concurrent askers.
 *
 * THE BUDGET BOUNDS THE WAIT, NOT THE GIT PROCESS — `status` runs to completion
 * either way. So a slow repository must not be asked again by every send that
 * arrives while it is still answering: the in-flight read is shared, and a
 * second send waits on the same one rather than starting another beside it.
 *
 * Never rejects. Unknown is not printed, and a send is never refused or held
 * up past the budget because git was slow, absent or broken.
 */
export function createMentionGitLookup(
  status: (folder: string) => Promise<GitStatusLike>,
  budgetMs: number = MENTION_GIT_BUDGET_MS
): MentionGitLookup {
  return budgeted(async (folder) => gitFactsFrom(await status(folder)), budgetMs);
}

/**
 * Which working tree each folder is in (#1098) — the same rules as the lookup
 * above, for the same reasons, about a different fact.
 *
 * The brief's loudest line is "it shares your working tree", and two folders
 * share one exactly when git gives them the same toplevel. `root` answers
 * `null` for a folder that is not in a repository, and that folder is absent
 * from the answer like one that was too slow: unknown is not compared.
 */
export function createMentionTreeLookup(
  root: (folder: string) => Promise<string | null>,
  budgetMs: number = MENTION_GIT_BUDGET_MS
): MentionTreeLookup {
  return budgeted(async (folder) => (await root(folder)) || undefined, budgetMs);
}

/** One read per folder, shared while in flight, and never waited on past the budget. */
function budgeted<T>(
  ask: (folder: string) => Promise<T | undefined>,
  budgetMs: number
): { lookup(folders: readonly string[]): Promise<Map<string, T>> } {
  const inFlight = new Map<string, Promise<T | undefined>>();
  const read = (folder: string): Promise<T | undefined> => {
    const running = inFlight.get(folder);
    if (running) return running;
    const started = Promise.resolve()
      .then(() => ask(folder))
      .catch(() => undefined)
      .finally(() => inFlight.delete(folder));
    inFlight.set(folder, started);
    return started;
  };
  return {
    async lookup(folders) {
      const out = new Map<string, T>();
      await Promise.all(
        [...new Set(folders)].map(async (folder) => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const late = new Promise<undefined>((resolve) => {
            timer = setTimeout(() => resolve(undefined), budgetMs);
          });
          const answer = await Promise.race([read(folder), late]);
          clearTimeout(timer);
          if (answer !== undefined) out.set(folder, answer);
        })
      );
      return out;
    },
  };
}
