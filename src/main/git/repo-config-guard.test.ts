import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  CONFIG_LIST_SCOPED,
  configListForScope,
  emptyHooksDir,
  filterGuardOverrides,
  gitlinkPaths,
  guardArgs,
  overrideEnv,
  parseScopedConfig,
  parseUnscopedConfig,
  type ScopedConfigEntry,
} from './repo-config-guard';

/** the wire format: `scope\0key\nvalue\0` per entry */
const wire = (...entries: [string, string, string?][]): string =>
  entries.map(([scope, key, value]) => `${scope}\0${key}${value === undefined ? '' : `\n${value}`}\0`).join('');

const at = (scope: string) => (key: string, value?: string): ScopedConfigEntry => ({
  scope,
  key,
  value: value ?? null,
});
const local = at('local');
const global_ = at('global');

describe('parseScopedConfig', () => {
  it('reads scope, key and value from the -z stream', () => {
    expect(
      parseScopedConfig(wire(['global', 'filter.lfs.clean', 'git-lfs clean -- %f'], ['local', 'core.bare', 'false']))
    ).toEqual([
      { scope: 'global', key: 'filter.lfs.clean', value: 'git-lfs clean -- %f' },
      { scope: 'local', key: 'core.bare', value: 'false' },
    ]);
  });

  it('gives a valueless key a null value — git reads that as boolean true', () => {
    expect(parseScopedConfig(wire(['local', 'filter.x.clean']))).toEqual([
      { scope: 'local', key: 'filter.x.clean', value: null },
    ]);
  });

  it('keeps a value that CONTAINS A NEWLINE whole — the reason for -z', () => {
    // Two things at once. A line-based reader would see a second record here
    // and could be fed a forged `global` scope by a hostile repo config; and
    // splitting on the LAST newline instead of the first would fold the command
    // into the key, which stops it being recognised as a driver at all — a
    // bypass rather than a parse bug.
    const forged = 'first\nglobal\nfilter.evil.clean\ntouch pwned';
    expect(parseScopedConfig(wire(['local', 'filter.x.clean', forged]))).toEqual([
      { scope: 'local', key: 'filter.x.clean', value: forged },
    ]);
  });

  it('drops a truncated trailing pair rather than inventing a value', () => {
    expect(parseScopedConfig(`local\0core.bare\nfalse\0local\0`)).toEqual([
      { scope: 'local', key: 'core.bare', value: 'false' },
    ]);
  });

  it('is empty for empty output', () => {
    expect(parseScopedConfig('')).toEqual([]);
  });
});

describe('parseUnscopedConfig (the pre-2.26 fallback)', () => {
  it('stamps every entry with the scope that was asked for', () => {
    expect(parseUnscopedConfig('filter.x.clean\ntouch pwned\0core.bare\nfalse\0', 'local')).toEqual([
      { scope: 'local', key: 'filter.x.clean', value: 'touch pwned' },
      { scope: 'local', key: 'core.bare', value: 'false' },
    ]);
  });

  it('is empty for empty output', () => {
    expect(parseUnscopedConfig('', 'worktree')).toEqual([]);
  });
});

