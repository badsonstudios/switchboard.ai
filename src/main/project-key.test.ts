// How `~/.claude.json`'s `projects` map is keyed (#724).
//
// THE CLAIM UNDER TEST IS "NEVER INVENT A SPELLING FOR A FOLDER THE CLI ALREADY
// KNOWS". Every case below is a shape found in, or directly implied by, a real
// config: the dev machine's own file holds five folders under two spellings
// each, including this repo.
import { describe, it, expect } from 'vitest';
import { projectKey, resolveProjectKeys, samePath } from './project-key';

/** Every path resolves to the same directory — the ordinary win32 case, and the
 *  default for tests that are not about the UNC hazard. Passed explicitly so no
 *  test in this file touches a real filesystem. */
const same = (): string => 'ONE-DIRECTORY';

describe('projectKey — the spelling half', () => {
  it('uses forward slashes and drops a trailing slash', () => {
    expect(projectKey('C:\\Games')).toBe('C:/Games');
    expect(projectKey('C:/Games/')).toBe('C:/Games');
    expect(projectKey('C:\\Games\\')).toBe('C:/Games');
  });

  it('does NOT fold case — that is `samePath`\u2019s job, and only on win32', () => {
    expect(projectKey('c:/Games')).toBe('c:/Games');
  });
});

describe('samePath — case folding is per-platform, and that is the point', () => {
  it('folds case on win32, where two spellings are one directory', () => {
    expect(samePath('c:/Projects/acme', 'C:/Projects/ACME', 'win32')).toBe(true);
    expect(samePath('C:\\Projects\\acme', 'C:/Projects/acme/', 'win32')).toBe(true);
  });

  it('does NOT fold case elsewhere, where they are two directories', () => {
    expect(samePath('/home/dan/acme', '/home/dan/ACME', 'linux')).toBe(false);
    expect(samePath('/home/dan/acme', '/home/dan/acme/', 'linux')).toBe(true);
  });
});

