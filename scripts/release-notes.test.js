// P2-E19-02 — the release gate's tests.
//
// This logic runs a handful of times a year, on a tag push, at the moment
// nobody wants a surprise. It cannot be exercised by pushing tags to find out,
// so everything release.yml delegates to `release-notes.js` is pinned here:
// the notes-required hard fail, the rollup of never-published versions, the
// tag-vs-version match, and the CLI wiring the workflow actually calls.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  ReleaseError,
  ROLLUP_PREAMBLE,
  listVersions,
  headingFor,
  extractSection,
  tagFromRef,
  resolveRelease,
  buildNotes,
  decideAction,
  installerName,
} from './release-notes.js';
import { tempDir } from '../src/test-temp-dirs';

const root = process.cwd();
const SCRIPT = path.join(root, 'scripts', 'release-notes.js');

/** a changelog shaped like this repo's real one */
const CHANGELOG = [
  '# Changelog',
  '',
  '## The version, and how it moves',
  '',
  'Prose that must never be mistaken for a release section.',
  '',
  '---',
  '',
  '## 0.3.0 — unreleased',
  '',
  '### Added',
  '',
  '- The newest thing.',
  '',
  '## 0.2.0 — 2026-07-01',
  '',
  '- The middle thing.',
  '',
  '## 0.1.0 — 2026-06-01',
  '',
  '- The first thing.',
  '',
].join('\n');

const never = () => false;
const always = () => true;

describe('CHANGELOG parsing', () => {
  it('lists versions newest-first and ignores prose headings', () => {
    expect(listVersions(CHANGELOG)).toEqual(['0.3.0', '0.2.0', '0.1.0']);
  });

  it('does not mistake a `### ` group for a new section', () => {
    // The failure this prevents: every section ending at its first `### Added`,
    // i.e. release notes that are one blank line long.
    expect(extractSection(CHANGELOG, '0.3.0')).toBe('### Added\n\n- The newest thing.');
  });

  it('reads a middle section without bleeding into its neighbours', () => {
    expect(extractSection(CHANGELOG, '0.2.0')).toBe('- The middle thing.');
  });

  it('reads the last section to end of file', () => {
    expect(extractSection(CHANGELOG, '0.1.0')).toBe('- The first thing.');
  });

  it('accepts the keep-a-changelog bracket form too', () => {
    const cl = '## [1.2.3] - 2026-01-01\n\n- bracketed\n';
    expect(listVersions(cl)).toEqual(['1.2.3']);
    expect(extractSection(cl, '1.2.3')).toBe('- bracketed');
  });

  it('accepts a prerelease version', () => {
    const cl = '## 1.0.0-rc.1 — unreleased\n\n- almost\n';
    expect(listVersions(cl)).toEqual(['1.0.0-rc.1']);
    expect(extractSection(cl, '1.0.0-rc.1')).toBe('- almost');
  });

  it('strips a horizontal rule left between sections', () => {
    const cl = '## 1.0.0\n\n- a thing\n\n---\n\n## 0.9.0\n\n- older\n';
    expect(extractSection(cl, '1.0.0')).toBe('- a thing');
  });

  it('returns null for a version with no section, and "" for an empty one', () => {
    expect(extractSection(CHANGELOG, '9.9.9')).toBeNull();
    expect(extractSection('## 1.0.0 — unreleased\n\n\n## 0.9.0\n\n- x\n', '1.0.0')).toBe('');
  });

  it('collapses a duplicated heading to its first appearance', () => {
    const cl = '## 1.0.0\n\n- first\n\n## 1.0.0\n\n- second\n';
    expect(listVersions(cl)).toEqual(['1.0.0']);
    expect(extractSection(cl, '1.0.0')).toBe('- first');
  });

  it('finds the heading line so the CLI can spot "unreleased"', () => {
    expect(headingFor(CHANGELOG, '0.3.0')).toBe('## 0.3.0 — unreleased');
    expect(headingFor(CHANGELOG, '9.9.9')).toBeNull();
  });

  it('handles CRLF', () => {
    expect(extractSection(CHANGELOG.split('\n').join('\r\n'), '0.2.0')).toBe('- The middle thing.');
  });

  it('reads THIS repo’s real CHANGELOG.md', () => {
    // The guard that matters on any given day: package.json's current version
    // must have real notes, or the next tag push fails in CI instead of here.
    const real = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
    const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const section = extractSection(real, version);
    expect(section, `CHANGELOG.md has no section for ${version}`).not.toBeNull();
    expect(section.trim().length).toBeGreaterThan(0);
    // the prose preamble has `## ` headings of its own; they must not parse —
    // every parsed entry must be a bare semver. Older sections are permanent
    // history (this bit on the 0.1.1 tag: the original `toEqual([version])`
    // assumed a one-section changelog, true only for the first release ever).
    const versions = listVersions(real);
    for (const v of versions) expect(v).toMatch(/^\d+\.\d+\.\d+$/);

    // Above the released section sits EXACTLY ONE `— unreleased` placeholder,
    // opened by the release cut (CHANGELOG.md, cut step 2) for work that lands
    // next. It is mandatory, and pinned here rather than left to discipline:
    // 0.1.2 shipped without one and five consecutive work items then had
    // nowhere legal to file their entry (#353). Red on the next commit beats
    // five more workers finding out one at a time.
    //
    // It cannot leak into a release: buildNotes only rolls up versions OLDER
    // than the one being released, so a newer heading is invisible to the
    // notes. A SECOND speculative section is the thing that hurts — entries
    // split across two, and only the one the cut lands on is published.
    expect(
      headingFor(real, versions[0]),
      'CHANGELOG.md needs one "— unreleased" section above the released one (cut step 2)'
    ).toMatch(/unreleased/i);
    expect(versions[0], 'the unreleased placeholder may not reuse the released version').not.toBe(
      version
    );
    expect(versions[1], 'only one section may sit above the current version').toBe(version);
  });

  it('pins package-lock.json to the same version as package.json', () => {
    // #487. Nothing else reads the lock's version, so a cut that forgets
    // `npm install --package-lock-only` (cut step 1) is silent: the lock sat on
    // 0.1.0 through four releases before #394 caught it. Both copies are
    // checked — npm writes the number twice and refreshes them together.
    const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
    const stale = 'package-lock.json is stale — run `npm install --package-lock-only`';
    expect(lock.version, stale).toBe(version);
    expect(lock.packages[''].version, stale).toBe(version);
  });
});

