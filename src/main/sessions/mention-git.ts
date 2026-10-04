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
  const inFlight = new Map<string, Promise<BriefGitFacts | undefined>>();
  const read = (folder: string): Promise<BriefGitFacts | undefined> => {
    const running = inFlight.get(folder);
    if (running) return running;
    const started = Promise.resolve()
      .then(() => status(folder))
      .then(gitFactsFrom, () => undefined)
      .finally(() => inFlight.delete(folder));
    inFlight.set(folder, started);
    return started;
  };
  return {
    async lookup(folders) {
      const out = new Map<string, BriefGitFacts>();
      await Promise.all(
        [...new Set(folders)].map(async (folder) => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const late = new Promise<undefined>((resolve) => {
            timer = setTimeout(() => resolve(undefined), budgetMs);
          });
          const facts = await Promise.race([read(folder), late]);
          clearTimeout(timer);
          if (facts) out.set(folder, facts);
        })
      );
      return out;
    },
  };
}
