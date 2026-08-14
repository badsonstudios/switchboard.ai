// The PTY fake's transport REFUSAL, pinned (P2-E18-14).
//
// This is the single most load-bearing fact about the e2e suite, and until this
// file it was asserted in exactly one place — an e2e in `stream.spec.ts` that
// launches the whole app to check a Terminal tab has a terminal behind it.
//
// The fact: since #381 the host asks every session for `stream`, and this
// adapter answers with a recipe that declares no transport at all, which
// `session-manager.ts` reads as `pty`. So `SWITCHBOARD_FAKE_PROVIDER=1` — the
// default for nearly every spec in the suite — runs those sessions on the
// terminal, not on the transport the app actually ships as its default. The
// #404 audit counted it: 37 of 39 spec files.
//
// That makes this refusal a CONTRACT, not an implementation detail. If
// `fake.ts` ever grows a `transport` field, dozens of specs silently change
// what they test overnight and nothing fails — which is precisely the shape of
// failure this project keeps paying for (#153: a fake that ignored the
// requested transport made the whole feature untestable, and it shipped
// unusable). One assertion here means the change is a red test instead.
import { describe, it, expect } from 'vitest';
import { fakeAdapter } from './fake';
import { fakeStreamAdapter } from './fake-stream';

describe('the PTY fake refuses the stream transport (P2-E18-14)', () => {
  it('declares no transport, whatever is asked for', () => {
    // `buildSpawn` takes no options at all, so this is really asserting that it
    // cannot answer differently — the call is made both ways anyway, because
    // "it ignores its argument" is the claim and a signature is not a promise.
    const asked = (fakeAdapter.buildSpawn as (o: unknown) => { transport?: string })({
      cwd: '/w',
      sessionId: 's1',
      stateDir: '/w',
      transport: 'stream',
    });
    expect(asked.transport).toBeUndefined();
    const silent = (fakeAdapter.buildSpawn as (o: unknown) => { transport?: string })({
      cwd: '/w',
      sessionId: 's1',
      stateDir: '/w',
    });
    expect(silent.transport).toBeUndefined();
  });

  it('spawns the OS shell, which is what makes it a terminal', () => {
    const recipe = (fakeAdapter.buildSpawn as (o: unknown) => { command: string })({
      cwd: '/w',
      sessionId: 's1',
      stateDir: '/w',
      transport: 'stream',
    });
    expect(recipe.command).toBe(process.platform === 'win32' ? 'cmd.exe' : 'sh');
  });

  // The other half of the same fact, and the reason the two fakes exist: a spec
  // that MEANS to test Direct mode has to say `SWITCHBOARD_FAKE_PROVIDER=stream`.
  //
  // Only the PTY branch is assertable HERE. The stream branch resolves the
  // compiled `fake-stream-cli.js` and throws a named error when there is none,
  // and the CI unit job does not run a build — so a test of it could only ever
  // fail there (the #107 lesson, in reverse). That branch is proved by
  // `npm run check:fake-stream` and by `stream.spec.ts`, both of which run
  // against a build.
  it('the dual-capable fake still honours a PTY request, which is what makes switching testable', () => {
    expect(
      fakeStreamAdapter.buildSpawn({ cwd: '/w', sessionId: 's1', stateDir: '/w', transport: 'pty' })
        .transport
    ).toBeUndefined();
  });
});
