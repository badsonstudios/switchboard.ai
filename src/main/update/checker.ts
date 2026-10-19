// The update check itself (P2-E19-03, plan §E19).
//
// One function, one network call, one plain result record — the `preflight.ts`
// shape. It reports facts; what to DO about them is `service.ts`, and what the
// user reads is the renderer's.
//
// ── THE ONE HARD PROBLEM, and why the endpoint is what it is ────────────────
//
// The repo is PRIVATE. GitHub answers **404** both for "you may not see this
// repo" and for "this repo has no `latest` release", and ClaudeMon's checker —
// which asked `/releases/latest` anonymously — read that 404 as "no releases,
// you're up to date" and would have said so forever (plan §E19 decision 5).
//
// So we do not ask that question. We ask `GET /repos/{owner}/{repo}/releases`,
// whose two answers are genuinely different:
//
//   • **200 with `[]`** — we can see the repo, and it has no releases yet.
//     That is honestly "nothing to offer".
//   • **404** — we cannot see the repo at all. That is an AUTH problem, and it
//     is reported as one. Never as up to date.
//
// The list endpoint costs one extra decision (pick `latest` ourselves, below)
// and buys the distinction the item's done-when asks for.
//
// ── what this may talk to ───────────────────────────────────────────────────
//
// The GitHub API host, for this repo's releases, and nothing else (PHILOSOPHY
// local-first; §E19's own note). No telemetry, no version-ping, no analytics.
import { errorText } from '../../shared/error-text';
import { UpdateCheckResult, UpdateFailureReason } from '../../shared/update';
import { compareParsed, isNewerVersion, normalizeVersion, parseVersion } from './version';
import { resolveUpdateToken, TokenSource } from './token';
import { pickInstallerAsset } from './install';

/**
 * The feed. Hard-coded rather than read from package.json's `repository`,
 * which this project deliberately does not set — electron-builder infers a
 * publish target from that field, and #257 owns packaging's configuration.
 */
// One page of 30, newest-created first. Betas (#1380) count toward the 30, so a
// burst of them pushes the oldest entries off the page — harmless at this
// project's release rate, and only ever the OLDEST notes in a long rollup.
export const RELEASES_ENDPOINT =
  'https://api.github.com/repos/badsonstudios/switchboard.ai/releases?per_page=30';

/** How long the API gets before we give up and call it a network failure. */
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Release bodies are rendered in-app, so they are also an input. A tag with a
 * megabyte of body in it should make the dialog boring, not the renderer sad.
 */
const MAX_NOTES_CHARS = 20_000;

/** The subset of GitHub's release object this cares about. */
interface GithubRelease {
  tag_name?: unknown;
  name?: unknown;
  body?: unknown;
  html_url?: unknown;
  draft?: unknown;
  prerelease?: unknown;
  published_at?: unknown;
  /** E19-04: the installer and its `.sha256`, when the release has both */
  assets?: unknown;
}

export interface CheckDeps {
  /** package.json semver of the running build (`app.getVersion()`) */
  currentVersion: string;
  /** overridable for tests and for the dev/test feed seam */
  endpoint?: string;
  /** injected in unit tests; defaults to the runtime's own fetch */
  fetchImpl?: typeof fetch;
  /** injected in unit tests; defaults to the §E19 resolution order */
  tokenSources?: TokenSource[];
  /**
   * Skip token resolution entirely. Set by the dev/test feed seam, where the
   * feed is a local stub that wants no credentials — and where reaching for
   * `gh auth token` would be a live call to a real credential store from a
   * test.
   */
  skipToken?: boolean;
  now?: () => Date;
  /** debug/warn only; the update path never reports itself to the user */
  log?: (msg: string, meta?: Record<string, unknown>) => void;
  /** which platform's installer to look for (E19-04). Defaults to the real one. */
  platform?: NodeJS.Platform;
  /**
   * Settings ▸ Updates ▸ "Get beta releases" (#1380). Off — the default, and
   * what an absent value means — pre-releases are never offered, exactly as
   * before the setting existed.
   */
  includePrereleases?: boolean;
}