describe('tag vs package.json version', () => {
  it.each([
    ['refs/tags/v1.2.3', 'v1.2.3'],
    ['refs/tags/1.2.3', '1.2.3'],
    ['v1.2.3', 'v1.2.3'],
    ['1.2.3', '1.2.3'],
  ])('%s names tag %s', (ref, tag) => {
    expect(tagFromRef(ref)).toBe(tag);
  });

  it.each([
    ['refs/heads/main'],
    ['refs/heads/feature/258-release-workflow'],
    ['refs/pull/262/merge'],
    ['main'],
    [''],
    [null],
    [undefined],
  ])('%s is not a tag', (ref) => {
    expect(tagFromRef(ref)).toBeNull();
  });

  it('accepts a matching tag, with or without the v', () => {
    for (const ref of ['refs/tags/v1.2.3', 'refs/tags/1.2.3']) {
      expect(resolveRelease({ ref, version: '1.2.3' })).toEqual({
        tag: 'v1.2.3',
        version: '1.2.3',
        fromTag: true,
      });
    }
  });

  it('REFUSES a tag that disagrees with package.json', () => {
    // The whole point: an installer named 0.1.0 published as v0.2.0 is what
    // E19-03's update check compares strings against.
    expect(() => resolveRelease({ ref: 'refs/tags/v0.2.0', version: '0.1.0' })).toThrow(
      ReleaseError
    );
    expect(() => resolveRelease({ ref: 'refs/tags/v0.2.0', version: '0.1.0' })).toThrow(
      /v0\.2\.0 does not match package\.json version 0\.1\.0/
    );
  });

  it('falls back to package.json on a non-tag ref (workflow_dispatch)', () => {
    expect(resolveRelease({ ref: 'refs/heads/main', version: '0.1.0' })).toEqual({
      tag: 'v0.1.0',
      version: '0.1.0',
      fromTag: false,
    });
  });

  it('always produces a v-prefixed canonical tag', () => {
    expect(resolveRelease({ ref: null, version: '9.9.9' }).tag).toBe('v9.9.9');
  });
});

