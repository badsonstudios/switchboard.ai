import { describe, it, expect } from 'vitest';
import {
  BuildIdentity,
  UNKNOWN_BUILD_IDENTITY,
  buildAge,
  buildIdentity,
  commitStamp,
  isReleaseBuild,
  normalizeIdentity,
  windowTitle,
} from './build-identity';

const id = (over: Partial<BuildIdentity> = {}): BuildIdentity => ({
  commit: 'a1b2c3d4',
  branch: 'main',
  dirty: false,
  builtAt: '2026-08-02T10:00:00.000Z',
  ...over,
});

describe('build identity (P2-E15-15)', () => {
  describe('buildIdentity()', () => {
    it('degrades to all-unknown when no define was injected (vitest, tarball builds)', () => {
      // this test file is not bundled, so __SWITCHBOARD_BUILD__ does not exist —
      // which is exactly the fail-open path a `define`-less consumer must take
      expect(buildIdentity()).toEqual(UNKNOWN_BUILD_IDENTITY);
    });
  });

  describe('normalizeIdentity()', () => {
    it('passes a well-formed identity through', () => {
      expect(normalizeIdentity(id())).toEqual(id());
    });

    it('treats junk, null and empty strings as unknown rather than rendering them', () => {
      expect(normalizeIdentity(null)).toEqual(UNKNOWN_BUILD_IDENTITY);
      expect(normalizeIdentity('a1b2c3d4')).toEqual(UNKNOWN_BUILD_IDENTITY);
      expect(normalizeIdentity({ commit: '', branch: 42, dirty: 'yes', builtAt: undefined })).toEqual(
        UNKNOWN_BUILD_IDENTITY
      );
    });

    it('only a literal true is dirty — a truthy string must not flip the warning on', () => {
      expect(normalizeIdentity({ ...id(), dirty: 'false' }).dirty).toBe(false);
      expect(normalizeIdentity({ ...id(), dirty: true }).dirty).toBe(true);
    });
  });

  describe('commitStamp()', () => {
    it('marks a dirty tree with a star and leaves a clean one bare', () => {
      expect(commitStamp(id())).toBe('a1b2c3d4');
      expect(commitStamp(id({ dirty: true }))).toBe('a1b2c3d4*');
    });

    it('returns null (not the word "unknown") when git was unavailable, so the caller translates', () => {
      expect(commitStamp(id({ commit: null }))).toBeNull();
    });
  });

  describe('isReleaseBuild()', () => {
    it('is true only for a clean, identified main build', () => {
      expect(isReleaseBuild(id())).toBe(true);
      expect(isReleaseBuild(id({ dirty: true }))).toBe(false);
      expect(isReleaseBuild(id({ branch: 'feature/172-app-version-identity' }))).toBe(false);
      expect(isReleaseBuild(id({ branch: null }))).toBe(false);
      expect(isReleaseBuild(id({ commit: null }))).toBe(false);
    });
  });

  describe('windowTitle()', () => {
    it('stays the bare app name on a clean main build — no noise for the normal case', () => {
      expect(windowTitle('switchboard', id())).toBe('switchboard');
    });

    it('names the branch and commit on a feature build', () => {
      expect(windowTitle('switchboard', id({ branch: 'feature/172-app-version-identity' }))).toBe(
        'switchboard — feature/172-app-version-identity · a1b2c3d4'
      );
    });

    it('stars a dirty main build rather than passing it off as a release', () => {
      expect(windowTitle('switchboard', id({ dirty: true }))).toBe('switchboard — main · a1b2c3d4*');
    });

    it('says detached when there is a commit but no branch', () => {
      expect(windowTitle('switchboard', id({ branch: null }))).toBe(
        'switchboard — detached · a1b2c3d4'
      );
    });

    it('says so when git told us nothing at all', () => {
      expect(windowTitle('switchboard', UNKNOWN_BUILD_IDENTITY)).toBe('switchboard — unknown build');
    });
  });

  describe('buildAge() — the field that actually catches a stale out/ build', () => {
    const at = (iso: string): Date => new Date(iso);

    it('is null when there is no build time to measure', () => {
      expect(buildAge(null)).toBeNull();
      expect(buildAge('not a date')).toBeNull();
    });

    it('reports the largest unit that still reads sensibly', () => {
      const built = '2026-08-02T10:00:00.000Z';
      expect(buildAge(built, at('2026-08-02T10:00:30.000Z'))).toEqual({ unit: 'now', value: 0 });
      expect(buildAge(built, at('2026-08-02T10:07:00.000Z'))).toEqual({ unit: 'minutes', value: 7 });
      expect(buildAge(built, at('2026-08-02T13:30:00.000Z'))).toEqual({ unit: 'hours', value: 3 });
      expect(buildAge(built, at('2026-08-06T10:00:00.000Z'))).toEqual({ unit: 'days', value: 4 });
    });

    it('clamps a future build time to "just now" instead of counting backwards', () => {
      expect(buildAge('2026-08-02T12:00:00.000Z', at('2026-08-02T10:00:00.000Z'))).toEqual({
        unit: 'now',
        value: 0,
      });
    });

    it('crosses each boundary at the right minute', () => {
      const built = '2026-08-02T10:00:00.000Z';
      expect(buildAge(built, at('2026-08-02T10:59:00.000Z'))?.unit).toBe('minutes');
      expect(buildAge(built, at('2026-08-02T11:00:00.000Z'))?.unit).toBe('hours');
      expect(buildAge(built, at('2026-08-03T09:59:00.000Z'))?.unit).toBe('hours');
      expect(buildAge(built, at('2026-08-03T10:00:00.000Z'))?.unit).toBe('days');
    });
  });
});
