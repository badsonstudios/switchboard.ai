// P2-E19-02 — release.yml's load-bearing promises, asserted.
//
// The sibling of packaging.test.ts and check-scripts.test.ts, for the same
// reason and more sharply: this workflow runs a handful of times a year and
// NOTHING exercises it in between. Its scripts are unit-tested next to
// themselves; what is left in the YAML is where a wrong answer is silent —
// a job quietly granted write access to the repo, a trigger widened to every
// push, a renamed script the workflow still calls by the old name, or a
// re-run that duplicates a release instead of converging on it.
//
// Deliberately NOT a YAML parse: the only parser in the tree is js-yaml,
// pulled in transitively by electron-builder, and a test that goes red when a
// devDependency reshuffles its own dependencies is a test nobody trusts. These
// are string assertions against a file this repo writes by hand.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const root = process.cwd();

/**
 * Line endings NORMALISED, and that is not tidiness.
 *
 * Originally load-bearing: with no `.gitattributes`, this machine and GitHub's
 * windows-latest runner both checked out with `core.autocrlf=true`, so every
 * assertion below saw LF locally (these files were authored with LF and never
 * re-checked-out) and CRLF on the Windows CI job. A regex with a literal `\n`,
 * or a `$` that expects to sit against one, then passed here and failed only in
 * CI. Verified rather than assumed: converting the workflow to CRLF reddened
 * two of these tests without this line.
 *
 * `.gitattributes` now pins every checkout to LF (#280), so the mismatch it was
 * written for cannot recur. Kept anyway, and cheaply: it costs one pass over a
 * small file, and it keeps these assertions true for a working copy that
 * predates that file or reaches us through some other path.
 */
const read = (f: string) => fs.readFileSync(path.join(root, f), 'utf8').replace(/\r\n/g, '\n');

const RELEASE = '.github/workflows/release.yml';
const CI = '.github/workflows/ci.yml';

const wf = read(RELEASE);
/** everything from `jobs:` down — job keys are the only 2-space keys in it */
const jobs = wf.slice(wf.indexOf('\njobs:'));

describe('release workflow triggers (P2-E19-02)', () => {
  it('exists and is separate from CI', () => {
    expect(fs.existsSync(path.join(root, RELEASE))).toBe(true);
    expect(fs.existsSync(path.join(root, CI))).toBe(true);
  });

  it('runs on a v* tag push and on manual dispatch, and on nothing else', () => {
    expect(wf).toMatch(/^ {2}push:\n {4}tags: \['v\*'\]$/m);
    expect(wf).toContain('workflow_dispatch:');
    // A release workflow that also ran on pull_request or on pushes to main
    // would hand a repo-writing token to every PR. That is CI's territory.
    expect(wf).not.toContain('pull_request');
    expect(wf).not.toMatch(/branches:/);
  });

  it('gives workflow_dispatch a dry_run input that defaults to NOT publishing', () => {
    // The safe default matters: a dispatch is the way this workflow gets
    // exercised, and it must never publish because someone left a box ticked.
    expect(wf).toMatch(/dry_run:[\s\S]{0,200}?type: boolean[\s\S]{0,80}?default: true/);
  });

  it('never cancels a run that may be mid-release', () => {
    expect(wf).toContain('cancel-in-progress: false');
  });
});