describe('notes-required gate', () => {
  it('HARD FAILS when the version has no changelog section', () => {
    expect(() => buildNotes({ changelog: CHANGELOG, version: '0.4.0', isPublished: never })).toThrow(
      /CHANGELOG\.md has no section for 0\.4\.0/
    );
  });

  it('HARD FAILS on a heading with nothing under it', () => {
    const cl = '## 1.0.0 — unreleased\n\n\n## 0.9.0\n\n- older\n';
    expect(() => buildNotes({ changelog: cl, version: '1.0.0', isPublished: always })).toThrow(
      /section for 1\.0\.0 is empty/
    );
  });

  it('the failure is a ReleaseError, so the CLI exits 1 rather than stack-dumping', () => {
    try {
      buildNotes({ changelog: CHANGELOG, version: '0.4.0', isPublished: never });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ReleaseError);
      expect(err.message).toMatch(/offers every release to every user/);
    }
  });

  it('returns the section verbatim when nothing is owed a rollup', () => {
    expect(buildNotes({ changelog: CHANGELOG, version: '0.3.0', isPublished: always })).toEqual({
      notes: '### Added\n\n- The newest thing.',
      rolledUp: [],
    });
  });

  it('needs no published-check at all for the oldest version', () => {
    const boom = () => {
      throw new Error('isPublished must not be consulted when there is nothing older');
    };
    expect(buildNotes({ changelog: CHANGELOG, version: '0.1.0', isPublished: boom }).notes).toBe(
      '- The first thing.'
    );
  });
});

describe('rollup of never-published versions', () => {
  it('rolls one skipped version into the notes', () => {
    const { notes, rolledUp } = buildNotes({
      changelog: CHANGELOG,
      version: '0.3.0',
      isPublished: (v) => v === '0.1.0',
    });
    expect(rolledUp).toEqual(['0.2.0']);
    expect(notes).toBe(
      [
        ROLLUP_PREAMBLE,
        '',
        '### Added',
        '',
        '- The newest thing.',
        '',
        '---',
        '',
        '## 0.2.0 (previously unpublished)',
        '',
        '- The middle thing.',
      ].join('\n')
    );
  });

  it('rolls up every unpublished version, oldest still last', () => {
    const { notes, rolledUp } = buildNotes({
      changelog: CHANGELOG,
      version: '0.3.0',
      isPublished: never,
    });
    expect(rolledUp).toEqual(['0.2.0', '0.1.0']);
    expect(notes.indexOf('0.2.0 (previously unpublished)')).toBeLessThan(
      notes.indexOf('0.1.0 (previously unpublished)')
    );
  });

  it('STOPS at the first version that was published', () => {
    // The file is newest-first, so anything past a published version was
    // published too — walking on would republish ancient history every time.
    const { rolledUp } = buildNotes({
      changelog: CHANGELOG,
      version: '0.3.0',
      isPublished: (v) => v === '0.2.0',
    });
    expect(rolledUp).toEqual([]);
  });

  it('never silently drops a skipped version whose own section is empty', () => {
    const cl = '## 1.0.0\n\n- new\n\n## 0.9.0\n\n## 0.8.0\n\n- old\n';
    const { notes, rolledUp } = buildNotes({ changelog: cl, version: '1.0.0', isPublished: never });
    expect(rolledUp).toEqual(['0.9.0', '0.8.0']);
    expect(notes).toContain('## 0.9.0 (previously unpublished)');
    expect(notes).toContain('_No notes were written for this version._');
  });
});

describe('idempotency + artifact naming', () => {
  it('creates a release that does not exist and updates one that does', () => {
    expect(decideAction({ exists: false })).toBe('create');
    expect(decideAction({ exists: true })).toBe('update');
  });

  it('derives the installer name from the packaging config, not a second copy', () => {
    expect(installerName('1.2.3')).toBe('switchboard-Setup-1.2.3.exe');
    const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    expect(fs.readFileSync(path.join(root, 'electron-builder.js'), 'utf8')).toContain(
      'switchboard-Setup-${version}.exe'
    );
    expect(installerName(version)).toBe(`switchboard-Setup-${version}.exe`);
  });
});

// --- the CLI, which is what release.yml actually invokes --------------------

