// #1380 — the promotion gate's tests. Promotion runs a handful of times a
// year and its failure mode is a production release of code that never baked,
// so every refusal is pinned here instead of found by pushing a tag.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import path from 'path';
import { ALLOWED_CHANGES, checkPromotion, gatherFacts } from './promote-beta.js';

const SCRIPT = path.join(process.cwd(), 'scripts', 'promote-beta.js');
const BETA = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);

/** the facts of a promotion that should go through */
function good(over = {}) {
  return {
    betaTag: 'v0.8.125-beta.2',
    release: { isPrerelease: true, isDraft: false },
    stableExists: false,
    betaCommit: BETA,
    head: HEAD,
    originMain: HEAD,
    headVersion: '0.8.125',
    isAncestor: true,
    changed: ['CHANGELOG.md', 'package-lock.json', 'package.json'],
    remoteBetaCommit: BETA,
    manifestDrift: [],
    fetchFailed: [],
    ...over,
  };
}

describe('checkPromotion', () => {
  it('passes the beta plus one version commit, and names the stable tag', () => {
    expect(checkPromotion(good())).toEqual({ ok: true, problems: [], stableTag: 'v0.8.125' });
  });

  it('allows exactly the version and changelog files', () => {
    expect(ALLOWED_CHANGES).toEqual(['package.json', 'package-lock.json', 'CHANGELOG.md']);
    expect(checkPromotion(good({ changed: ['package.json'] })).ok).toBe(true);
  });

  it.each([['v0.8.125'], ['v0.8.125-beta.0'], ['0.8.125-beta.1'], ['v0.8.125-rc.1'], ['v0.8.125-beta'], ['']])(
    'refuses %s, which is not a beta tag',
    (betaTag) => {
      const v = checkPromotion(good({ betaTag }));
      expect(v.ok).toBe(false);
      expect(v.problems[0]).toMatch(/is not a beta tag/);
    }
  );

  it('REFUSES when the beta release does not exist', () => {
    const v = checkPromotion(good({ release: null }));
    expect(v.ok).toBe(false);
    expect(v.problems.join('\n')).toMatch(/no GitHub release named v0\.8\.125-beta\.2/);
  });

  it('refuses a beta that is a draft, or was not published as a pre-release', () => {
    expect(checkPromotion(good({ release: { isPrerelease: true, isDraft: true } })).problems.join()).toMatch(
      /DRAFT/
    );
    expect(checkPromotion(good({ release: { isPrerelease: false, isDraft: false } })).problems.join()).toMatch(
      /not marked pre-release/
    );
  });

  it('refuses when the production version already exists', () => {
    expect(checkPromotion(good({ stableExists: true })).problems.join()).toMatch(/v0\.8\.125 already exists/);
  });

  it('refuses when HEAD still carries the beta version (the release PR is not merged)', () => {
    const v = checkPromotion(good({ headVersion: '0.8.125-beta.2', changed: [] }));
    expect(v.ok).toBe(false);
    expect(v.problems.join()).toMatch(/says 0\.8\.125-beta\.2, not 0\.8\.125/);
  });

  it('refuses a HEAD that is not origin/main (every commit goes through a PR)', () => {
    expect(checkPromotion(good({ originMain: 'c'.repeat(40) })).problems.join()).toMatch(/not origin\/main/);
    expect(checkPromotion(good({ originMain: null })).ok).toBe(false);
  });

  it('refuses a HEAD that does not descend from the beta', () => {
    expect(checkPromotion(good({ isAncestor: false })).problems.join()).toMatch(/not an ancestor of HEAD/);
    expect(checkPromotion(good({ betaCommit: null })).problems.join()).toMatch(/cannot resolve/);
  });

  it('REFUSES a manifest that changed in more than its version (a dependency, a script, the lock)', () => {
    const v = checkPromotion(good({ manifestDrift: ['package.json', 'package-lock.json'] }));
    expect(v.ok).toBe(false);
    expect(v.problems.join('\n')).toMatch(/package\.json changed in more than its version/);
    expect(v.problems.join('\n')).toMatch(/package-lock\.json changed in more than its version/);
  });

  it('refuses when the refs could not be refreshed', () => {
    expect(checkPromotion(good({ fetchFailed: ['origin/main'] })).problems.join()).toMatch(
      /could not fetch origin\/main/
    );
  });

  it('refuses a local beta tag that is not the one on the remote', () => {
    expect(checkPromotion(good({ remoteBetaCommit: 'c'.repeat(40) })).problems.join()).toMatch(
      /is not the one on the remote/
    );
    expect(checkPromotion(good({ remoteBetaCommit: null })).problems.join()).toMatch(/\(missing\)/);
  });

  it('REFUSES code that never baked: any change beyond version + changelog', () => {
    const v = checkPromotion(good({ changed: ['package.json', 'src/main/index.ts', 'CHANGELOG.md'] }));
    expect(v.ok).toBe(false);
    expect(v.problems.join()).toMatch(/src\/main\/index\.ts.*Cut a new beta/);
  });
});

