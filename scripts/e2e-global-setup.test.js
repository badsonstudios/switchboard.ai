// The Playwright pre-flight's wiring (#329, extended by #360).
//
// Two things can rot here and neither shows up as a failing spec, because the
// symptom of both is a suite that runs HAPPILY against the wrong bytes:
//
//   1. playwright.config.ts stops pointing at the setup file, and every
//      invocation is unguarded again — exactly the state #315's worker walked
//      into.
//   2. the setup file stops failing the run when the guard says stale (a
//      swallowed throw, a `console.error` instead), which looks identical to
//      "the bundle was fine".
//
// So both are asserted directly: the config's `globalSetup` must resolve to a
// real file, and the pre-flight must THROW on a stale fixture. The staleness
// rule itself belongs to bundle-guard.test.js and is not re-tested here.
//
// #360 added the temp sweep to the same file, and it can rot the same silent
// way — an e2e run that quietly stops sweeping looks exactly like an e2e run
// with nothing to sweep. So the composed pre-flight is asserted too: it sweeps,
// and it does NOT sweep when the guard has already ended the run. The sweep's
// own rules (what it will and will not delete) belong to
// sweep-temp-orphans.test.js. As there: the real `%TEMP%` is never a target —
// every sweeping test points `TMPDIR`/`TEMP`/`TMP` at a fixture first.
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { cleanupTempDirs, tempDir, withTempDirAt } from '../src/test-temp-dirs';
import globalSetup from './e2e-global-setup.js';
import { SKIP_ENV } from './sweep-temp-orphans.js';
import playwrightConfig from '../playwright.config.ts';

// A CJS module whose export IS the function Playwright calls; the testable
// inners hang off it (see the file's note on why the export takes no arguments).
const { e2eBundlePreflight, e2ePreflight } = globalSetup;

/** A project root with a complete out/, every input stamped older than it. */
function project() {
  const root = tempDir('sb-e2e-setup-');
  const write = (rel, body) => {
    fs.mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  };
  write('package.json', '{}');
  write('package-lock.json', '{}');
  write('electron.vite.config.ts', '// config');
  write('src/main/index.ts', '// main');
  write('out/main/index.js', '// built main');
  write('out/preload/index.js', '// built preload');
  write('out/renderer/index.html', '<html></html>');

  // Explicit times: a real build takes longer than mtime granularity, and this
  // must not depend on the filesystem's.
  const past = new Date(Date.now() - 60_000);
  const built = new Date(Date.now() - 30_000);
  for (const rel of [
    'package.json',
    'package-lock.json',
    'electron.vite.config.ts',
    'src/main/index.ts',
  ]) {
    fs.utimesSync(path.join(root, rel), past, past);
  }
  for (const rel of ['out/main/index.js', 'out/preload/index.js', 'out/renderer/index.html']) {
    fs.utimesSync(path.join(root, rel), built, built);
  }
  return root;
}

// Everything here is per-test, so the whole registry goes at the end of each
// one (#213, #360). Fixtures used to be a hand-rolled list and a bare `rmSync`
// that a throwing hook would have skipped.
afterEach(() => cleanupTempDirs());

/** Run the pre-flight against a fixture, capturing the guard's report. */
function preflight(root, env = {}) {
  let out = '';
  const write = (s) => (out += s);
  try {
    e2eBundlePreflight({ root, env, write });
    return { threw: null, out };
  } catch (err) {
    return { threw: err, out };
  }
}

/**
 * A temp dir for the SWEEP half, plus a `sb-*` orphan in it, aged past the
 * 24 h floor. Never the real `%TEMP%`: the caller runs the pre-flight with
 * `TMPDIR`/`TEMP`/`TMP` pointed here.
 */
function sweepFixture(name = 'sb-ws-aaaaaa', ageMs = 10 * 24 * 60 * 60 * 1000) {
  const tmp = tempDir('sb-e2e-setup-tmp-');
  const orphan = path.join(tmp, name);
  fs.mkdirSync(orphan);
  fs.writeFileSync(path.join(orphan, 'workspace.json'), '{}');
  const when = new Date(Date.now() - ageMs);
  fs.utimesSync(orphan, when, when);
  return tmp;
}

// `withTempDirAt` (shared with sweep-temp-orphans.test.js, and it refuses to
// run the callback unless the redirect actually took) is what keeps the sweep
// half of these tests off the real `%TEMP%`.

/** The composed pre-flight — guard AND sweep — against fixtures for both. */
function fullPreflight(root, tmp, env = {}) {
  let out = '';
  const write = (s) => (out += s);
  try {
    withTempDirAt(tmp, () => e2ePreflight({ root, env, write }));
    return { threw: null, out };
  } catch (err) {
    return { threw: err, out };
  }
}

