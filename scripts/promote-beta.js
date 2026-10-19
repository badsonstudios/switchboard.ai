// #1380 — promote a beta to a production release.
//
// THE DESIGN, and why it is this one. A beta is `v0.8.125-beta.2`, cut from a
// commit whose package.json says `0.8.125-beta.2`. Promotion is NOT a second
// tag on that same commit: release-notes.js refuses a tag that disagrees with
// package.json, and it is right to — a production installer whose `version`
// still says `-beta.2` would carry that suffix for ever, and the in-app
// checker would rank it BELOW the plain `0.8.125` it is supposed to be.
// Flipping the GitHub release's pre-release flag in place was rejected for the
// same reason: the bytes would be the beta's, version string included.
//
// So promotion is the ordinary release ritual, constrained:
//
//   1. A release PR whose ONLY changes are the version (package.json + lock)
//      and CHANGELOG.md (date the section, open the next one). Merged.
//   2. This script, on that merged commit. It refuses unless the commit is a
//      descendant of the beta and differs from it in those three files alone —
//      so the production build is the baked beta plus one version commit, and
//      nothing that did not bake. Then it tags `v<x.y.z>` and pushes the tag,
//      which runs release.yml's normal production path: tag-vs-version, notes
//      required, checksum sidecar, all of it.
//
// Usage: node scripts/promote-beta.js v0.8.125-beta.2 [--dry-run] [--remote origin]
//
// `--dry-run` runs every check and prints the two commands it would run.
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

/** The files a promotion commit may touch, and no others. */
const ALLOWED_CHANGES = ['package.json', 'package-lock.json', 'CHANGELOG.md'];

const BETA_TAG = /^v(\d+\.\d+\.\d+)-beta\.([1-9]\d*)$/;

/**
 * package.json / package-lock.json with the version taken OUT, as a string.
 *
 * The file-list check alone lets a "version-only" commit smuggle in a
 * dependency bump, a new `postinstall`, or a re-resolved lock — all of which
 * change what gets built and none of which baked. So the two manifests must be
 * identical apart from the version fields npm itself writes.
 *
 * @param {string | null} raw
 * @returns {string | null}  null when it is not JSON at all
 */
function withoutVersion(raw) {
  if (raw === null) return null;
  let j;
  try {
    j = JSON.parse(raw);
  } catch {
    return null;
  }
  if (j && typeof j === 'object') {
    delete j.version;
    const root = j.packages && typeof j.packages === 'object' ? j.packages[''] : null;
    if (root && typeof root === 'object') delete root.version;
  }
  return JSON.stringify(j);
}

/**
 * Every refusal, decided from facts already gathered — so each one is a unit
 * test, not a tag pushed to find out.
 *
 * @param {object} f
 * @param {string} f.betaTag
 * @param {{isPrerelease: boolean, isDraft: boolean} | null} f.release  the beta's GitHub release, or null if there is none
 * @param {boolean} f.stableExists   `v<x.y.z>` already exists, as a tag or a release
 * @param {string | null} f.betaCommit
 * @param {string} f.head
 * @param {string | null} f.originMain
 * @param {string | null} f.headVersion  package.json's version AT HEAD (not the working tree)
 * @param {boolean} f.isAncestor     the beta's commit is an ancestor of HEAD
 * @param {string[]} f.changed       files that differ between the beta and HEAD
 * @param {string[]} [f.manifestDrift]  manifests that differ in MORE than their version
 * @param {string[]} [f.fetchFailed]    refs that could not be refreshed from the remote
 * @param {string | null} [f.remoteBetaCommit]  the commit the REMOTE beta tag names
 * @returns {{ok: boolean, problems: string[], stableTag: string | null}}
 */
