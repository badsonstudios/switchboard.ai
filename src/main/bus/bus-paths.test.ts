import { describe, it, expect } from 'vitest';
import path from 'path';
import { BUS_SERVER_NAME, BUS_TOKEN_FILE, busKey, busPipePath, busTokenPath } from './bus-paths';

/**
 * The real ceiling this design exists to clear.
 *
 * `sockaddr_un.sun_path` is 104 bytes on macOS/BSD and 108 on Linux, and one of
 * those bytes is the terminator. Asserting against the SMALLER platform is the
 * point: the naive `<stateDir>/<uuid>/bus.sock` fits comfortably on Linux and
 * overflows on macOS, so a bound taken from the roomier platform would have let
 * exactly the broken design through.
 */
const SUN_PATH_MAX = 104;

/** A realistic macOS state dir — this is the path that motivated the digest. */
const MAC_STATE_DIR =
  '/Users/danheinz/Library/Application Support/switchboard.ai/sessions';
/** `randomUUID()` is what `SessionManager` mints, so 36 characters is the real case. */
const UUID = '9f8b1a2c-4d5e-4f60-8a71-b2c3d4e5f607';

describe('busKey', () => {
  it('is stable — both ends derive the same name from the same id', () => {
    expect(busKey(UUID)).toBe(busKey(UUID));
  });

  it('differs between sessions', () => {
    expect(busKey('a')).not.toBe(busKey('b'));
  });

  it('is 12 lowercase hex characters', () => {
    expect(busKey(UUID)).toMatch(/^[0-9a-f]{12}$/);
  });

  it('is a digest, not a prefix of the id — the id must not be recoverable', () => {
    // A "shortening" that just truncated the session id would pass every test
    // above and leak the id into a world-readable path name.
    expect(UUID).not.toContain(busKey(UUID));
    expect(busKey(UUID)).not.toBe(UUID.slice(0, 12));
  });
});

describe('busPipePath — win32', () => {
  const win = (id: string): string => busPipePath(id, { platform: 'win32' });

  it('lives in the named-pipe namespace', () => {
    expect(win(UUID)).toBe(`\\\\.\\pipe\\switchboard-bus-${busKey(UUID)}`);
  });

  it('does not put the raw session id in the name', () => {
    expect(win(UUID)).not.toContain(UUID);
  });

  it('is unaffected by tmpDir — a pipe name is not a filesystem path', () => {
    expect(busPipePath(UUID, { platform: 'win32', tmpDir: '/somewhere/else' })).toBe(win(UUID));
  });
});

describe('busPipePath — posix', () => {
  const mac = (id: string, tmpDir = '/var/folders/q7/8kx1zt0n1qv2/T'): string =>
    busPipePath(id, { platform: 'darwin', tmpDir });

  it('is a .sock under the runtime directory', () => {
    expect(mac(UUID)).toBe(`/var/folders/q7/8kx1zt0n1qv2/T/sb-bus-${busKey(UUID)}.sock`);
  });

  it('CLEARS sun_path on a realistic macOS tmpdir', () => {
    expect(Buffer.byteLength(mac(UUID))).toBeLessThan(SUN_PATH_MAX);
  });

  it('clears sun_path on a Linux runner tmpdir too', () => {
    expect(Buffer.byteLength(busPipePath(UUID, { platform: 'linux', tmpDir: '/tmp' }))).toBeLessThan(
      SUN_PATH_MAX
    );
  });

  // THE NEGATIVE THAT JUSTIFIES THE WHOLE DESIGN. Without it, "the path fits"
  // is a claim about the digest that would survive replacing the digest with
  // the state dir — which is the version that breaks, on the platform CI does
  // not run, in a way only a Mac user would ever see.
  it('…where the obvious `<stateDir>/<id>/bus.sock` would NOT have', () => {
    const naive = path.posix.join(MAC_STATE_DIR, UUID, 'bus.sock');
    expect(Buffer.byteLength(naive)).toBeGreaterThan(SUN_PATH_MAX);
  });

  it('does not put the raw session id in the name', () => {
    expect(mac(UUID)).not.toContain(UUID);
  });

  it('gives different sessions different sockets', () => {
    expect(mac('one')).not.toBe(mac('two'));
  });
});

describe('busPipePath — platform', () => {
  it('follows the platform it is told about, not the one it runs on', () => {
    // Both shapes are asserted from a single test run, on whichever OS that is.
    // Otherwise half of this file is dead on every machine that executes it.
    expect(busPipePath(UUID, { platform: 'win32' }).startsWith('\\\\.\\pipe\\')).toBe(true);
    expect(busPipePath(UUID, { platform: 'linux', tmpDir: '/tmp' }).startsWith('/tmp/')).toBe(true);
  });

  it('defaults to the running platform', () => {
    expect(busPipePath(UUID)).toBe(busPipePath(UUID, { platform: process.platform }));
  });
});

describe('busTokenPath', () => {
  it('sits in the session state directory, beside hook-token', () => {
    expect(busTokenPath('/state', UUID)).toBe(path.join('/state', UUID, BUS_TOKEN_FILE));
  });

  it('is a distinct file from the hook token — one must not clobber the other', () => {
    expect(BUS_TOKEN_FILE).not.toBe('hook-token');
  });
});

describe('BUS_SERVER_NAME', () => {
  it('is the prefix of every tool name the agent sees', () => {
    // `mcp__<server>__<tool>` (#760 §6). An underscore or a dash in the wrong
    // place here silently renames every tool the model was told about.
    expect(BUS_SERVER_NAME).toMatch(/^[a-z][a-z0-9-]*$/);
  });
});