/** a throwaway repo root: package.json + CHANGELOG.md + the packaging config */
function fakeRepo(version, changelog) {
  // Registered, so `test-setup.ts`'s `afterAll` net takes it (#213, #360).
  // Before that this file had no teardown at all: one leaked directory per
  // call, for ever.
  const dir = tempDir('sb-release-');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version }));
  fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), changelog);
  fs.copyFileSync(path.join(root, 'electron-builder.js'), path.join(dir, 'electron-builder.js'));
  return dir;
}

function cli(args, env = {}) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return { status: r.status, out: r.stdout, err: r.stderr };
}

describe('the CLI release.yml calls', () => {
  it('prints the notes and exits 0 on the real repo', () => {
    // --no-rollup keeps it off the network; the rollup itself is covered above.
    const r = cli(['--ref', 'refs/heads/main', '--no-rollup']);
    expect(r.status, r.err).toBe(0);
    expect(r.out.trim().length).toBeGreaterThan(0);
  });

  it('writes --out and the step outputs the workflow reads', () => {
    const dir = fakeRepo('0.3.0', CHANGELOG);
    const outFile = path.join(dir, 'notes.md');
    const ghOut = path.join(dir, 'gh-output.txt');
    fs.writeFileSync(ghOut, '');
    const r = cli(['--root', dir, '--ref', 'refs/tags/v0.3.0', '--out', outFile, '--no-rollup'], {
      GITHUB_OUTPUT: ghOut,
    });
    expect(r.status, r.err).toBe(0);
    expect(fs.readFileSync(outFile, 'utf8')).toBe('### Added\n\n- The newest thing.\n');
    const outputs = fs.readFileSync(ghOut, 'utf8');
    expect(outputs).toContain('version=0.3.0');
    expect(outputs).toContain('tag=v0.3.0');
    expect(outputs).toContain('installer=switchboard-Setup-0.3.0.exe');
    expect(outputs).toContain('from_tag=true');
  });

  it('exits 1 with a ::error:: annotation when the section is missing', () => {
    const dir = fakeRepo('9.9.9', CHANGELOG);
    const r = cli(['--root', dir, '--ref', 'refs/tags/v9.9.9', '--no-rollup']);
    expect(r.status).toBe(1);
    expect(r.err).toMatch(/^::error::CHANGELOG\.md has no section for 9\.9\.9/m);
  });

  it('exits 1 when the tag disagrees with package.json', () => {
    const dir = fakeRepo('0.3.0', CHANGELOG);
    const r = cli(['--root', dir, '--ref', 'refs/tags/v0.4.0', '--no-rollup']);
    expect(r.status).toBe(1);
    expect(r.err).toMatch(/::error::tag v0\.4\.0 does not match/);
  });

  it('reports the MISSING SECTION even when gh is unreachable', () => {
    // Ordering that matters: the published-check is lazy, so a token or network
    // problem can never mask "you forgot the changelog section". Being told the
    // wrong one of those two costs a whole Windows build to find out.
    const dir = fakeRepo('9.9.9', CHANGELOG);
    const r = cli(['--root', dir, '--ref', 'refs/tags/v9.9.9'], { PATH: os.tmpdir() });
    expect(r.status).toBe(1);
    expect(r.err).toMatch(/::error::CHANGELOG\.md has no section for 9\.9\.9/);
    expect(r.err).not.toMatch(/could not list existing releases/);
  });

  it('fails LOUDLY when it does need gh and cannot run it', () => {
    // The other half: a rollup decision must never be guessed. 0.3.0 has older
    // versions, so the published-set is genuinely required here.
    const dir = fakeRepo('0.3.0', CHANGELOG);
    const r = cli(['--root', dir, '--ref', 'refs/tags/v0.3.0'], { PATH: os.tmpdir() });
    expect(r.status).toBe(1);
    expect(r.err).toMatch(/::error::could not list existing releases/);
  });

  it('warns, but does not fail, on a version still marked unreleased', () => {
    const dir = fakeRepo('0.3.0', CHANGELOG);
    const r = cli(['--root', dir, '--ref', 'refs/tags/v0.3.0', '--no-rollup']);
    expect(r.status, r.err).toBe(0);
    expect(r.err).toMatch(/::warning::CHANGELOG\.md still marks 0\.3\.0 as unreleased/);
  });
});