describe('the Playwright pre-flight (#329, #360)', () => {
  it('is wired into playwright.config.ts, and the file it names exists', () => {
    // The whole fix is this one line of config. Without it every assertion
    // below is about code that never runs.
    expect(playwrightConfig.globalSetup).toBe('./scripts/e2e-global-setup.js');
    expect(fs.existsSync(path.join(process.cwd(), playwrightConfig.globalSetup))).toBe(true);
  });

  it('exports a plain function, and that function runs the COMPOSED pre-flight', () => {
    // The rot this closes: someone edits the default export back to
    // `e2eBundlePreflight()` and every other test in this file still passes,
    // because they all drive `e2ePreflight` directly. So the delegation is
    // asserted — by READING the export, not by running it.
    //
    // Running it is not available here, and the reason is worth recording. The
    // export takes no arguments (deliberately: a Playwright `FullConfig` must
    // never be mistaken for options), so it guards the REAL repo root — and CI
    // runs `npm test` BEFORE `npm run build`, where `out/` does not exist yet.
    // A missing bundle is the one verdict `ALLOW_STALE_BUNDLE` cannot override
    // ("the escape hatch means my edit cannot have changed the bundle, which
    // presupposes there is a bundle" — bundle-guard.js's `formatReport`). A
    // test that invoked it would therefore pass on a developer's machine and
    // fail on every CI run: MEASURED, on the first push of #360.
    //
    // The vitest twin in sweep-temp-orphans.test.js CAN drive its real default
    // export, because that one has no guard in front of it.
    expect(typeof globalSetup).toBe('function');
    expect(globalSetup.length).toBe(0);
    expect(String(globalSetup)).toContain('e2ePreflight()');
  });

  it('lets a fresh bundle through, and stamps what it is about to test', () => {
    const { threw, out } = preflight(project());
    expect(threw).toBeNull();
    expect(out).toContain('FRESH');
    expect(out).toContain('playwright test'); // named for the bare invocation
  });

  it('THROWS on a stale bundle, so not one spec runs', () => {
    const root = project();
    const now = new Date();
    fs.utimesSync(path.join(root, 'src/main/index.ts'), now, now);

    const { threw, out } = preflight(root);
    expect(threw).toBeInstanceOf(Error);
    expect(threw.message).toContain('npm run build');
    // The guard's report is the useful half; the throw only stops the run.
    expect(out).toContain('STALE');
    expect(out).toContain('src/main/index.ts');
  });

  it('THROWS when out/ was never built at all', () => {
    const root = project();
    fs.rmSync(path.join(root, 'out'), { recursive: true, force: true });
    expect(preflight(root).threw).toBeInstanceOf(Error);
  });

  it('SWEEPS the temp orphans too, which is what an e2e run never used to do', () => {
    // e2e is the biggest producer of `sb-*` litter and, before #360, the only
    // runner that cleared none of it.
    const tmp = sweepFixture();
    const { threw, out } = fullPreflight(project(), tmp);
    expect(threw).toBeNull();
    expect(out).toContain('removed 1 orphaned dir(s)');
    expect(fs.readdirSync(tmp)).toEqual([]);
  });

  it('says nothing, and spares today’s directories, when there is no backlog', () => {
    // Silence on a clean machine is a requirement, not an accident: this runs
    // on every single invocation. The orphan here is one HOUR old — i.e. the
    // shape of a run happening right now — so this pins the age floor and the
    // silence together, instead of pointing at an empty directory and passing
    // whether or not the sweep even ran.
    const tmp = sweepFixture('sb-ws-young1', 60 * 60 * 1000);
    const { out } = fullPreflight(project(), tmp);
    expect(out).not.toContain('temp sweep');
    expect(fs.readdirSync(tmp)).toEqual(['sb-ws-young1']);
  });

  it('honours SB_SKIP_TEMP_SWEEP, the same switch npm test honours', () => {
    const tmp = sweepFixture();
    fullPreflight(project(), tmp, { [SKIP_ENV]: '1' });
    expect(fs.readdirSync(tmp)).toEqual(['sb-ws-aaaaaa']);
  });

  it('does NOT sweep when the guard has already ended the run', () => {
    // Order, asserted: the developer hears about the stale bundle immediately,
    // and the budget is not spent on a run that is not going to happen. Missing
    // one sweep costs nothing — there is a next time, and a 24 h floor.
    const root = project();
    const now = new Date();
    fs.utimesSync(path.join(root, 'src/main/index.ts'), now, now);
    const tmp = sweepFixture();

    expect(fullPreflight(root, tmp).threw).toBeInstanceOf(Error);
    expect(fs.readdirSync(tmp)).toEqual(['sb-ws-aaaaaa']);
  });

  it('propagates the guard’s verdict rather than re-deciding it', () => {
    // One staleness rule and one escape hatch: ALLOW_STALE_BUNDLE reaches the
    // suite through this path exactly as it reached e2e:only before.
    const root = project();
    const now = new Date();
    fs.utimesSync(path.join(root, 'src/main/index.ts'), now, now);

    const { threw, out } = preflight(root, { ALLOW_STALE_BUNDLE: '1' });
    expect(threw).toBeNull();
    expect(out).toContain('continuing anyway');
  });
});