describe('the token is scoped to the one job that publishes', () => {
  it('is read-only at the top level', () => {
    expect(wf).toMatch(/^permissions:\n {2}contents: read$/m);
  });

  it('grants contents: write exactly once, in the release job', () => {
    // Line-anchored: prose about the grant is not the grant, and the file
    // explains itself in comments.
    expect(wf.match(/^\s*contents: write$/gm) ?? []).toHaveLength(1);
    expect(jobs.search(/^\s*contents: write$/m)).toBeGreaterThan(jobs.indexOf('\n  release:'));
  });

  it('has exactly two jobs, and the publishing one is last', () => {
    // The extraction only holds while job keys are the sole 2-space keys under
    // `jobs:`; if that stops being true this list changes and the test says so.
    const names = [...jobs.matchAll(/^ {2}([a-z_-]+):$/gm)].map((m) => m[1]);
    expect(names).toEqual(['build', 'release']);
  });

  it('publishes only from a tag push or an explicit dry_run:false', () => {
    expect(wf).toContain(
      "if: ${{ github.event_name == 'push' || github.event.inputs.dry_run == 'false' }}"
    );
    // …and dry_run:false is refused outright unless the ref IS a tag, so the
    // workflow can never create a tag of its own from a branch.
    expect(wf).toContain(
      "if: ${{ github.event.inputs.dry_run == 'false' && !startsWith(github.ref, 'refs/tags/v') }}"
    );
  });

  it('compares the dispatch input as a STRING, never against a boolean', () => {
    // GitHub's `==` casts a non-numeric string to NaN, so `inputs.dry_run ==
    // false` is quietly false when the input arrives as the string 'false' —
    // and whether it does depends on how the run was started.
    // `github.event.inputs` is the raw payload and is always strings.
    // comments stripped — this file explains the trap in prose, and the prose
    // must not be mistaken for the trap
    const code = wf
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .join('\n');
    expect(code).not.toMatch(/inputs\.dry_run == (?:false|true)\b/);
    expect(wf.match(/github\.event\.inputs\.dry_run == 'false'/g) ?? []).toHaveLength(2);
  });
});

describe('the build job gates before it builds', () => {
  // Step BLOCKS, not step headers: a step's `run:` sits under its `name:`, so
  // matching single lines would miss exactly the two script invocations this
  // block exists to order. Splitting on the `- ` bullet keeps each step whole.
  const buildJob = jobs.slice(jobs.indexOf('\n  build:'), jobs.indexOf('\n  release:'));
  const steps = buildJob.split(/\n {6}- /).slice(1);
  /** index of the step that RUNS a command — `run: `-prefixed so the workflow's
   *  own comments ("FIRST, before npm ci…") cannot be mistaken for a step. */
  const at = (cmd: string) => steps.findIndex((s) => s.includes(`run: ${cmd}`));

  it('runs on Windows (the only packaging target — E19 decision 3)', () => {
    expect(wf).toContain('runs-on: windows-latest');
    expect(wf).not.toContain('macos-latest');
  });

  it('uses the same Node and cache conventions as CI', () => {
    const ci = read(CI);
    for (const line of ['node-version: 22', 'cache: npm']) {
      expect(wf).toContain(line);
      expect(ci).toContain(line);
    }
    // The action majors are read OUT of ci.yml rather than written down here.
    // Pinned literals (`@v4`) made this test the thing that goes red when the
    // majors are bumped — a third file to remember, which is how the workflows
    // sat on Node-20 actions until the runner started warning about it (#575).
    // The invariant that matters is parity: whatever CI checks out and sets up
    // Node with, the release build does too.
    for (const action of ['actions/checkout', 'actions/setup-node']) {
      const major = ci.match(new RegExp(`${action}@(v\\d+)`))?.[1];
      expect(major, `${action} is not used by ci.yml`).toBeDefined();
      expect(wf).toContain(`${action}@${major}`);
    }
  });

  it('checks the tag and the changelog BEFORE spending two minutes packaging', () => {
    // A tag that disagrees with package.json should cost seconds, not a full
    // Windows build — and `npm ci` should not run for a release that cannot
    // happen.
    expect(steps.length, 'the step split found nothing — this block proves nothing').toBeGreaterThan(
      5
    );
    expect(at('node scripts/release-notes.js')).toBeGreaterThanOrEqual(0);
    expect(at('node scripts/release-notes.js')).toBeLessThan(at('npm ci'));
    expect(at('npm ci')).toBeLessThan(at('npm run package'));
  });

  it('runs the same lint + typecheck + unit gate CI runs', () => {
    for (const step of ['npm run lint', 'npm run typecheck', 'npm test']) {
      expect(at(step)).toBeGreaterThan(at('npm ci'));
      expect(at(step)).toBeLessThan(at('npm run package'));
    }
  });

  it('writes the checksum sidecar after packaging, and uploads both', () => {
    expect(at('node scripts/sha256-sidecar.js')).toBeGreaterThan(at('npm run package'));
    expect(wf).toContain('.sha256');
    expect(wf).toContain('if-no-files-found: error');
  });
});