describe('gatherFacts', () => {
  /** a fake git/gh keyed on the joined command line */
  function fakeRun(answers) {
    const calls = [];
    const run = (cmd, args) => {
      const key = [cmd, ...args].join(' ');
      calls.push(key);
      const hit = Object.entries(answers).find(([k]) => key.startsWith(k));
      return hit ? { status: 0, stdout: hit[1] } : { status: 1, stdout: '' };
    };
    return { run, calls };
  }

  it('reads every fact from git and gh, at HEAD rather than the working tree', () => {
    const { run, calls } = fakeRun({
      'git fetch': '',
      'gh release view v0.8.125-beta.2': '{"isPrerelease":true,"isDraft":false}',
      // an ANNOTATED beta tag: the peeled `^{}` line is the commit
      'git ls-remote --tags origin refs/tags/v0.8.125-beta.2': `${'d'.repeat(40)}\trefs/tags/v0.8.125-beta.2\n${BETA}\trefs/tags/v0.8.125-beta.2^{}\n`,
      'git ls-remote': '',
      'git rev-parse HEAD': HEAD,
      'git rev-parse origin/main': HEAD,
      'git rev-parse --verify --quiet v0.8.125-beta.2^{commit}': BETA,
      'git show HEAD:package.json': '{"version":"0.8.125","dependencies":{"x":"1"}}',
      [`git show ${BETA}:package.json`]: '{"version":"0.8.125-beta.2","dependencies":{"x":"1"}}',
      'git show HEAD:package-lock.json': '{"version":"0.8.125","packages":{"":{"version":"0.8.125"}}}',
      [`git show ${BETA}:package-lock.json`]:
        '{"version":"0.8.125-beta.2","packages":{"":{"version":"0.8.125-beta.2"}}}',
      'git merge-base --is-ancestor': '',
      'git diff --name-only': 'CHANGELOG.md\npackage-lock.json\npackage.json\n',
    });
    const f = gatherFacts('v0.8.125-beta.2', { run });
    expect(f).toEqual(good());
    // refs are refreshed BEFORE anything is compared
    expect(calls[0]).toBe('git fetch --quiet --tags origin');
    expect(checkPromotion(f).ok).toBe(true);
  });

  it('a dependency bump riding along with the version is caught as manifest drift', () => {
    const { run } = fakeRun({
      'git fetch': '',
      'gh release view v0.8.125-beta.2': '{"isPrerelease":true,"isDraft":false}',
      'git ls-remote --tags origin refs/tags/v0.8.125-beta.2': `${BETA}\trefs/tags/v0.8.125-beta.2\n`,
      'git ls-remote': '',
      'git rev-parse HEAD': HEAD,
      'git rev-parse origin/main': HEAD,
      'git rev-parse --verify --quiet v0.8.125-beta.2^{commit}': BETA,
      'git show HEAD:package.json': '{"version":"0.8.125","dependencies":{"x":"2"}}',
      [`git show ${BETA}:package.json`]: '{"version":"0.8.125-beta.2","dependencies":{"x":"1"}}',
      'git merge-base --is-ancestor': '',
      'git diff --name-only': 'package.json\n',
    });
    const f = gatherFacts('v0.8.125-beta.2', { run });
    expect(f.remoteBetaCommit).toBe(BETA); // a LIGHTWEIGHT tag: the plain line is the commit
    expect(f.manifestDrift).toEqual(['package.json']);
    expect(checkPromotion(f).ok).toBe(false);
  });

  it('a manifest that cannot be read on either side counts as drift (fail closed)', () => {
    const { run } = fakeRun({
      'git fetch': '',
      'gh release view v0.8.125-beta.2': '{"isPrerelease":true,"isDraft":false}',
      'git ls-remote --tags origin refs/tags/v0.8.125-beta.2': `${BETA}\trefs/tags/v0.8.125-beta.2\n`,
      'git ls-remote': '',
      'git rev-parse HEAD': HEAD,
      'git rev-parse origin/main': HEAD,
      'git rev-parse --verify --quiet v0.8.125-beta.2^{commit}': BETA,
      // no `git show` answers at all: both reads fail
      'git merge-base --is-ancestor': '',
      'git diff --name-only': 'package-lock.json\n',
    });
    const f = gatherFacts('v0.8.125-beta.2', { run });
    expect(f.manifestDrift).toEqual(['package-lock.json']);
    expect(checkPromotion(f).ok).toBe(false);
  });

  it('a failed fetch is a refusal, not a silent stale answer', () => {
    const { run } = fakeRun({ 'git rev-parse HEAD': HEAD });
    const f = gatherFacts('v0.8.125-beta.2', { run });
    expect(f.fetchFailed).toEqual(['the tags', 'origin/main']);
    expect(checkPromotion(f).problems.join('\n')).toMatch(/could not fetch the tags/);
  });

  it('a missing beta release, a stable tag on the remote, and unreadable JSON all land as refusals', () => {
    const { run } = fakeRun({
      'git ls-remote --tags origin refs/tags/v0.8.125': 'deadbeef\trefs/tags/v0.8.125',
      'git rev-parse HEAD': HEAD,
      'git rev-parse origin/main': HEAD,
      'git show HEAD:package.json': 'not json',
    });
    const v = checkPromotion(gatherFacts('v0.8.125-beta.2', { run }));
    expect(v.ok).toBe(false);
    const all = v.problems.join('\n');
    expect(all).toMatch(/no GitHub release/);
    expect(all).toMatch(/already exists/);
    expect(all).toMatch(/\(unreadable\)/);
  });
});

describe('the CLI', () => {
  it('refuses a non-beta tag before touching git or the network', () => {
    const r = spawnSync(process.execPath, [SCRIPT, 'v0.8.125', '--dry-run'], { encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/REFUSED.*not a beta tag/);
  });

  it('prints usage with no tag', () => {
    const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/usage:/);
  });
});