describe('filterGuardOverrides', () => {
  it('leaves a repo with no filter drivers completely alone', () => {
    expect(filterGuardOverrides([local('core.bare', 'false'), global_('user.name', 'dan')])).toEqual([]);
  });

  it('DOES NOT TOUCH a globally installed driver — the git-lfs case', () => {
    // `git lfs install` writes global. Neutralising it would make every LFS
    // file read as modified, or (with required=true) fail the read outright.
    expect(
      filterGuardOverrides([
        global_('filter.lfs.clean', 'git-lfs clean -- %f'),
        global_('filter.lfs.process', 'git-lfs filter-process'),
        global_('filter.lfs.required', 'true'),
      ])
    ).toEqual([]);
  });

  it('neutralises a driver the REPO defined, which is the hole', () => {
    expect(filterGuardOverrides([local('filter.evil.clean', 'sh -c "touch pwned"')])).toEqual([
      ['filter.evil.clean', ''],
    ]);
  });

  it('covers process and smudge, not just clean', () => {
    expect(
      filterGuardOverrides([
        local('filter.a.clean', 'x'),
        local('filter.a.process', 'y'),
        local('filter.a.smudge', 'z'),
        local('filter.a.required', 'true'),
      ])
    ).toEqual([
      ['filter.a.clean', ''],
      ['filter.a.process', ''],
      ['filter.a.smudge', ''],
    ]);
  });

  it('leaves `required` alone — git failing is the honest answer, not a wrong file list', () => {
    const keys = filterGuardOverrides([local('filter.a.clean', 'x'), local('filter.a.required', 'true')]).map(
      ([k]) => k
    );
    expect(keys).not.toContain('filter.a.required');
  });

  it('RESTORES the trusted value when a repo shadows a global driver', () => {
    expect(
      filterGuardOverrides([
        global_('filter.lfs.clean', 'git-lfs clean -- %f'),
        local('filter.lfs.clean', 'sh -c "touch pwned"'),
      ])
    ).toEqual([['filter.lfs.clean', 'git-lfs clean -- %f']]);
  });

  it('takes the LAST trusted value for a repeated key, as git does', () => {
    expect(
      filterGuardOverrides([
        global_('filter.a.clean', 'first'),
        global_('filter.a.clean', 'second'),
        local('filter.a.clean', 'evil'),
      ])
    ).toEqual([['filter.a.clean', 'second']]);
  });

  it('disables rather than restores a VALUELESS trusted key', () => {
    // A filter command that is boolean-true is already broken config, and the
    // command-line spelling of it (`-c key` with no `=`) is rejected by git
    // outright — so there is nothing worth restoring.
    expect(filterGuardOverrides([global_('filter.a.clean'), local('filter.a.clean', 'evil')])).toEqual([
      ['filter.a.clean', ''],
    ]);
  });

  it('emits one override per key even when the repo lists it twice', () => {
    expect(filterGuardOverrides([local('filter.a.clean', 'one'), local('filter.a.clean', 'two')])).toEqual([
      ['filter.a.clean', ''],
    ]);
  });

  it('handles a driver whose name legitimately contains dots', () => {
    expect(filterGuardOverrides([local('filter.my.driver.clean', 'evil')])).toEqual([
      ['filter.my.driver.clean', ''],
    ]);
  });

  it('matches the section and variable case-blind, as git does', () => {
    expect(filterGuardOverrides([local('filter.Name.CLEAN', 'evil')])).toEqual([['filter.Name.CLEAN', '']]);
  });

  // ---- scope handling ------------------------------------------------------

  it('treats worktree scope as repo-authored — .git/config.worktree is agent-writable', () => {
    expect(filterGuardOverrides([at('worktree')('filter.wt.clean', 'evil')])).toEqual([['filter.wt.clean', '']]);
  });

  it('DEFAULT-DENIES an unknown scope rather than trusting it', () => {
    // The trusted side is the allow-list, so a scope git grows later — or one
    // we simply never thought about — guards instead of silently passing.
    expect(filterGuardOverrides([at('submodule')('filter.s.clean', 'evil')])).toEqual([['filter.s.clean', '']]);
    expect(filterGuardOverrides([at('unknown')('filter.u.clean', 'evil')])).toEqual([['filter.u.clean', '']]);
    expect(filterGuardOverrides([at('')('filter.e.clean', 'evil')])).toEqual([['filter.e.clean', '']]);
  });

  it('trusts system scope alongside global', () => {
    expect(filterGuardOverrides([at('system')('filter.a.clean', 'installed by admin')])).toEqual([]);
  });

  // ---- the injection the command-line version could not express ------------

  it('EXPRESSES a driver name containing `=`, which is why these are env vars', () => {
    // `[filter "x.clean=touch pwned"]` makes the key
    // `filter.x.clean=touch pwned.clean`. As `-c <key>=` that parses on the
    // FIRST `=` and sets `filter.x.clean` to `touch pwned.clean=` — the
    // mitigation becoming the exploit. As a key/value pair it is just a key.
    expect(filterGuardOverrides([local('filter.x.clean=touch pwned.clean', 'harmless')])).toEqual([
      ['filter.x.clean=touch pwned.clean', ''],
    ]);
  });

  it('expresses a name with whitespace in it too', () => {
    expect(filterGuardOverrides([local('filter.a b.clean', 'evil')])).toEqual([['filter.a b.clean', '']]);
  });

  it('guards EVERY repo-authored driver, never a subset', () => {
    expect(filterGuardOverrides([local('filter.ok.clean', 'x'), local('filter.b=d.clean', 'evil')])).toEqual([
      ['filter.ok.clean', ''],
      ['filter.b=d.clean', ''],
    ]);
  });
});

describe('the config-listing arguments', () => {
  it('asks for --includes on EVERY read', () => {
    // Load-bearing on the by-name reads: measured, `--local --list` does not
    // see a driver defined in an `include.path` file and `--local --list
    // --includes` does. Two lines in a config file would otherwise hide a
    // driver from the guard while git expanded it during the read.
    expect(CONFIG_LIST_SCOPED).toContain('--includes');
    expect(configListForScope('local')).toContain('--includes');
    expect(configListForScope('worktree')).toContain('--includes');
  });

  it('asks for NUL-separated output on every read', () => {
    // A config value may contain newlines; it can never contain NUL.
    expect(CONFIG_LIST_SCOPED).toContain('-z');
    expect(configListForScope('local')).toContain('-z');
    expect(configListForScope('worktree')).toContain('-z');
  });
});

