// Version comparison for the update check (P2-E19-03).
//
// Lives in main, not shared, on purpose: E19-03 says the comparison happens in
// main. The renderer is handed a verdict, never the arithmetic — which is what
// keeps "is there a newer build" a single answer instead of two implementations
// that can disagree.
//
// What it has to survive is the ordinary mess of real tags:
//   • a `v` prefix, or not: GitHub tags are `v0.2.0`, package.json is `0.2.0`
//   • 3 parts vs 4: `0.2.0` against `0.2.0.1` (the shape a Windows build number
//     arrives in, and the one that makes a naive string compare wrong)
//   • pre-release suffixes: semver says `1.0.0-beta` is BELOW `1.0.0`, which is
//     the opposite of what comparing the strings gives you
//   • whitespace, and `V` — release tooling is typed by humans

/** A tag or version string, split into what can be compared. */
export interface ParsedVersion {
  /** numeric parts, in order, `v` stripped. At least one. */
  parts: number[];
  /** the `-beta.2` tail, lower-cased, or '' for a plain release */
  prerelease: string;
}

/**
 * Parse a version, or null if it is not one.
 *
 * Null rather than a throw, and null rather than a zero: an unparseable tag
 * must make the checker SKIP that release, never treat it as version 0 (which
 * would silently mean "older than everything" — a real release quietly
 * ignored) and never take the app down.
 */
export function parseVersion(raw: string | undefined | null): ParsedVersion | null {
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  if (!s) return null;
  if (s[0] === 'v' || s[0] === 'V') s = s.slice(1);
  // `+build` metadata is explicitly NOT part of precedence in semver; drop it
  const plus = s.indexOf('+');
  if (plus >= 0) s = s.slice(0, plus);
  const dash = s.indexOf('-');
  const prerelease = dash >= 0 ? s.slice(dash + 1).toLowerCase() : '';
  const core = dash >= 0 ? s.slice(0, dash) : s;
  if (!core) return null;
  const parts: number[] = [];
  for (const chunk of core.split('.')) {
    // A non-numeric part makes the whole thing unparseable rather than
    // truncating at it: `1.x.0` is not "version 1", it is a string we do not
    // understand, and guessing is how a checker offers the wrong build.
    if (!/^\d+$/.test(chunk)) return null;
    parts.push(Number(chunk));
  }
  return parts.length ? { parts, prerelease } : null;
}

/**
 * -1 / 0 / 1, comparing `a` to `b`. Missing trailing parts count as zero, so
 * `0.2.0` and `0.2.0.0` are equal and `0.2.0.1` is greater than both.
 */
export function compareParsed(a: ParsedVersion, b: ParsedVersion): number {
  const len = Math.max(a.parts.length, b.parts.length);
  for (let i = 0; i < len; i++) {
    const x = a.parts[i] ?? 0;
    const y = b.parts[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  // semver §11: a version WITH a pre-release tail precedes the same version
  // without one. Between two tails, dotted identifiers compare left to right,
  // numeric ones numerically and the rest as text.
  if (!a.prerelease && !b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  const ai = a.prerelease.split('.');
  const bi = b.prerelease.split('.');
  for (let i = 0; i < Math.max(ai.length, bi.length); i++) {
    const x = ai[i];
    const y = bi[i];
    if (x === undefined) return -1; // a shorter set of identifiers is lower
    if (y === undefined) return 1;
    if (x === y) continue;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) return Number(x) < Number(y) ? -1 : 1;
    if (xn !== yn) return xn ? -1 : 1; // numeric identifiers rank below text
    return x < y ? -1 : 1;
  }
  return 0;
}

/** -1 / 0 / 1, or null when either side is not a version we understand. */
export function compareVersions(a: string, b: string): number | null {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return null;
  return compareParsed(pa, pb);
}

/**
 * Is `candidate` a build we should offer over `current`?
 *
 * FALSE when either side is unparseable — the fail-safe direction. A checker
 * that cannot read a tag must stay quiet, not offer a download it cannot
 * reason about.
 */
export function isNewerVersion(candidate: string, current: string): boolean {
  return compareVersions(candidate, current) === 1;
}

/** The comparable form: `v` and build metadata gone, otherwise as written. */
export function normalizeVersion(raw: string): string {
  const parsed = parseVersion(raw);
  if (!parsed) return raw.trim();
  return parsed.parts.join('.') + (parsed.prerelease ? `-${parsed.prerelease}` : '');
}
