import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { ensureFolderTrusted, projectKey } from './trust';
import { cleanupTempDirs, tempDir } from '../../test-temp-dirs';

/** Every candidate resolves to one directory — the ordinary win32 case. Passed
 *  explicitly so no test here depends on paths that exist on the real disk, and
 *  so the UNC hazard (two spellings, two directories) has its own tests in
 *  `project-key.test.ts` rather than being smuggled in as a default. */
const same = (): string => 'ONE-DIRECTORY';

let cfgPath: string;
beforeEach(() => {
  const home = tempDir('sb-trust-');
  cfgPath = path.join(home, '.claude.json');
});
afterEach(() => cleanupTempDirs()); // one fake home per test, gone at the end of it (#213)

function writeCfg(obj: unknown): void {
  fs.writeFileSync(cfgPath, JSON.stringify(obj));
}
type Cfg = { projects: Record<string, Record<string, unknown>> } & Record<string, unknown>;
/** `JSON.parse` hands back `any`; this is where that stops for this file. */
function readCfg(): Cfg {
  return JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as Cfg;
}

describe('projectKey', () => {
  it('uses forward slashes (how Claude Code keys projects)', () => {
    expect(projectKey('C:\\Games')).toBe('C:/Games');
    expect(projectKey('C:/Games/')).toBe('C:/Games');
  });
});

describe('ensureFolderTrusted', () => {
  it('sets the trust flag under the forward-slash key, merging other config', () => {
    writeCfg({ projects: { 'C:/Games': { allowedTools: ['Read'] } }, hasCompletedOnboarding: true });
    expect(ensureFolderTrusted('C:\\Games', undefined, { configPath: cfgPath })).toBe(true);
    const cfg = readCfg();
    expect(cfg.projects['C:/Games'].hasTrustDialogAccepted).toBe(true);
    expect(cfg.projects['C:/Games'].allowedTools).toEqual(['Read']); // untouched
    expect(cfg.hasCompletedOnboarding).toBe(true); // untouched
  });

  it('creates the project entry when absent', () => {
    writeCfg({ projects: {} });
    ensureFolderTrusted('C:\\New\\Folder', undefined, { configPath: cfgPath });
    expect(readCfg().projects['C:/New/Folder'].hasTrustDialogAccepted).toBe(true);
  });

  it('is a no-op when already trusted (keeps other fields)', () => {
    writeCfg({ projects: { 'C:/Games': { hasTrustDialogAccepted: true, projectOnboardingSeenCount: 5 } } });
    expect(ensureFolderTrusted('C:\\Games', undefined, { configPath: cfgPath })).toBe(true);
    expect(readCfg().projects['C:/Games'].projectOnboardingSeenCount).toBe(5); // not reset
  });

  it('fails open (returns false, no throw) when the config is unreadable', () => {
    // cfgPath not written
    expect(ensureFolderTrusted('C:\\Games', undefined, { configPath: cfgPath })).toBe(false);
  });
});

/**
 * #724 — auto-trust wrote a key the CLI was not reading.
 *
 * The whole feature was off and every layer reported success: the flag landed
 * under our own normalised spelling, the CLI read its own, the trust dialog the
 * user opted out of appeared anyway, and the log said `folder auto-trusted`.
 *
 * The platform is INJECTED throughout — read from the ambient process these
 * would pass on Windows and go red on the Linux CI leg (#127).
 */
