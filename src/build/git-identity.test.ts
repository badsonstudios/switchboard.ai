import { describe, it, expect } from 'vitest';
import { GitRunner, describeIdentity, probeBuildIdentity } from './git-identity';

const NOW = new Date('2026-08-02T10:00:00.000Z');
const now = (): Date => NOW;

/** A fake git that answers from a table; anything unlisted throws, like the
 *  real one does when it cannot answer. */
function fakeGit(answers: Record<string, string>): GitRunner {
  return (args) => {
    const key = args.join(' ');
    if (!(key in answers)) throw new Error(`fake git: unexpected ${key}`);
    return answers[key];
  };
}

const CLEAN = {
  'rev-parse --short=8 HEAD': 'a1b2c3d4\n',
  'rev-parse --abbrev-ref HEAD': 'main\n',
  'status --porcelain': '',
};

describe('probeBuildIdentity (P2-E15-15)', () => {
  it('reads commit, branch and a clean tree', () => {
    expect(probeBuildIdentity({ run: fakeGit(CLEAN), now, env: {} })).toEqual({
      commit: 'a1b2c3d4',
      branch: 'main',
      dirty: false,
      builtAt: NOW.toISOString(),
    });
  });

  it('any porcelain output at all means dirty', () => {
    const id = probeBuildIdentity({
      run: fakeGit({ ...CLEAN, 'status --porcelain': ' M src/main/index.ts\n' }),
      now,
      env: {},
    });
    expect(id.dirty).toBe(true);
  });

  it('an untracked source file counts as dirty — the SHA no longer describes the build', () => {
    const id = probeBuildIdentity({
      run: fakeGit({ ...CLEAN, 'status --porcelain': '?? src/renderer/src/new-thing.tsx\n' }),
      now,
      env: {},
    });
    expect(id.dirty).toBe(true);
  });

  it('reports no branch on a locally detached checkout', () => {
    const id = probeBuildIdentity({
      run: fakeGit({ ...CLEAN, 'rev-parse --abbrev-ref HEAD': 'HEAD\n' }),
      now,
      env: {},
    });
    expect(id.branch).toBeNull();
    expect(id.commit).toBe('a1b2c3d4');
  });

  it("falls back to CI's branch name — actions/checkout leaves HEAD detached", () => {
    const detached = { ...CLEAN, 'rev-parse --abbrev-ref HEAD': 'HEAD\n' };
    expect(
      probeBuildIdentity({ run: fakeGit(detached), now, env: { GITHUB_REF_NAME: 'main' } }).branch
    ).toBe('main');
    // a pull_request build: HEAD_REF is the SOURCE branch, and wins
    expect(
      probeBuildIdentity({
        run: fakeGit(detached),
        now,
        env: { GITHUB_HEAD_REF: 'feature/172', GITHUB_REF_NAME: '172/merge' },
      }).branch
    ).toBe('feature/172');
  });

  it('an empty CI variable is not a branch name', () => {
    const id = probeBuildIdentity({
      run: fakeGit({ ...CLEAN, 'rev-parse --abbrev-ref HEAD': 'HEAD\n' }),
      now,
      env: { GITHUB_HEAD_REF: '', GITHUB_REF_NAME: '' },
    });
    expect(id.branch).toBeNull();
  });

  it('#300 — a push build reads GITHUB_REF_NAME past the empty GITHUB_HEAD_REF', () => {
    // The bug this pins: GitHub DEFINES GITHUB_HEAD_REF on every event and sets
    // it to '' when the event has no head ref (push, schedule, dispatch).
    // Under the old `??` chain '' won, and every build of main stamped itself
    // "detached" with the answer sitting in the next variable along.
    const detached = { ...CLEAN, 'rev-parse --abbrev-ref HEAD': 'HEAD\n' };
    expect(
      probeBuildIdentity({
        run: fakeGit(detached),
        now,
        env: { GITHUB_HEAD_REF: '', GITHUB_REF_NAME: 'main' },
      }).branch
    ).toBe('main');
    // a tag push: REF_NAME is the tag, and it is still better than "detached"
    expect(
      probeBuildIdentity({
        run: fakeGit(detached),
        now,
        env: { GITHUB_HEAD_REF: '', GITHUB_REF_NAME: 'v0.1.0' },
      }).branch
    ).toBe('v0.1.0');
  });

  it('fails OPEN when git is missing entirely — the build must still succeed', () => {
    const id = probeBuildIdentity({
      run: () => {
        throw new Error('ENOENT: git');
      },
      now,
      env: {},
    });
    // build time survives: it is real regardless of git, and it is the single
    // most useful field for spotting a stale out/ directory
    expect(id).toEqual({ commit: null, branch: null, dirty: false, builtAt: NOW.toISOString() });
  });

  it('stops asking once there is no commit — a non-repo has nothing else to say', () => {
    const asked: string[][] = [];
    probeBuildIdentity({
      run: (args) => {
        asked.push(args);
        throw new Error('not a git repository');
      },
      now,
      env: {},
    });
    expect(asked).toHaveLength(1);
  });
});

describe('describeIdentity', () => {
  it('summarises a normal build for the build log', () => {
    expect(
      describeIdentity({
        commit: 'a1b2c3d4',
        branch: 'main',
        dirty: false,
        builtAt: NOW.toISOString(),
      })
    ).toBe('a1b2c3d4 on main at 2026-08-02T10:00:00.000Z');
  });

  it('names every unknown rather than printing "null"', () => {
    expect(describeIdentity({ commit: null, branch: null, dirty: true, builtAt: null })).toBe(
      'unknown on detached at unknown time'
    );
  });
});