function checkPromotion(f) {
  const m = BETA_TAG.exec(f.betaTag ?? '');
  if (!m) {
    return {
      ok: false,
      stableTag: null,
      problems: [`${f.betaTag} is not a beta tag — expected v<x.y.z>-beta.<n>, e.g. v0.8.125-beta.2.`],
    };
  }
  const base = m[1];
  const stableTag = `v${base}`;
  const problems = [];

  for (const what of f.fetchFailed ?? []) {
    problems.push(`could not fetch ${what} from the remote — every check below would be about stale refs.`);
  }
  if (!f.release) {
    problems.push(`there is no GitHub release named ${f.betaTag} — there is nothing to promote.`);
  } else {
    if (f.release.isDraft) problems.push(`${f.betaTag} is still a DRAFT release; nobody has run it.`);
    if (!f.release.isPrerelease) {
      problems.push(`${f.betaTag} is not marked pre-release — it was not published as a beta.`);
    }
  }
  if (f.stableExists) problems.push(`${stableTag} already exists — this beta has been promoted (or superseded).`);
  if (f.headVersion !== base) {
    problems.push(
      `HEAD's package.json says ${f.headVersion ?? '(unreadable)'}, not ${base}. ` +
        `Merge the release PR first: version ${base} in package.json + lock, and the CHANGELOG section dated.`
    );
  }
  if (!f.originMain || f.head !== f.originMain) {
    problems.push(
      'HEAD is not origin/main. Promote from the merged release commit: `git checkout main && git pull`.'
    );
  }
  if (!f.betaCommit) {
    problems.push(`cannot resolve ${f.betaTag} to a commit (git fetch --tags?).`);
  } else if (f.remoteBetaCommit !== undefined && f.remoteBetaCommit !== f.betaCommit) {
    // A local tag that disagrees with the remote one is NOT the beta CI built,
    // and `git fetch --tags` will not overwrite it.
    problems.push(
      `the local ${f.betaTag} (${f.betaCommit.slice(0, 9)}) is not the one on the remote ` +
        `(${(f.remoteBetaCommit ?? 'missing').slice(0, 9)}). Delete the local tag and fetch again.`
    );
  } else if (!f.isAncestor) {
    problems.push(`${f.betaTag} (${f.betaCommit.slice(0, 9)}) is not an ancestor of HEAD — this is not the beta's history.`);
  } else {
    const extra = f.changed.filter((p) => !ALLOWED_CHANGES.includes(p));
    if (extra.length) {
      problems.push(
        `HEAD differs from ${f.betaTag} in more than the version and changelog: ${extra.join(', ')}. ` +
          'That code never baked as a beta. Cut a new beta from HEAD instead.'
      );
    }
    for (const file of f.manifestDrift ?? []) {
      problems.push(
        `${file} changed in more than its version since ${f.betaTag} — a dependency, script or ` +
          'lock change never baked as a beta. Cut a new beta from HEAD instead.'
      );
    }
  }
  return { ok: problems.length === 0, problems, stableTag };
}

/**
 * Gather the facts. `run` is injected so the gathering is testable without a
 * repo; the CLI passes a real `spawnSync`.
 *
 * @param {string} betaTag
 * @param {{remote?: string, run: (cmd: string, args: string[]) => {status: number | null, stdout: string}}} opts
 */
function gatherFacts(betaTag, { remote = 'origin', run }) {
  const out = (cmd, args) => {
    const r = run(cmd, args);
    return r.status === 0 ? r.stdout.trim() : null;
  };
  // Fresh refs first: a stale origin/main or a beta tag this clone never
  // fetched would make every check below answer about the wrong commits.
  const fetchFailed = [];
  if (run('git', ['fetch', '--quiet', '--tags', remote]).status !== 0) fetchFailed.push('the tags');
  if (run('git', ['fetch', '--quiet', remote, 'main']).status !== 0) fetchFailed.push(`${remote}/main`);

  let release = null;
  const view = out('gh', ['release', 'view', betaTag, '--json', 'isPrerelease,isDraft']);
  if (view) {
    try {
      const j = JSON.parse(view);
      release = { isPrerelease: j.isPrerelease === true, isDraft: j.isDraft === true };
    } catch {
      release = null;
    }
  }

  const m = BETA_TAG.exec(betaTag);
  const stableTag = m ? `v${m[1]}` : null;
  const stableExists =
    !!stableTag &&
    (!!out('git', ['ls-remote', '--tags', remote, `refs/tags/${stableTag}`]) ||
      out('git', ['rev-parse', '--verify', '--quiet', `refs/tags/${stableTag}`]) !== null ||
      out('gh', ['release', 'view', stableTag, '--json', 'tagName']) !== null);

  const head = out('git', ['rev-parse', 'HEAD']) ?? '';
  const originMain = out('git', ['rev-parse', `${remote}/main`]);
  const betaCommit = out('git', ['rev-parse', '--verify', '--quiet', `${betaTag}^{commit}`]);
  let headVersion = null;
  const pkg = out('git', ['show', 'HEAD:package.json']);
  if (pkg) {
    try {
      headVersion = JSON.parse(pkg).version ?? null;
    } catch {
      headVersion = null;
    }
  }
  const isAncestor = !!betaCommit && run('git', ['merge-base', '--is-ancestor', betaCommit, 'HEAD']).status === 0;
  const changed = betaCommit
    ? (out('git', ['diff', '--name-only', betaCommit, 'HEAD']) ?? '').split(/\r?\n/).filter(Boolean)
    : [];
  const manifestDrift = betaCommit
    ? ['package.json', 'package-lock.json'].filter((file) => {
        if (!changed.includes(file)) return false;
        const before = withoutVersion(out('git', ['show', `${betaCommit}:${file}`]));
        const after = withoutVersion(out('git', ['show', `HEAD:${file}`]));
        // FAIL CLOSED: a side that could not be read (or is not JSON) is drift.
        // Two failed reads comparing equal would wave through exactly the
        // change this check exists to stop.
        return before === null || after === null || before !== after;
      })
    : [];
  // What the REMOTE tag names. An annotated tag lists its peeled commit as
  // `<sha> refs/tags/<t>^{}`; a lightweight one only as `<sha> refs/tags/<t>`.
  const listed = out('git', ['ls-remote', '--tags', remote, `refs/tags/${betaTag}`, `refs/tags/${betaTag}^{}`]);
  const rows = (listed ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim().split(/\s+/))
    .filter((p) => p.length === 2);
  const peeled = rows.find((p) => p[1].endsWith('^{}'));
  const plain = rows.find((p) => !p[1].endsWith('^{}'));
  const remoteBetaCommit = (peeled ?? plain)?.[0] ?? null;

  return {
    betaTag,
    release,
    stableExists,
    betaCommit,
    remoteBetaCommit,
    head,
    originMain,
    headVersion,
    isAncestor,
    changed,
    manifestDrift,
    fetchFailed,
  };
}