/** Which releases are eligible at all (#1380). */
export interface ChannelOpts {
  includePrereleases?: boolean;
}

function fail(
  currentVersion: string,
  checkedAt: string,
  state: 'failed' | 'disabled',
  reason: UpdateFailureReason
): UpdateCheckResult {
  return { ok: false, state, currentVersion, reason, checkedAt };
}

/**
 * Ask the feed whether there is a newer build. Never throws.
 *
 * The result is a record in every case, including the ones that are nobody's
 * fault: no token, no network, no releases.
 */
export async function checkForUpdate(deps: CheckDeps): Promise<UpdateCheckResult> {
  const now = deps.now ?? (() => new Date());
  const checkedAt = now().toISOString();
  const currentVersion = deps.currentVersion;
  const endpoint = deps.endpoint ?? RELEASES_ENDPOINT;
  const doFetch = deps.fetchImpl ?? globalThis.fetch;

  if (typeof doFetch !== 'function') {
    // Should be unreachable on Node 22 / Electron; a missing fetch is still a
    // record, not a TypeError escaping into the startup path.
    return fail(currentVersion, checkedAt, 'failed', 'network');
  }

  let token: string | null = null;
  if (!deps.skipToken) {
    const resolved = await resolveUpdateToken(deps.tokenSources);
    token = resolved.token;
    if (!token) {
      // THE done-when, verbatim: with no token the app behaves identically to
      // today — no dialog, no error, ONE debug line.
      deps.log?.('update check disabled: no token could be resolved locally');
      return fail(currentVersion, checkedAt, 'disabled', 'no-token');
    }
  }

  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    // GitHub requires a User-Agent and rejects requests without one.
    'user-agent': `switchboard.ai/${currentVersion}`,
  };
  if (token) headers.authorization = `Bearer ${token}`;

  // AbortController rather than a bare race: a check that has given up must
  // also stop the socket, or a dead feed leaks one connection per day.
  //
  // The deadline covers the BODY, not just the headers, and that is the whole
  // point of where `clearTimeout` sits. A server that answers 200 and then
  // stalls the body would otherwise leave `res.json()` pending forever — and
  // because the service caches its in-flight promise, every later check
  // (including a manual one) would join that same promise and never resolve.
  // Update checks would silently stop working for the life of the process,
  // with no log line to say why.
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), REQUEST_TIMEOUT_MS);
  try {
    let res: Response;
    try {
      res = await doFetch(endpoint, { headers, signal: abort.signal, redirect: 'follow' });
    } catch (err) {
      deps.log?.('update check could not reach the release host', { error: errorText(err) });
      return fail(currentVersion, checkedAt, 'failed', 'network');
    }

    if (!res.ok) {
      const reason = statusReason(res);
      deps.log?.('update check refused by the release host', { status: res.status, reason });
      return fail(currentVersion, checkedAt, 'failed', reason);
    }

    let body: unknown;
    try {
      body = await res.json();
    } catch (err) {
      // An aborted body read lands here too, which is right: a feed that stops
      // mid-answer told us nothing usable.
      deps.log?.('update check got a response it could not read', { error: errorText(err) });
      return fail(currentVersion, checkedAt, 'failed', 'bad-response');
    }
    if (!Array.isArray(body)) {
      deps.log?.('update check got a non-list from the releases endpoint');
      return fail(currentVersion, checkedAt, 'failed', 'bad-response');
    }
    return decide(body as GithubRelease[], currentVersion, checkedAt, deps);
  } finally {
    clearTimeout(timer);
  }
}