describe('gitlinkPaths', () => {
  const rec = (mode: string, p: string): string => `${mode} abc123 0\t${p}\0`;

  it('picks out submodules and nothing else', () => {
    const out = rec('100644', 'README.md') + rec('160000', 'vendor/sub') + rec('120000', 'link');
    expect(gitlinkPaths(out)).toEqual(['vendor/sub']);
  });

  it('keeps a path containing spaces whole — -z means no quoting', () => {
    expect(gitlinkPaths(rec('160000', 'my libs/sub one'))).toEqual(['my libs/sub one']);
  });

  it('refuses a traversing or absolute path', () => {
    // git's index cannot hold either; refusing them keeps this honest if it is
    // ever handed something that did not come from git.
    const out = rec('160000', '../escape') + rec('160000', 'a/../../b') + rec('160000', '/abs') + rec('160000', 'ok');
    expect(gitlinkPaths(out)).toEqual(['ok']);
  });

  it('is empty for a repository with no submodules', () => {
    expect(gitlinkPaths(rec('100644', 'a.txt'))).toEqual([]);
    expect(gitlinkPaths('')).toEqual([]);
  });
});

describe('guardArgs — the two that ride on every invocation', () => {
  it('turns fsmonitor off by config, not by hoping', () => {
    expect(guardArgs().slice(0, 2)).toEqual(['-c', 'core.fsmonitor=false']);
  });

  it('points core.hooksPath at an ABSOLUTE path', () => {
    // git resolves a relative `core.hooksPath` against the cwd — which is the
    // folder the hostile agent controls, so a relative one would send git
    // straight back to a directory that agent can create hooks in.
    const value = guardArgs()[3];
    expect(value.startsWith('core.hooksPath=')).toBe(true);
    expect(path.isAbsolute(value.slice('core.hooksPath='.length))).toBe(true);
  });

  it('points it at a directory of OURS that is empty', () => {
    // Not a fixed name under the temp directory: on Linux that is
    // world-writable, so another account could plant hooks at exactly the path
    // we tell git to look in.
    const dir = emptyHooksDir();
    expect(fs.existsSync(dir) ? fs.readdirSync(dir) : []).toEqual([]);
    expect(path.basename(dir)).not.toBe('hooks');
  });
});

describe('overrideEnv', () => {
  it('writes the key and the value into SEPARATE variables', () => {
    const env = overrideEnv({}, [['filter.x.clean', '']]);
    expect(env.GIT_CONFIG_COUNT).toBe('1');
    expect(env.GIT_CONFIG_KEY_0).toBe('filter.x.clean');
    expect(env.GIT_CONFIG_VALUE_0).toBe('');
  });

  it('appends AFTER the caller’s own GIT_CONFIG_*, so neither is lost', () => {
    // Clobbering the user's would silently drop their settings; ours going last
    // is also what makes ours win.
    const env = overrideEnv({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'dan' }, [
      ['filter.x.clean', ''],
    ]);
    expect(env.GIT_CONFIG_COUNT).toBe('2');
    expect(env.GIT_CONFIG_KEY_0).toBe('user.name');
    expect(env.GIT_CONFIG_KEY_1).toBe('filter.x.clean');
  });

  it('ignores a nonsense GIT_CONFIG_COUNT rather than producing a broken env', () => {
    const env = overrideEnv({ GIT_CONFIG_COUNT: 'banana' }, [['filter.x.clean', '']]);
    expect(env.GIT_CONFIG_COUNT).toBe('1');
    expect(env.GIT_CONFIG_KEY_0).toBe('filter.x.clean');
  });

  it('leaves the environment untouched when there is nothing to override', () => {
    // Not `GIT_CONFIG_COUNT=0` into an environment that had none: that is a
    // change, and this function's whole job is to add ours without disturbing
    // anyone else's.
    const env = overrideEnv({ PATH: '/bin' }, []);
    expect(env).toEqual({ PATH: '/bin' });
  });

  it('DROPS GIT_CONFIG_PARAMETERS, which would otherwise outrank us', () => {
    // Measured: a `-c` on the same key beats `GIT_CONFIG_KEY_<n>`, and that
    // variable is how a parent git passes its `-c` down. Nothing a repository
    // controls can set it, so this is not a live hole — but "the highest
    // precedence git has" has to be true for the guard to mean anything.
    const env = overrideEnv({ GIT_CONFIG_PARAMETERS: "'filter.x.clean=evil'" }, [['filter.x.clean', '']]);
    expect(env.GIT_CONFIG_PARAMETERS).toBeUndefined();
  });

  it('does not mutate the environment it was given', () => {
    const base = { PATH: '/bin' };
    overrideEnv(base, [['filter.x.clean', '']]);
    expect(base).toEqual({ PATH: '/bin' });
  });
});
