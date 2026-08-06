// Token resolution (P2-E19-03, §E19 decision 1).
//
// `gh` is MOCKED here. A test that shells out to the real `gh auth token`
// would read this machine's actual credentials, pass or fail depending on
// whether a developer happens to be logged in, and be a live credential-store
// call from a unit suite.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  return { ...real, execFile: h.execFile };
});

import { credentialStoreToken, ghCliToken, resolveUpdateToken } from './token';

/** Script the next `execFile` call: (err, stdout). */
function ghAnswers(err: Error | null, stdout = ''): void {
  h.execFile.mockImplementation(
    (
      _cmd: string,
      _args: string[],
      _opts: unknown,
      cb: (e: Error | null, out: string) => void
    ) => {
      cb(err, stdout);
    }
  );
}

beforeEach(() => {
  h.execFile.mockReset();
});

describe('the credential-store slot', () => {
  it('is a documented NO-OP today, and still a real entry in the order', async () => {
    // §5.29's credential store does not exist in this codebase yet, and this
    // item deliberately did not build one. The slot stays so the day it lands
    // is one function body, not a rewrite of the resolution order.
    expect(await credentialStoreToken.resolve()).toBeNull();
    expect(credentialStoreToken.id).toBe('credential-store');
  });
});

describe('gh auth token', () => {
  it('returns the token it printed', async () => {
    ghAnswers(null, 'gho_abc123\n');
    expect(await ghCliToken.resolve()).toBe('gho_abc123');
  });

  it('never uses a shell, and hides the console window on Windows', async () => {
    ghAnswers(null, 'gho_abc123');
    await ghCliToken.resolve();
    const [cmd, args, opts] = h.execFile.mock.calls[0] as [string, string[], { windowsHide: boolean; timeout: number }];
    expect(cmd).toBe('gh');
    expect(args).toEqual(['auth', 'token']);
    expect(opts.windowsHide).toBe(true);
    expect(opts.timeout).toBeGreaterThan(0);
  });

  it('is simply "no token" when gh is absent, logged out, or hung', async () => {
    for (const err of [
      Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }),
      new Error('exit status 1'),
      Object.assign(new Error('killed'), { killed: true }),
    ]) {
      ghAnswers(err);
      expect(await ghCliToken.resolve()).toBeNull();
    }
  });

  it('rejects output with whitespace in it — that is a message, not a credential', async () => {
    ghAnswers(null, 'You are not logged into any GitHub hosts\n');
    expect(await ghCliToken.resolve()).toBeNull();
    ghAnswers(null, '   \n');
    expect(await ghCliToken.resolve()).toBeNull();
  });

  it('survives a synchronous throw out of execFile', async () => {
    h.execFile.mockImplementation(() => {
      throw new Error('EINVAL');
    });
    expect(await ghCliToken.resolve()).toBeNull();
  });
});

describe('resolveUpdateToken', () => {
  it('takes the FIRST source that has one, and says which', async () => {
    const r = await resolveUpdateToken([
      { id: 'a', resolve: async () => null },
      { id: 'b', resolve: async () => 'tok-b' },
      { id: 'c', resolve: async () => 'tok-c' },
    ]);
    expect(r).toEqual({ token: 'tok-b', source: 'b' });
  });

  it('reports "none" when nothing has one — the silent-disable path', async () => {
    const r = await resolveUpdateToken([{ id: 'a', resolve: async () => null }]);
    expect(r).toEqual({ token: null, source: 'none' });
  });

  it('a source that throws is a source with no token, not a failure', async () => {
    const r = await resolveUpdateToken([
      {
        id: 'boom',
        resolve: async () => {
          throw new Error('locked');
        },
      },
      { id: 'next', resolve: async () => 'tok' },
    ]);
    expect(r).toEqual({ token: 'tok', source: 'next' });
  });
});