module.exports = { ALLOWED_CHANGES, BETA_TAG, checkPromotion, gatherFacts, withoutVersion };

// --- CLI -------------------------------------------------------------------
if (require.main === module) {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const ri = argv.indexOf('--remote');
  const remote = ri === -1 ? 'origin' : argv[ri + 1] || 'origin';
  const betaTag = argv.find((a, i) => !a.startsWith('--') && argv[i - 1] !== '--remote');
  if (!betaTag) {
    console.error('usage: node scripts/promote-beta.js v<x.y.z>-beta.<n> [--dry-run] [--remote origin]');
    process.exit(2);
  }
  if (!BETA_TAG.test(betaTag)) {
    // before any fetch or gh call: a typo costs nothing
    console.error(`promote-beta: REFUSED — ${checkPromotion({ betaTag }).problems[0]}`);
    process.exit(1);
  }
  const cwd = path.join(__dirname, '..');
  if (!fs.existsSync(path.join(cwd, '.git'))) {
    console.error('promote-beta: run this from a clone of the repo.');
    process.exit(2);
  }
  const run = (cmd, args) => {
    // 64 MB: `git show HEAD:package-lock.json` is ~350 KB and growing, and the
    // 1 MB default would turn it into a failed read
    const r = spawnSync(cmd, args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
    return { status: r.status, stdout: r.stdout ?? '' };
  };

  const facts = gatherFacts(betaTag, { remote, run });
  const verdict = checkPromotion(facts);
  if (!verdict.ok) {
    console.error(`promote-beta: REFUSED — ${betaTag} cannot be promoted:`);
    for (const p of verdict.problems) console.error(`  - ${p}`);
    process.exit(1);
  }

  const tag = verdict.stableTag;
  const steps = [
    ['git', ['tag', tag, facts.head]],
    ['git', ['push', remote, `refs/tags/${tag}`]],
  ];
  console.error(
    `promote-beta: ${betaTag} (${facts.betaCommit.slice(0, 9)}) -> ${tag} at ${facts.head.slice(0, 9)}; ` +
      `changed since the beta: ${facts.changed.join(', ')}`
  );
  if (dryRun) {
    console.error('promote-beta: --dry-run — every check passed. Would run:');
    for (const [c, a] of steps) console.error(`  ${c} ${a.join(' ')}`);
    process.exit(0);
  }
  for (const [c, a] of steps) {
    const r = spawnSync(c, a, { cwd, stdio: 'inherit' });
    if (r.status !== 0) {
      console.error(`promote-beta: \`${c} ${a.join(' ')}\` failed (exit ${r.status}).`);
      process.exit(1);
    }
  }
  console.error(`promote-beta: pushed ${tag}. The Release workflow is building it now: gh run list --workflow release.yml`);
}
