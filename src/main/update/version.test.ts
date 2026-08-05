// P2-E19-03's done-when, first half: "version compare handles `v`-prefix and
// 3-vs-4-part forms (unit-tested)".
//
// This is the function that decides whether a dialog appears in front of every
// install, so the cases below are deliberately the ugly ones — a `v`, a fourth
// part, a pre-release tail, and the strings that are not versions at all.
import { describe, it, expect } from 'vitest';
import { compareVersions, isNewerVersion, normalizeVersion, parseVersion } from './version';

describe('parseVersion', () => {
  it('strips a v prefix, either case, and surrounding whitespace', () => {
    expect(parseVersion('v1.2.3')?.parts).toEqual([1, 2, 3]);
    expect(parseVersion('V1.2.3')?.parts).toEqual([1, 2, 3]);
    expect(parseVersion('  v1.2.3  ')?.parts).toEqual([1, 2, 3]);
  });

  it('reads any number of parts — 1, 3 and 4 are all real tags', () => {
    expect(parseVersion('2')?.parts).toEqual([2]);
    expect(parseVersion('0.1.0')?.parts).toEqual([0, 1, 0]);
    expect(parseVersion('0.1.0.7')?.parts).toEqual([0, 1, 0, 7]);
  });

  it('splits off a pre-release tail and lower-cases it', () => {
    expect(parseVersion('1.0.0-Beta.2')).toEqual({ parts: [1, 0, 0], prerelease: 'beta.2' });
  });

  it('drops +build metadata, which semver excludes from precedence', () => {
    expect(parseVersion('1.0.0+20260805')).toEqual({ parts: [1, 0, 0], prerelease: '' });
    expect(parseVersion('1.0.0-rc.1+abc')).toEqual({ parts: [1, 0, 0], prerelease: 'rc.1' });
  });

  it('returns null — never a zero — for anything that is not a version', () => {
    // A zero here would mean "older than everything", i.e. a real release
    // silently never offered. Null makes the checker SKIP it instead.
    for (const bad of ['', '   ', 'v', 'latest', '1.x.0', 'nightly-2026', 'v-1.0']) {
      expect(parseVersion(bad), bad).toBeNull();
    }
    expect(parseVersion(undefined)).toBeNull();
    expect(parseVersion(null)).toBeNull();
    expect(parseVersion(42 as unknown as string)).toBeNull();
  });
});

describe('compareVersions', () => {
  it('compares numerically, not as text (the 9-vs-10 trap)', () => {
    expect(compareVersions('0.9.0', '0.10.0')).toBe(-1);
    expect(compareVersions('1.2.10', '1.2.9')).toBe(1);
  });

  it('ignores a v prefix on either side', () => {
    expect(compareVersions('v0.2.0', '0.2.0')).toBe(0);
    expect(compareVersions('0.2.0', 'v0.1.9')).toBe(1);
  });

  it('treats missing trailing parts as zero — 3 vs 4 parts', () => {
    expect(compareVersions('0.2.0', '0.2.0.0')).toBe(0);
    expect(compareVersions('0.2.0.1', '0.2.0')).toBe(1);
    expect(compareVersions('0.2.0', '0.2.0.1')).toBe(-1);
    expect(compareVersions('0.2', '0.2.0.0')).toBe(0);
  });

  it('ranks a pre-release BELOW the release it precedes (semver §11)', () => {
    expect(compareVersions('1.0.0-beta', '1.0.0')).toBe(-1);
    expect(compareVersions('1.0.0', '1.0.0-beta')).toBe(1);
    expect(compareVersions('1.0.0-alpha', '1.0.0-beta')).toBe(-1);
    expect(compareVersions('1.0.0-alpha.1', '1.0.0-alpha.2')).toBe(-1);
    // fewer identifiers ranks lower when they are otherwise equal
    expect(compareVersions('1.0.0-alpha', '1.0.0-alpha.1')).toBe(-1);
    // numeric identifiers rank below alphanumeric ones
    expect(compareVersions('1.0.0-1', '1.0.0-alpha')).toBe(-1);
    // and numeric ones compare numerically, not as text
    expect(compareVersions('1.0.0-rc.9', '1.0.0-rc.10')).toBe(-1);
  });

  it('is null when either side is unreadable', () => {
    expect(compareVersions('1.0.0', 'nightly')).toBeNull();
    expect(compareVersions('nightly', '1.0.0')).toBeNull();
  });
});

describe('isNewerVersion (the one the dialog hangs on)', () => {
  it('offers a genuinely newer build', () => {
    expect(isNewerVersion('v0.2.0', '0.1.0')).toBe(true);
    expect(isNewerVersion('0.1.0.1', '0.1.0')).toBe(true);
  });

  it('does not offer the same build, or an older one', () => {
    expect(isNewerVersion('v0.1.0', '0.1.0')).toBe(false);
    expect(isNewerVersion('0.0.9', '0.1.0')).toBe(false);
    expect(isNewerVersion('1.0.0-beta', '1.0.0')).toBe(false);
  });

  it('STAYS QUIET when it cannot read a version — the fail-safe direction', () => {
    expect(isNewerVersion('nightly', '0.1.0')).toBe(false);
    expect(isNewerVersion('0.2.0', 'unknown')).toBe(false);
  });
});

describe('normalizeVersion', () => {
  it('is what the dialog and the skip list agree on', () => {
    expect(normalizeVersion('v0.2.0')).toBe('0.2.0');
    expect(normalizeVersion('0.2.0+abc')).toBe('0.2.0');
    expect(normalizeVersion('v1.0.0-rc.1')).toBe('1.0.0-rc.1');
  });

  it('hands back an unreadable tag trimmed, rather than losing it', () => {
    expect(normalizeVersion('  nightly  ')).toBe('nightly');
  });
});
