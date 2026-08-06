// P2-E19-02 — the release gate: everything the release workflow decides, in
// Node, where it can be unit-tested.
//
// The alternative was shell inside release.yml, and that is exactly the shape
// of code that gets debugged by pushing tags. This file's three decisions are
// each a way a release goes wrong quietly:
//
//  1. The tag must equal package.json's version. `v0.2.0` cut from a tree that
//     still says 0.1.0 produces an installer named for one version, offered
//     under another — and E19-03's update check compares those two strings.
//  2. A version with no CHANGELOG.md section is a HARD FAIL, not an empty
//     release. ClaudeMon's rule, carried over verbatim: the updater offers
//     every release to every user, so an empty one is a dialog with nothing in
//     it, shown to everybody. (E19-03 renders this body in-app.)
//  3. Older changelog versions that were never published get rolled INTO these
//     notes. A skipped release otherwise means shipped work that is invisible
//     on the releases page forever — nobody goes back to fix a release from
//     three tags ago.
//
// Reference: C:\Projects\ClaudeMon\.claude\scripts\publish-release.sh (the
// awk/gh original this ports). What changed on the way over: the version comes
// from package.json rather than a .csproj, the published-set is ONE `gh release
// list` call instead of an N+1 of `gh release view`, and "already released" is
// no longer a silent no-op — see decideAction.
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

/** Thrown for every condition that must stop a release. Never caught in-process. */
class ReleaseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ReleaseError';
  }
}

const SEMVER = String.raw`\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?`;

/**
 * A version heading in CHANGELOG.md. Two hashes, then a semver, optionally
 * bracketed:
 *
 *   `## 0.1.0 — unreleased`     this repo's convention (CHANGELOG.md, E19-01)
 *   `## [0.1.0] - 2026-08-05`   keep-a-changelog / ClaudeMon's shape
 *
 * Deliberately does NOT match `## The version, and how it moves` (prose
 * headings share the file) nor `### Added` (three hashes is a group inside a
 * section, and swallowing those would end every section after one line).
 */
const VERSION_HEADING = new RegExp(String.raw`^## \[?(${SEMVER})\]?(?=$|[\s\]])`);

/** any `## ` heading — what ends a section, version or prose alike */
const ANY_H2 = /^## /;

const ROLLUP_PREAMBLE =
  'This release also rolls up previously unpublished changelog versions — ' +
  'their GitHub releases were never created, so their notes are included below.';

/** @param {string} line */
function versionOf(line) {
  const m = VERSION_HEADING.exec(line);
  return m ? m[1] : null;
}

/**
 * Every version in CHANGELOG.md, in FILE ORDER — which the file's own
 * convention makes newest-first. Duplicates collapse to their first
 * appearance, the same one extractSection reads.
 *
 * @param {string} changelog
 * @returns {string[]}
 */