/** The comparison, once a list is in hand. Split out to keep the timer scope tidy. */
function decide(
  body: GithubRelease[],
  currentVersion: string,
  checkedAt: string,
  deps: CheckDeps
): UpdateCheckResult {
  const channel: ChannelOpts = { includePrereleases: deps.includePrereleases === true };
  const best = pickLatest(body, deps.log, channel);
  if (!best) {
    // 200 and nothing eligible: we can SEE the repo, it has published nothing
    // we would offer. This is the branch the 404 must never be confused with.
    return { ok: true, state: 'up-to-date', currentVersion, checkedAt };
  }

  const latestVersion = normalizeVersion(String(best.tag_name));
  if (!isNewerVersion(latestVersion, currentVersion)) {
    return { ok: true, state: 'up-to-date', currentVersion, latestVersion, checkedAt };
  }
  // E19-04. Optional by design: a release with no verifiable installer is
  // still an offer — the dialog just falls back to opening its page in the
  // browser, which is exactly what E19-03 shipped.
  const download = pickInstallerAsset(best.assets, deps.platform) ?? undefined;
  return {
    ok: true,
    state: 'available',
    currentVersion,
    latestVersion,
    notes: notesSince(body, currentVersion, channel),
    url: typeof best.html_url === 'string' ? best.html_url : undefined,
    publishedAt: typeof best.published_at === 'string' ? best.published_at : undefined,
    checkedAt,
    // #1380: the dialog labels a beta as a beta. Only ever true on the beta
    // channel — with it off, `pickLatest` never returns one.
    ...(isPrerelease(best) ? { prerelease: true } : {}),
    ...(download ? { download } : {}),
  };
}

/**
 * Is this release a pre-release (#1380)?
 *
 * EITHER signal counts: GitHub's flag, or a semver suffix on the tag. The flag
 * is what the release workflow sets for a beta; the suffix is the belt to its
 * braces — a `v0.8.125-beta.1` somebody published by hand without ticking
 * "pre-release" is still a beta, and a stable-channel install must not be
 * offered it. (Before #1380 only the flag was read.)
 */
function isPrerelease(r: GithubRelease): boolean {
  if (r.prerelease === true) return true;
  return typeof r.tag_name === 'string' && (parseVersion(r.tag_name)?.prerelease ?? '') !== '';
}

/**
 * May this release be offered at all? Not a draft, a readable tag, and — off
 * the beta channel — not a pre-release. Shared by `pickLatest` and
 * `notesSince` so the notes can never describe a release we would not install.
 */
function eligible(r: GithubRelease, channel: ChannelOpts): r is GithubRelease & { tag_name: string } {
  if (!r || typeof r !== 'object') return false;
  if (r.draft === true) return false;
  if (typeof r.tag_name !== 'string' || !parseVersion(r.tag_name)) return false;
  return channel.includePrereleases === true || !isPrerelease(r);
}

/**
 * Which failure a non-2xx is.
 *
 * **404 is `auth`** — the whole point (decision 5). 401/403 are the same
 * family; a 403 with the rate-limit counter at zero is the one case worth
 * telling apart, because "ask again tomorrow" is genuinely different advice
 * from "your token cannot see this repo".
 */