describe('#724 — the key is looked up, never invented', () => {
  it('writes into the CLI\u2019s existing spelling instead of adding a second entry', () => {
    // Windows hands us a lower-case drive letter readily. Before this fix, that
    // produced `c:/Projects/Foo` beside the CLI's `C:/Projects/Foo`.
    writeCfg({ projects: { 'C:/Projects/Foo': { allowedTools: ['Read'] } } });
    expect(ensureFolderTrusted('c:\\Projects\\Foo', undefined, { configPath: cfgPath, platform: 'win32', realpath: same })).toBe(true);
    const cfg = readCfg();
    expect(Object.keys(cfg.projects)).toEqual(['C:/Projects/Foo']); // ← no phantom
    expect(cfg.projects['C:/Projects/Foo'].hasTrustDialogAccepted).toBe(true);
    expect(cfg.projects['C:/Projects/Foo'].allowedTools).toEqual(['Read']);
  });

  it('does NOT short-circuit against a flag only we ever wrote', () => {
    // ⚠️ THE SECOND-RUN TRAP, and the worse half of the bug. With a phantom key
    // carrying our own `hasTrustDialogAccepted`, the "already trusted?" check
    // answered yes — so the retry never happened either, for ever.
    //
    // This is also the case that killed #724's suggested tie-break. "Prefer the
    // entry carrying the flag" would pick the PHANTOM here, short-circuit on it,
    // and leave the CLI's real entry untrusted permanently — the bug surviving
    // its own fix. Both entries get trusted instead.
    writeCfg({
      projects: {
        'c:/Projects/Foo': { hasTrustDialogAccepted: true }, // ours, from a past run
        'C:/Projects/Foo': { allowedTools: ['Read'] }, // the CLI's, still untrusted
      },
    });
    // THE FOLDER ARRIVES IN THE LOWER-CASE SPELLING — which is how the phantom
    // got created in the first place, and therefore how it gets hit again. That
    // detail is the whole test: with the old code the key resolves to our own
    // flagged entry, the short-circuit fires, and the CLI's entry stays
    // untrusted for ever.
    expect(ensureFolderTrusted('c:\\Projects\\Foo', undefined, { configPath: cfgPath, platform: 'win32', realpath: same })).toBe(true);
    const cfg = readCfg();
    expect(cfg.projects['C:/Projects/Foo'].hasTrustDialogAccepted).toBe(true); // ← the fix
    expect(cfg.projects['c:/Projects/Foo'].hasTrustDialogAccepted).toBe(true);
    expect(cfg.projects['C:/Projects/Foo'].allowedTools).toEqual(['Read']); // untouched
    // ...and still no THIRD key invented.
    expect(Object.keys(cfg.projects).sort()).toEqual(['C:/Projects/Foo', 'c:/Projects/Foo']);
  });

  it('short-circuits only when EVERY matching entry is already trusted', () => {
    // ASSERTED BY WATCHING THE FILE, not by checking fields the merge would have
    // preserved anyway. An earlier version of this test compared
    // `projectOnboardingSeenCount` before and after, which passes whether or not
    // the write happens — it proved nothing, and review caught it.
    writeCfg({
      projects: {
        'c:/P/Foo': { hasTrustDialogAccepted: true, projectOnboardingSeenCount: 5 },
        'C:/P/Foo': { hasTrustDialogAccepted: true, projectOnboardingSeenCount: 7 },
      },
    });
    const before = fs.readFileSync(cfgPath, 'utf8');
    expect(
      ensureFolderTrusted('C:\\P\\Foo', undefined, {
        configPath: cfgPath,
        platform: 'win32',
        realpath: same,
      })
    ).toBe(true);
    // BYTE-FOR-BYTE UNCHANGED. A rewrite here would also reformat the user's
    // file (2-space JSON) for no reason, which is its own small rudeness.
    expect(fs.readFileSync(cfgPath, 'utf8')).toBe(before);
  });

  it('DOES write when only some of the matching entries are trusted', () => {
    // The other side of the same rule — without this, `every` could be `some`
    // and the short-circuit test above would still pass.
    writeCfg({ projects: { 'c:/P/Foo': { hasTrustDialogAccepted: true }, 'C:/P/Foo': {} } });
    const before = fs.readFileSync(cfgPath, 'utf8');
    ensureFolderTrusted('C:\\P\\Foo', undefined, {
      configPath: cfgPath,
      platform: 'win32',
      realpath: same,
    });
    expect(fs.readFileSync(cfgPath, 'utf8')).not.toBe(before);
    expect(readCfg().projects['C:/P/Foo'].hasTrustDialogAccepted).toBe(true);
  });

  it('leaves no scratch file behind', () => {
    // The tmp name is now unique per call (concurrent sessions raced on a fixed
    // one), so a leak would accumulate rather than be overwritten.
    writeCfg({ projects: {} });
    ensureFolderTrusted('C:\\P\\Foo', undefined, { configPath: cfgPath, platform: 'win32' });
    const strays = fs.readdirSync(path.dirname(cfgPath)).filter((f) => f.includes('.tmp'));
    expect(strays).toEqual([]);
  });

  it('still creates an entry for a folder the CLI has never seen', () => {
    writeCfg({ projects: { 'C:/Projects/Other': {} } });
    ensureFolderTrusted('C:\\Projects\\Brand\\New', undefined, { configPath: cfgPath, platform: 'win32', realpath: same });
    expect(readCfg().projects['C:/Projects/Brand/New'].hasTrustDialogAccepted).toBe(true);
  });

  it('treats case-different paths as different folders off win32', () => {
    // On Linux and macOS they really are two directories; folding there would
    // merge two projects' state into one.
    writeCfg({ projects: { '/home/dan/ACME': {} } });
    ensureFolderTrusted('/home/dan/acme', undefined, { configPath: cfgPath, platform: 'linux', realpath: same });
    const cfg = readCfg();
    expect(cfg.projects['/home/dan/acme'].hasTrustDialogAccepted).toBe(true);
    expect(cfg.projects['/home/dan/ACME'].hasTrustDialogAccepted).toBeUndefined();
  });

  it('warns when the folder already has two entries, rather than picking silently', () => {
    const warnings: Array<{ msg: string; fields?: Record<string, unknown> }> = [];
    const log = {
      debug: () => {},
      info: () => {},
      warn: (msg: string, fields?: Record<string, unknown>) => warnings.push({ msg, fields }),
      error: () => {},
      child: () => log,
    };
    writeCfg({ projects: { 'c:/P/Foo': {}, 'C:/P/Foo': {} } });
    ensureFolderTrusted('C:/P/Foo', log, { configPath: cfgPath, platform: 'win32', realpath: same });
    // That folder's state is ALREADY split and no write of ours can un-split it.
    // A log line is the only honest thing left to do about it.
    expect(warnings[0]?.msg).toContain('more than one entry');
    expect(warnings[0]?.fields?.entries).toEqual(['c:/P/Foo', 'C:/P/Foo']);
  });

  it('does not touch an unrelated project that merely shares a prefix', () => {
    // `samePath` compares whole normalised paths, not prefixes — worth pinning,
    // because a fix that widened matching would quietly trust folders the user
    // never opened.
    writeCfg({ projects: { 'C:/Projects/Foo': {}, 'C:/Projects/FooBar': {} } });
    ensureFolderTrusted('C:\\Projects\\Foo', undefined, { configPath: cfgPath, platform: 'win32', realpath: same });
    const cfg = readCfg();
    expect(cfg.projects['C:/Projects/Foo'].hasTrustDialogAccepted).toBe(true);
    expect(cfg.projects['C:/Projects/FooBar'].hasTrustDialogAccepted).toBeUndefined();
  });
});