describe('the scripts the workflow calls exist and are tested', () => {
  it.each([['scripts/release-notes.js'], ['scripts/sha256-sidecar.js']])(
    '%s is committed, referenced, and has tests',
    (script) => {
      expect(wf).toContain(script);
      expect(fs.existsSync(path.join(root, script))).toBe(true);
      expect(fs.existsSync(path.join(root, script.replace(/\.js$/, '.test.js')))).toBe(true);
    }
  );

  it('never disables the rollup', () => {
    // `--no-rollup` is a local preview convenience. In the workflow it would
    // silently drop the notes of a skipped release — the exact invisibility the
    // rule exists to prevent, and visible to nobody until someone went looking
    // for a version that never got a release page.
    expect(wf).not.toContain('--no-rollup');
  });

  it('names the installer from the packaging config rather than a literal', () => {
    // release.yml uses the `installer` output; the literal name lives once, in
    // electron-builder.js. A third copy in YAML is the one nothing would catch.
    expect(wf).toContain('steps.notes.outputs.installer');
    expect(wf).not.toContain('switchboard-Setup-');
  });
});

describe('a re-run converges instead of duplicating (idempotency)', () => {
  it('checks for an existing release and edits it rather than creating a second', () => {
    expect(wf).toContain('gh release view "$TAG"');
    expect(wf).toContain('gh release edit "$TAG"');
    expect(wf).toContain('gh release create "$TAG"');
    // Assets of the same name must be replaced, not rejected — the failure this
    // recovers from is a first run that created the release and then died
    // during upload, leaving something the updater offers with nothing to fetch.
    expect(wf).toContain('--clobber');
  });

  it('runs that shell with -euo pipefail so a failed gh call fails the job', () => {
    expect(wf).toContain('set -euo pipefail');
    expect(wf).toContain('shell: bash');
  });

  it('uploads the assets from where the artifact actually puts them', () => {
    // upload-artifact roots at the least common ancestor of its paths. With
    // `release-notes.md` at the repo root alongside `dist/…`, that ancestor is
    // the workspace — so the installer comes back down still under `dist/`.
    // Getting this wrong fails only on a tag push, which is the worst place to
    // find out, so both halves are pinned together.
    expect(wf).toContain('release-notes.md');
    expect(wf).toContain('dist/$INSTALLER');
    expect(wf).toContain('dist/${{ steps.notes.outputs.installer }}');
    // …and if the layout ever does move, the job says so instead of handing gh
    // a path that does not exist.
    expect(wf).toContain('expected $f in the build artifact');
  });
});

describe('CI is untouched (P2-E19-02 done-when)', () => {
  it('still declares its two matrices — 4 jobs on PRs, 5 on main pushes', () => {
    // The build matrix became conditional on 2026-08-06 (Dan's call): macOS
    // runs on pushes to main only — across runs 1-6 its lone unique PR-gate
    // signal was the known fs.watch flake, at a full re-run per sighting.
    // This pin holds BOTH halves of the conditional, so dropping an OS from
    // either event, or reordering the ternary, fails here rather than
    // silently shrinking coverage.
    const ci = read(CI);
    expect(ci).toContain(
      'os: ${{ github.event_name == \'push\' && ' +
        'fromJSON(\'["windows-latest", "ubuntu-latest", "macos-latest"]\') || ' +
        'fromJSON(\'["windows-latest", "ubuntu-latest"]\') }}'
    );
    expect(ci).toContain('os: [windows-latest, ubuntu-latest]');
  });

  it('has no release concerns leaking into it', () => {
    const ci = read(CI);
    expect(ci).not.toContain('gh release');
    expect(ci).not.toContain('contents: write');
    expect(ci).not.toContain('release-notes.js');
  });
});
