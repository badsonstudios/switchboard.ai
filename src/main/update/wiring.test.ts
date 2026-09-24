// The bootstrap wiring for the update credential chain (#856), pinned textually.
//
// WHY A REGEX OVER SOURCE, when the rest of this directory is properly unit
// tested: #856 was never a bug in a module. Every module behaved exactly as
// written — `checker.ts` and `install.ts` both read `deps.tokenSources`, and
// `credentialStoreTokenFrom` read the store correctly. The defect was that
// `index.ts` did not PASS it, and a token pasted into Help ▸ Report a problem…
// filed issues successfully while update checks went on saying this machine has
// no credentials for the release list.
//
// No unit test in this directory can fail on that, because the call site is in
// a file vitest cannot import: `src/main/index.ts` calls `app.enableSandbox()`
// and `app.requestSingleInstanceLock()` at module scope, against an `electron`
// that only exists inside a real Electron process. So the wiring is asserted
// against the source text — the same trick and the same reason as
// `single-instance.test.ts`, `check-scripts.test.ts` and `packaging.test.ts`: a
// decision nothing re-checks is a decision that quietly stops being true.
//
// A blunt instrument, and it knows it. It can fail only when someone DELETES
// the wiring or moves the store back below its consumers — which is exactly the
// regression worth catching, and exactly the one that shipped once.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const INDEX = fs.readFileSync(path.join(__dirname, '..', 'index.ts'), 'utf8');

/** Where `needle` first appears, asserting that it appears at all. */
function at(needle: string | RegExp): number {
  const i = typeof needle === 'string' ? INDEX.indexOf(needle) : (INDEX.match(needle)?.index ?? -1);
  expect(i, `src/main/index.ts no longer contains ${String(needle)}`).toBeGreaterThanOrEqual(0);
  return i;
}

/**
 * The text of one `new Thing({ … })` call, from the constructor to its closing
 * brace at the bootstrap's indentation.
 *
 * The `end > start` check is the point of extracting this (review). A bare
 * `slice(start, indexOf(…))` returns EVERYTHING TO END OF FILE when the needle
 * is missing, because `indexOf` answers `-1` and `slice(start, -1)` is not an
 * error — so a re-indent of the bootstrap would silently let the
 * `UpdateInstaller` case pass on text belonging to `UpdateService` fifty lines
 * below. A false pass, in exactly the scenario this file exists for.
 */
function callBody(ctor: string): string {
  const start = at(ctor);
  const end = INDEX.indexOf('\n    });', start);
  expect(end, `${ctor}'s call no longer closes at the bootstrap's indentation`).toBeGreaterThan(
    start
  );
  return INDEX.slice(start, end);
}

describe('the update credential chain is wired at the call site (#856)', () => {
  it('builds the chain through `token.ts`\'s factory, from the shared store', () => {
    // NOT an inline array. The order — a pasted token beats `gh` — is a
    // decision, and #856 is what it cost to have it written in two places:
    // `report-ipc.ts` spelled it out, the update path never spelled it at all,
    // and the two disagreed. `tokenSourcesFor` is its one home.
    expect(INDEX).toMatch(/const updateTokenSources = tokenSourcesFor\(secretStore\)/);
  });

  it.each([
    ['the update CHECK', 'new UpdateService('],
    ['the update DOWNLOAD', 'new UpdateInstaller('],
  ])('passes it to %s', (_what: string, ctor: string) => {
    // Both halves, not one. An offer that cannot be downloaded is worse than no
    // offer, so `UpdateInstaller` is as much of the fix as `UpdateService`.
    expect(callBody(ctor), `${ctor} no longer passes tokenSources`).toContain(
      'tokenSources: updateTokenSources'
    );
  });

  it('constructs ONE store, above both consumers', () => {
    // TypeScript already refuses a use-before-declaration, so this cannot fail
    // on ordering alone — what it catches is the OTHER repair someone reaches
    // for when they hit that error: a second `new SecretStore(...)` up here and
    // the original left below. Two stores would reintroduce #856 in a shape far
    // harder to see, because `SecretStore.set()` updates only its OWN cache —
    // the update side would keep reading the file it had already cached a miss
    // for, and every unit test in the tree would still pass.
    //
    // Matched on the ASSIGNMENT rather than the bare `new SecretStore(`, so
    // that a mention in a comment cannot fail it (review) — and so the day
    // someone legitimately moves construction behind a factory module, this
    // fails with a message that names what it wanted rather than a bare count.
    const stores = INDEX.match(/const secretStore = new SecretStore\(/g) ?? [];
    expect(stores, 'index.ts should assign exactly one SecretStore').toHaveLength(1);
    expect(at('new SecretStore(')).toBeLessThan(at('new UpdateInstaller('));
    expect(at('new SecretStore(')).toBeLessThan(at('new UpdateService('));
  });

  it('still hands that same store to the report dialog', () => {
    // The surface the token is TYPED INTO. If this stops sharing the instance,
    // the two halves diverge again and nothing else in the suite notices.
    expect(callBody('registerReportIpc({')).toContain('secrets: secretStore');
  });
});
