// The `mcp_authenticate` success payload -> what the host does (#1420).
// Shapes from the PATH CLI 2.1.288 handler, quoted in `sign-in.ts`.
import { describe, it, expect } from 'vitest';
import { carryOutSignIn, readSignInAnswer, safeAuthUrl } from './sign-in';

describe('readSignInAnswer', () => {
  it('an OAuth flow the CLI started: open its address', () => {
    expect(
      readSignInAnswer({
        authUrl: 'https://auth.example.test/authorize?state=s',
        requiresUserAction: true,
        callbackExpected: true,
        redirectScheme: 'localhost',
        state: 's',
        callbackPort: 53682,
      })
    ).toEqual({ kind: 'open', url: 'https://auth.example.test/authorize?state=s' });
  });

  it('a claude.ai connector: the CLI built the address itself, and we open it as-is', () => {
    // `callbackExpected: false` — claude.ai finishes the flow, not a localhost
    // listener. Nothing for the host to do differently: open the address.
    const url = 'https://claude.ai/api/organizations/org/mcp/start-auth/mcpsrv_1?product_surface=cli';
    expect(readSignInAnswer({ authUrl: url, requiresUserAction: true, callbackExpected: false })).toEqual({
      kind: 'open',
      url,
    });
  });

  it('`requiresUserAction: false` with no address: already signed in', () => {
    expect(readSignInAnswer({ requiresUserAction: false, callbackExpected: false })).toEqual({
      kind: 'already-signed-in',
    });
  });

  it('anything else is `no-url` — never a guess that a browser is coming', () => {
    expect(readSignInAnswer({})).toEqual({ kind: 'no-url' });
    expect(readSignInAnswer({ requiresUserAction: true })).toEqual({ kind: 'no-url' });
    // a bad address is not "already signed in", even beside `false`
    expect(readSignInAnswer({ authUrl: 'file:///x', requiresUserAction: false })).toEqual({ kind: 'no-url' });
  });
});

describe('safeAuthUrl', () => {
  it.each([
    ['https://a.test/x', 'https://a.test/x'],
    ['http://localhost:53682/cb', 'http://localhost:53682/cb'],
    // the PARSED form goes to the OS, not the raw string that was checked
    ['  https://a.test/x  ', 'https://a.test/x'],
    ['https://A.Test', 'https://a.test/'],
    ['file:///C:/x', null],
    ['javascript:alert(1)', null],
    ['vscode://anthropic.claude-code/cb', null],
    ['', null],
    ['not a url', null],
    [42, null],
  ])('%s -> %s', (raw, want) => {
    expect(safeAuthUrl(raw)).toBe(want);
  });
});

describe('carryOutSignIn', () => {
  it('opens once and reports `opened`', async () => {
    const opened: string[] = [];
    const out = await carryOutSignIn({ authUrl: 'https://a.test/x' }, async (u) => {
      opened.push(u);
    });
    expect(out).toBe('opened');
    expect(opened).toEqual(['https://a.test/x']);
  });

  it('never calls the opener when there is nothing to open', async () => {
    let calls = 0;
    const open = async (): Promise<void> => {
      calls++;
    };
    expect(await carryOutSignIn({ requiresUserAction: false }, open)).toBe('already-signed-in');
    expect(await carryOutSignIn({}, open)).toBe('no-url');
    expect(calls).toBe(0);
  });

  it('a rejecting opener is `open-failed`, not a rejection', async () => {
    await expect(
      carryOutSignIn({ authUrl: 'https://a.test/x' }, () => Promise.reject(new Error('no handler')))
    ).resolves.toBe('open-failed');
  });
});