function listVersions(changelog) {
  const out = [];
  for (const line of changelog.split(/\r?\n/)) {
    const v = versionOf(line);
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

/** blank lines off both ends, plus a trailing horizontal rule */
function trimEdges(lines) {
  const blank = (l) => l.trim() === '';
  // `---` between sections belongs to neither of them; CHANGELOG.md already
  // uses one to close its prose preamble.
  const rule = (l) => /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(l);
  let a = 0;
  let b = lines.length;
  while (a < b && blank(lines[a])) a++;
  while (b > a && (blank(lines[b - 1]) || rule(lines[b - 1]))) b--;
  return lines.slice(a, b);
}

/**
 * The heading line for a version, or null if the file has no section for it.
 * @param {string} changelog
 * @param {string} version
 */
function headingFor(changelog, version) {
  return changelog.split(/\r?\n/).find((l) => versionOf(l) === version) ?? null;
}

/**
 * The BODY of a version's section: everything between its heading and the next
 * `## `, trimmed.
 *
 * `null` means "no such section" and `''` means "a heading with nothing under
 * it". Both are fatal to a release, but they are different mistakes and the
 * error messages say so.
 *
 * @param {string} changelog
 * @param {string} version
 * @returns {string | null}
 */
function extractSection(changelog, version) {
  const lines = changelog.split(/\r?\n/);
  let i = lines.findIndex((l) => versionOf(l) === version);
  if (i === -1) return null;
  const body = [];
  for (i += 1; i < lines.length; i++) {
    if (ANY_H2.test(lines[i])) break;
    body.push(lines[i]);
  }
  return trimEdges(body).join('\n');
}

/**
 * The tag a ref names, or null when the ref is not a tag at all.
 *
 * Accepts what the workflow passes (`github.ref`, i.e. `refs/tags/v0.1.0` on a
 * tag push and `refs/heads/<branch>` on a workflow_dispatch) and what a human
 * types when running this by hand (`v0.1.0`).
 *
 * @param {string | undefined | null} ref
 * @returns {string | null}
 */
function tagFromRef(ref) {
  if (!ref) return null;
  if (ref.startsWith('refs/tags/')) return ref.slice('refs/tags/'.length);
  if (ref.startsWith('refs/')) return null; // refs/heads/*, refs/pull/* — a dispatch
  return /^v?\d+\.\d+\.\d+/.test(ref) ? ref : null;
}

/**
 * Reconcile the ref with package.json's version.
 *
 * The canonical tag is ALWAYS `v<version>` — package.json is the single source
 * of the release number (CHANGELOG.md says so), so a tag is only ever allowed
 * to agree with it. A leading `v` is optional on the way in and mandatory on
 * the way out.
 *
 * @param {{ref?: string | null, version: string}} args
 * @returns {{tag: string, version: string, fromTag: boolean}}
 */
function resolveRelease({ ref, version }) {
  const tag = `v${version}`;
  const pushed = tagFromRef(ref);
  if (pushed === null) return { tag, version, fromTag: false };
  if (pushed.replace(/^v/, '') !== version) {
    throw new ReleaseError(
      `tag ${pushed} does not match package.json version ${version}. ` +
        'The version and its changelog section are meant to land in one commit ' +
        'and be tagged from it — bump package.json, or tag the right commit.'
    );
  }
  return { tag, version, fromTag: true };
}

/**
 * Assemble the release body.
 *
 * @param {object} args
 * @param {string} args.changelog          CHANGELOG.md's contents
 * @param {string} args.version            the version being released
 * @param {(v: string) => boolean} args.isPublished
 *        whether an OLDER version already has a GitHub release. Injected so the
 *        rollup rule is testable without a network; the CLI supplies one backed
 *        by `gh release list`.
 * @returns {{notes: string, rolledUp: string[]}}
 */
function buildNotes({ changelog, version, isPublished }) {
  const section = extractSection(changelog, version);
  if (section === null) {
    throw new ReleaseError(
      `CHANGELOG.md has no section for ${version} — add one before releasing.\n` +
        '       Publishing without notes creates an empty release, and the update ' +
        'checker offers every release to every user.'
    );
  }
  if (section.trim() === '') {
    throw new ReleaseError(
      `CHANGELOG.md's section for ${version} is empty — write what changed before releasing.\n` +
        '       An empty section is an empty release dialog, shown to everybody.'
    );
  }

  const versions = listVersions(changelog);
  const older = versions.slice(versions.indexOf(version) + 1);
  const rolled = [];
  for (const v of older) {
    // The file is newest-first, so the first older version that DOES have a
    // release ends the walk: everything before it was published too.
    if (isPublished(v)) break;
    const body = extractSection(changelog, v);
    rolled.push({
      version: v,
      // A missing body cannot fail the release the way the current version's
      // does — refusing to ship 0.3.0 because 0.2.0's section is thin helps
      // nobody, and silently dropping it is the invisibility this rule exists
      // to prevent.
      body: body && body.trim() ? body : '_No notes were written for this version._',
    });
  }

  if (rolled.length === 0) return { notes: section, rolledUp: [] };

  const parts = [ROLLUP_PREAMBLE, '', section, '', '---'];
  for (const r of rolled) parts.push('', `## ${r.version} (previously unpublished)`, '', r.body);
  return { notes: parts.join('\n'), rolledUp: rolled.map((r) => r.version) };
}

/**
 * What the workflow should do with a release that may already exist.
 *
 * NOT ClaudeMon's silent `exit 0`: that script is invoked by a human who can
 * see what happened, whereas a re-run here means the first attempt failed
 * somewhere — very plausibly *between* creating the release and uploading its
 * assets, which leaves a release the updater will offer with nothing to
 * download. So a re-run converges instead: same notes, assets re-uploaded with
 * --clobber, still exactly one release. Notes are regenerated rather than
 * preserved because CHANGELOG.md at the tag is their source of truth; hand-edits
 * to a release body are not a workflow this repo supports.
 *
 * @param {{exists: boolean}} args
 * @returns {'create' | 'update'}
 */
function decideAction({ exists }) {
  return exists ? 'update' : 'create';
}

/**
 * The installer filename for a version, derived from the packaging config
 * rather than repeated here — `switchboard-Setup-<version>.exe` is a contract
 * between electron-builder, this workflow and E19-04's downloader, and three
 * copies of a string is two too many. (packaging.test.ts pins the config side.)
 *
 * @param {string} version
 * @param {string} [root]
 */
function installerName(version, root = path.join(__dirname, '..')) {
  const { nsis } = require(path.join(root, 'electron-builder.js'));
  return String(nsis.artifactName).replace(/\$\{version\}/g, version);
}

/**
 * Every tag that already has a GitHub release — drafts included, because a
 * draft exists on the releases page and rolling its notes into a later release
 * would duplicate them. (E19 keeps drafts as the staging mechanism.)
 *
 * `--limit` paginates; 200 is decades of releases at this project's rate, and
 * the only consequence of overflowing it is a rollup of ancient history, which
 * is loud rather than silent.
 */
function publishedTags(cwd) {
  let out;
  try {
    out = execFileSync('gh', ['release', 'list', '--limit', '200', '--json', 'tagName'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
    });
  } catch (err) {
    // Deliberately fatal. Guessing "nothing is published" here would roll every
    // historical version into these notes; guessing the opposite would hide a
    // skipped release. Neither is a guess worth making silently.
    throw new ReleaseError(
      `could not list existing releases (\`gh release list\`): ${err.message}\n` +
        '       The workflow needs GH_TOKEN with at least `contents: read`.'
    );
  }
  return new Set(JSON.parse(out).map((r) => r.tagName));
}

module.exports = {
  ReleaseError,
  VERSION_HEADING,
  ROLLUP_PREAMBLE,
  listVersions,
  headingFor,
  extractSection,
  tagFromRef,
  resolveRelease,
  buildNotes,
  decideAction,
  installerName,
  publishedTags,
};

// --- CLI -------------------------------------------------------------------
// Usage: node scripts/release-notes.js [--ref <git ref>] [--out <file>] [--no-rollup]
if (require.main === module) {
  const argv = process.argv.slice(2);
  const flag = (name) => {
    const i = argv.indexOf(name);
    return i === -1 ? null : (argv[i + 1] ?? '');
  };

  const root = flag('--root') || path.join(__dirname, '..');
  const outFile = flag('--out');
  // Local preview only: skip the `gh` call and assume nothing is owed a
  // rollup. The workflow never passes it — a rollup that only appears in CI is
  // precisely the surprise this script exists to prevent.
  const noRollup = argv.includes('--no-rollup');

  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
    const { tag, version, fromTag } = resolveRelease({ ref: flag('--ref'), version: pkg.version });

    // LAZY on purpose. buildNotes only consults this after the section checks,
    // so "you forgot the changelog section" is never masked by "gh could not
    // reach GitHub" — the two failures want completely different reactions, and
    // the cheap, certain one should be the one you are told about.
    let published = null;
    const isPublished = (v) => {
      if (noRollup) return true;
      published ??= publishedTags(root);
      return published.has(`v${v}`);
    };
    const { notes, rolledUp } = buildNotes({ changelog, version, isPublished });

    const heading = headingFor(changelog, version) ?? '';
    if (/unreleased/i.test(heading)) {
      // A warning, not a failure: the heading itself never reaches the notes,
      // so this is untidy rather than broken. CHANGELOG.md's "To cut a release"
      // step 2 is the thing being skipped.
      console.error(
        `::warning::CHANGELOG.md still marks ${version} as unreleased — ` +
          'replace "— unreleased" with the release date.'
      );
    }
    for (const v of rolledUp) {
      console.error(`::notice::changelog version ${v} was never published — rolling it into ${tag}.`);
    }

    const installer = installerName(version, root);
    if (outFile) {
      // The gate runs BEFORE the build, so an --out under a directory the build
      // has not created yet must still work.
      fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
      fs.writeFileSync(outFile, notes.endsWith('\n') ? notes : `${notes}\n`, 'utf8');
    }
    if (process.env.GITHUB_OUTPUT) {
      fs.appendFileSync(
        process.env.GITHUB_OUTPUT,
        `version=${version}\ntag=${tag}\ninstaller=${installer}\nfrom_tag=${fromTag}\n`
      );
    }

    console.error(`release ${tag} — installer ${installer}${fromTag ? '' : ' (not a tag ref)'}`);
    console.log(notes);
  } catch (err) {
    if (err instanceof ReleaseError) {
      console.error(`::error::${err.message.split('\n')[0]}`);
      console.error(`release-notes: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}
