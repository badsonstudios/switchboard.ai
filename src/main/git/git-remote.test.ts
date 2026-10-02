// Branch and sync, as rules (E24 Git v2 item 15).
//
// ⚠️ **THE BRANCH-NAME RULE IS THE SHARP PART, and it is about ARGV rather than
// about git.** A name reaching a command line must not be able to become a FLAG,
// and the finding behind that is recorded in `git-log.ts`: a character class
// alone accepted `--all`, because `-` has to be IN the class for an ordinary
// branch name like `feature/e24-git-v2`. A test written for the injection is what
// caught it there, and this is the same test for this rule.
import { describe, it, expect } from 'vitest';
import {
  NETWORK_BUDGET_MS,
  checkoutArgs,
  createBranchArgs,
  fetchArgs,
  isBranchName,
  networkEnv,
  pullArgs,
  pushArgs,
  refusedBranch,
} from './git-remote';

describe('which branch names are allowed', () => {
  it('takes the names a real project uses (the done-when)', () => {
    for (const good of [
      'main',
      'feature/1052-branch-sync',
      'release-0.8.x',
      'dependabot/npm_and_yarn/vite-5.0.0',
      'a.b.c',
      'JIRA-123_fix',
    ]) {
      expect(isBranchName(good), `${good} was refused`).toBe(true);
    }
  });

  it('⚠️ REFUSES A LEADING DASH, which is the injection', () => {
    // `-` must be IN the character class, because `feature/e24-git-v2` is an
    // ordinary name — so the class alone accepts `--all`, `--force` and
    // `-D`. The position rule is a separate fact from the character rule.
    for (const bad of ['-f', '--all', '--force', '-D', '--set-upstream']) {
      expect(isBranchName(bad), `${bad} was accepted`).toBe(false);
    }
  });

  it('⚠️ REFUSES `..`, which would turn one ref into a RANGE', () => {
    expect(isBranchName('main..side')).toBe(false);
    expect(isBranchName('a..b')).toBe(false);
    // …while a single dot is an ordinary part of a name
    expect(isBranchName('release-0.8.1')).toBe(true);
  });

  it('refuses the shapes git itself will not take', () => {
    for (const bad of ['trailing/', 'trailing.', 'thing.lock', '/leading', 'double//slash']) {
      expect(isBranchName(bad), `${bad} was accepted`).toBe(false);
    }
  });

  it('refuses anything that is not a non-empty, reasonable string', () => {
    for (const bad of ['', ' ', 'has space', 'tilde~1', 'caret^', 'colon:x', 'star*', undefined, null, 42, {}]) {
      expect(isBranchName(bad), `${JSON.stringify(bad)} was accepted`).toBe(false);
    }
    // and a name long enough to be an attack rather than a name
    expect(isBranchName('a'.repeat(300))).toBe(false);
  });

  it('the refusal says what IS allowed, rather than only that something was not', () => {
    const r = refusedBranch();
    expect(r.ok).toBe(false);
    expect(r.applied).toBe(0);
    expect(r.reason).toContain('letters, digits');
  });
});

describe('the commands', () => {
  it('⚠️ FETCH PRUNES, so a deleted remote branch stops appearing in the graph', () => {
    // Without it the History tab's ref chips accumulate names nobody can push
    // to, which is a confidently wrong answer about where a branch is.
    expect(fetchArgs()).toEqual(['fetch', '--prune']);
  });

  it('⚠️ PULL IS `--ff-only`, AND THAT IS THE WHOLE DESIGN OF THE BUTTON', () => {
    // A plain `pull` either merges or rebases depending on the user's config, and
    // both can stop halfway with a conflict — leaving a one-click "Pull" having
    // started a merge the user now has to finish, with no surface for it. With
    // `--ff-only` the button either works completely or changes nothing, and git
    // says which.
    expect(pullArgs()).toEqual(['pull', '--ff-only']);
  });

  it('push sets an upstream only when asked', () => {
    expect(pushArgs()).toEqual(['push']);
    expect(pushArgs({ setUpstream: true })).toEqual(['push', '--set-upstream', 'origin', 'HEAD']);
  });

  it('⚠️ AND NEVER FORCE-PUSHES, not even behind a menu', () => {
    // A force-push can destroy commits on the remote that exist nowhere else,
    // which is past the line this epic draws at discard — and unlike discard
    // there is no confirm that makes it safe, because what is at risk may be
    // somebody else's work.
    for (const args of [pushArgs(), pushArgs({ setUpstream: true })]) {
      expect(args).not.toContain('--force');
      expect(args).not.toContain('-f');
      expect(args).not.toContain('--force-with-lease');
    }
  });

  it('⚠️ CHECKOUT ENDS WITH `--`, so a branch name can never be read as a pathspec', () => {
    // The one way `checkout` can quietly do something entirely different from
    // what was asked: `git checkout somefile` restores that file instead of
    // switching branch.
    expect(checkoutArgs('main')).toEqual(['checkout', 'main', '--']);
  });

  it('creates a branch at HEAD, or at a commit the graph pointed at', () => {
    expect(createBranchArgs('side')).toEqual(['checkout', '-b', 'side', '--']);
    expect(createBranchArgs('side', 'abc1234')).toEqual([
      'checkout',
      '-b',
      'side',
      'abc1234',
      '--',
    ]);
  });
});

describe('the environment a network command runs in', () => {
  it('⚠️ DISABLES THE TERMINAL PROMPT, because the failure mode is a HANG not an error', () => {
    // `git fetch` against a remote that wants credentials will wait for a
    // password on a terminal that does not exist, for ever — and our budget would
    // then kill it and report a timeout, which reads as "the network is slow".
    // Measured: with this set, an unreachable host fails in under a second.
    expect(networkEnv({}).GIT_TERMINAL_PROMPT).toBe('0');
  });

  it('⚠️ AND TOUCHES NOTHING ELSE — the user’s credential helper must keep working', () => {
    // Host-don't-reimplement: we stop git asking a terminal we do not have, and
    // we do not touch how the user has arranged to be authenticated. Windows
    // Credential Manager, the macOS keychain and a `gh` helper all go on working.
    const env = networkEnv({ PATH: '/usr/bin', GIT_ASKPASS: 'mine' });
    expect(env.PATH).toBe('/usr/bin');
    expect(env.GIT_ASKPASS).toBe('mine');
    expect(Object.keys(networkEnv({})).sort()).toEqual(['GIT_TERMINAL_PROMPT']);
  });

  it('the network budget is far longer than a local write, because the bound is somebody else', () => {
    expect(NETWORK_BUDGET_MS).toBeGreaterThan(60_000);
  });
});
