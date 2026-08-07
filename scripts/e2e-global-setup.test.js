// #329 — the Playwright pre-flight's wiring.
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
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import globalSetup from './e2e-global-setup.js';
import playwrightConfig from '../playwright.config.ts';

// A CJS module whose export IS the function Playwright calls; the testable
// inner hangs off it (see the file's note on why the export takes no arguments).
const { e2eBundlePreflight } = globalSetup;

/** A project root with a complete out/, every input stamped older than it. */
function makeProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-setup-'));
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

let roots = [];
beforeEach(() => {
  roots = [];
});
afterEach(() => {
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});
function project() {
  const root = makeProject();
  roots.push(root);
  return root;
}

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

describe('the Playwright pre-flight (#329)', () => {
  it('is wired into playwright.config.ts, and the file it names exists', () => {
    // The whole fix is this one line of config. Without it every assertion
    // below is about code that never runs.
    expect(playwrightConfig.globalSetup).toBe('./scripts/e2e-global-setup.js');
    expect(fs.existsSync(path.join(process.cwd(), playwrightConfig.globalSetup))).toBe(true);
  });

  it('exports a plain function, which is what Playwright calls', () => {
    expect(typeof globalSetup).toBe('function');
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