describe('resolveProjectKeys — write where the CLI reads', () => {
  it('reuses an existing spelling that differs only in case', () => {
    // ⚠️ THE BUG. Windows hands us `c:\Projects\Foo` readily — drag-and-drop, a
    // shell integration, a path echoed back from a tool. Writing our own
    // normalised form created a SECOND entry beside the CLI's, so auto-trust
    // wrote `hasTrustDialogAccepted` where nothing reads it.
    const projects = { 'C:/Projects/Foo': { allowedTools: [] } };
    const r = resolveProjectKeys(projects, 'c:\\Projects\\Foo', 'win32');
    expect(r.keys).toEqual(['C:/Projects/Foo']);
    expect(r.created).toBe(false);
  });

  it('invents a key only when nothing in the file names that folder', () => {
    const r = resolveProjectKeys({ 'C:/Projects/Other': {} }, 'C:\\Projects\\New', 'win32');
    expect(r.keys).toEqual(['C:/Projects/New']);
    expect(r.created).toBe(true);
  });

  it('does NOT fold case off win32 — two spellings there are two folders', () => {
    const r = resolveProjectKeys({ '/home/dan/ACME': {} }, '/home/dan/acme', 'linux');
    expect(r.keys).toEqual(['/home/dan/acme']);
    expect(r.created).toBe(true);
  });

  it('handles an absent or malformed `projects` map by creating the key', () => {
    expect(resolveProjectKeys(undefined, 'C:\\A', 'win32')).toEqual({
      keys: ['C:/A'],
      created: true,
      ambiguous: false,
    });
    expect(resolveProjectKeys(null, 'C:\\A', 'win32').created).toBe(true);
  });

  it('skips a `projects` that is an ARRAY rather than silently no-opping', () => {
    // `typeof [] === 'object'`, so without the guard `Object.keys` yields
    // indices, the caller sets a string property on an array, `JSON.stringify`
    // drops it, and the write succeeds while changing nothing — the exact
    // "reported success, feature was off" shape #724 is about.
    expect(resolveProjectKeys([] as never, 'C:\\A', 'win32')).toMatchObject({
      keys: ['C:/A'],
      created: true,
    });
  });

  describe('when the folder already has TWO entries', () => {
    // Not hypothetical: `~/.claude.json` on the dev machine holds five such
    // pairs, this repo among them.
    it('returns BOTH, so the caller can act on whichever the CLI reads', () => {
      // ⚠️ #724 SUGGESTED PICKING ONE — prefer the entry carrying
      // `hasTrustDialogAccepted`, then the fuller one. That rule defeats the
      // feature in the exact case this ticket is about: when OUR phantom is the
      // flagged entry and the CLI's real one is not, preferring the flagged one
      // short-circuits on the phantom and the real entry stays untrusted for
      // ever. Which spelling the CLI reads next is precisely what we cannot
      // observe, so the answer is both.
      const projects = {
        'c:/Projects/Foo': { hasTrustDialogAccepted: true },
        'C:/Projects/Foo': { allowedTools: ['Read'] },
      };
      const r = resolveProjectKeys(projects, 'C:\\Projects\\Foo', 'win32', same);
      expect(r.keys).toEqual(['c:/Projects/Foo', 'C:/Projects/Foo']);
      expect(r.created).toBe(false);
    });

    it('never adds a THIRD spelling', () => {
      const projects = { 'c:/P/Foo': {}, 'C:/P/Foo': {} };
      const r = resolveProjectKeys(projects, 'C:/p/foo', 'win32', same);
      expect(r.keys).toEqual(['c:/P/Foo', 'C:/P/Foo']);
      expect(r.keys).not.toContain('C:/p/foo');
    });

    it('writes in the file\u2019s own key order, so the result is reproducible', () => {
      const projects = { 'c:/P/Foo': { a: 1 }, 'C:/P/Foo': { b: 2 } };
      expect(resolveProjectKeys(projects, 'C:/P/Foo', 'win32', same).keys).toEqual([
        'c:/P/Foo',
        'C:/P/Foo',
      ]);
    });
  });

  /**
   * ⚠️ **SPELLING IS NOT ALLOWED TO DECIDE WHO GETS A TRUST FLAG** — the review
   * blocker, and it was measured rather than argued (2026-08-30):
   *
   *     //wsl.localhost/Ubuntu-24.04/home/dheinz/sbcase-Foo  ─┐ BOTH created,
   *     //wsl.localhost/Ubuntu-24.04/home/dheinz/sbcase-foo  ─┘ realpath differs
   *
   * A UNC path is a win32 path over a possibly case-SENSITIVE backend, and the
   * dev machine's own `~/.claude.json` already carries a `//wsl.localhost/...`
   * key. Trusting both would hand `hasTrustDialogAccepted` — the flag that lets a
   * folder's hooks run — to a directory the user never opened.
   */
  describe('two spellings are confirmed by RESOLUTION, not by spelling', () => {
    const projects = { '//host/share/Foo': { a: 1 }, '//host/share/foo': { b: 2 } };

    it('drops a match that resolves somewhere else', () => {
      // A case-sensitive share: the two keys are two real directories.
      const distinct = (p: string): string => p.toLowerCase().replace(/\/foo$/, '/foo#lower');
      const r = resolveProjectKeys(projects, '//host/share/Foo', 'win32', (p) =>
        p === '//host/share/Foo' ? '\\\\host\\share\\Foo' : distinct(p)
      );
      expect(r.keys).toEqual(['//host/share/Foo']);
    });

    it('keeps both when they really do resolve to one directory', () => {
      // The ordinary NTFS case this feature exists for.
      const r = resolveProjectKeys(projects, '//host/share/foo', 'win32', () => 'ONE');
      expect(r.keys).toEqual(['//host/share/Foo', '//host/share/foo']);
      expect(r.ambiguous).toBe(true);
    });

    it('falls back to ONE key when the folder cannot be resolved at all', () => {
      // A disconnected share or a deleted folder. Narrower than ideal and never
      // wrong: the failure mode is a missed trust, not a trust granted where it
      // was not earned.
      const r = resolveProjectKeys(projects, '//host/share/foo', 'win32', () => null);
      expect(r.keys).toEqual(['//host/share/foo']);
      expect(r.ambiguous).toBe(true);
    });

    it('treats the folder as unknown when NO candidate resolves to it', () => {
      const r = resolveProjectKeys(projects, '//host/share/Foo', 'win32', (p) =>
        p === '//host/share/Foo' ? 'ME' : 'SOMETHING-ELSE'
      );
      expect(r.keys).toEqual(['//host/share/Foo']);
      expect(r.created).toBe(false); // that exact spelling is already a key
    });

    it('never calls the filesystem when only one spelling matched', () => {
      // The cheap path stays cheap: one string compare per key, and a syscall
      // only for the rare folder that matched twice.
      let calls = 0;
      resolveProjectKeys({ 'C:/Projects/Foo': {} }, 'c:\\Projects\\Foo', 'win32', (p) => {
        calls += 1;
        return p;
      });
      expect(calls).toBe(0);
    });
  });
});