export function statusReason(res: {
  status: number;
  headers: { get(name: string): string | null };
}): UpdateFailureReason {
  if (res.status === 429) return 'rate-limit';
  if (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0') return 'rate-limit';
  if (res.status === 401 || res.status === 403 || res.status === 404) return 'auth';
  return 'bad-response';
}

/**
 * The release we would offer: the highest version among the published
 * entries — non-pre-release ones only, unless the install is on the beta
 * channel (#1380, `eligible`).
 *
 * Highest VERSION rather than "the first one GitHub listed": the list is
 * ordered by creation date, and a re-published or back-dated older release
 * would otherwise be offered as an upgrade. Drafts are excluded because drafts
 * are §E19's staging mechanism — a draft is a release nobody has decided to
 * ship yet, and offering one to every install is the failure the notes-required
 * gate in #258 exists to prevent, arriving by another door.
 *
 * Exported for its own unit tests.
 */
export function pickLatest(
  releases: GithubRelease[],
  log?: (msg: string, meta?: Record<string, unknown>) => void,
  channel: ChannelOpts = {}
): GithubRelease | null {
  let best: GithubRelease | null = null;
  let skipped = 0;
  for (const r of releases) {
    if (!r || typeof r !== 'object') continue;
    // counted only for the log line; `eligible` is what decides
    if (r.draft !== true && typeof r.tag_name === 'string' && !parseVersion(r.tag_name)) skipped++;
    if (!eligible(r, channel)) continue;
    // Newest by semver, whichever channel it came from: on the beta channel a
    // stable `0.8.125` beats `0.8.125-beta.2` (semver §11), which is how a
    // beta install moves onto the stable release the day it ships.
    if (!best || isNewerVersion(r.tag_name, String(best.tag_name))) best = r;
  }
  if (skipped) log?.('update check skipped releases with unreadable tags', { skipped });
  return best;
}

/** `0.8.125-beta.2` and `v0.8.125` share a core: the numbers, suffix ignored. */
function sameCore(a: string, b: string): boolean {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return false;
  return compareParsed({ parts: pa.parts, prerelease: '' }, { parts: pb.parts, prerelease: '' }) === 0;
}

/** One release's own notes, trimmed; '' when it has none. */
function bodyOf(r: GithubRelease): string {
  return typeof r.body === 'string' ? r.body.trim() : '';
}

/**
 * EVERYTHING that changed since the running version — not just the newest
 * release's notes.
 *
 * Each release carries only its own changelog section (a published version is
 * never rolled into the next one — `scripts/release-notes.js`). So an install
 * that skips a release, which is every install that is not updated the same
 * hour, used to be shown the newest release's notes alone: the owner went from
 * 0.8.92 to 0.8.94 and saw one bug fix, while the four features 0.8.93 shipped
 * were in the installer and nowhere in the dialog.
 *
 * Every offerable release newer than the running build, NEWEST first, each
 * under its own version heading. One release reads exactly as before — no
 * heading, just its notes — because a heading repeating the version the dialog
 * already names is noise. Same eligibility as `pickLatest` (no drafts,
 * readable tags, pre-releases only on the beta channel), so the notes can never describe a release we
 * would not install. A release with no notes adds nothing rather than an empty
 * heading.
 *
 * Bounded by MAX_NOTES_CHARS in total: whole sections are added newest-first
 * while they fit, and the first one that does not ends the list with `…`. The
 * newest section alone is cut at the cap, as before. The endpoint's page of 30
 * also bounds how far back this can reach — a machine 30 releases behind has
 * bigger news than the oldest notes.
 *
 * Exported for its own unit tests.
 */
export function notesSince(
  releases: GithubRelease[],
  currentVersion: string,
  channel: ChannelOpts = {}
): string {
  const newer = releases
    .filter(
      (r): r is GithubRelease & { tag_name: string } =>
        eligible(r, channel) && isNewerVersion(r.tag_name, currentVersion)
    )
    .sort((a, b) => (isNewerVersion(a.tag_name, b.tag_name) ? -1 : isNewerVersion(b.tag_name, a.tag_name) ? 1 : 0))
    // ONE entry per CORE version, the newest of them (#1380). A beta ships the
    // upcoming version's changelog section as it stands, so `0.8.125-beta.1`,
    // `-beta.2` and `0.8.125` carry the same notes, each a superset of the
    // last: listing all three would print the same section three times. The
    // newest one (the stable, once it exists) says everything. This also folds
    // `v0.8.94` and `0.8.94` into one, as before.
    .filter((r, i, all) => i === 0 || !sameCore(r.tag_name, all[i - 1].tag_name));

  // The no-heading shortcut is decided on the releases BEFORE the bodyless ones
  // are dropped: otherwise a newest release with no notes and an older one with
  // some would show the OLDER notes, unlabelled, under the newer version's name.
  if (newer.length === 1) {
    const only = bodyOf(newer[0]);
    return only.length > MAX_NOTES_CHARS ? `${only.slice(0, MAX_NOTES_CHARS)}\n\n…` : only;
  }
  const withNotes = newer.filter((r) => bodyOf(r) !== '');
  if (withNotes.length === 0) return '';

  const parts: string[] = [];
  let used = 0;
  for (const r of withNotes) {
    const section = `## v${normalizeVersion(r.tag_name)}\n\n${bodyOf(r)}`;
    const cost = section.length + (parts.length ? 2 : 0);
    if (used + cost > MAX_NOTES_CHARS) {
      if (parts.length === 0) return `${section.slice(0, MAX_NOTES_CHARS)}\n\n…`;
      parts.push('…');
      break;
    }
    parts.push(section);
    used += cost;
  }
  return parts.join('\n\n');
}
