// P2-E19-01 — the packaging config's load-bearing promises, asserted.
//
// `npm run package` takes minutes and needs Windows, so it cannot be a CI job
// on every PR. That makes electron-builder.config.js exactly the kind of file
// that rots invisibly: nothing reads it between releases, and the first thing
// that notices a broken one is a human running an installer. So the parts of
// it that are PROMISES — the item's own done-when clauses, and the one
// assumption that would silently break the app — are checked here, where they
// run in half a second on every push.
//
// The sibling of src/main/check-scripts.test.ts, and for the same reason: a
// decision nothing re-checks is a decision that quietly stops being true.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const root = process.cwd();
const read = (f: string) => fs.readFileSync(path.join(root, f), 'utf8');

/**
 * The name matters. app-builder-lib auto-discovers `electron-builder.<ext>`
 * and nothing else — the widely-copied `electron-builder.config.js` is
 * IGNORED without an explicit `--config`, and electron-builder's response to
 * finding no config is to build a defaults-only installer rather than to
 * complain. That happened once while this item was being written, which is why
 * the filename is asserted rather than assumed.
 */
const CONFIG_FILE = 'electron-builder.js';

/**
 * The config is a CommonJS module (it is commented, which JSON cannot be), so
 * it is EVALUATED by node rather than parsed — the same bytes electron-builder
 * itself will run, not a regex's guess at them.
 */
function loadConfig(): Record<string, unknown> {
  const json = execFileSync(
    process.execPath,
    ['-e', `process.stdout.write(JSON.stringify(require(${JSON.stringify(`./${CONFIG_FILE}`)})))`],
    { cwd: root, encoding: 'utf8' }
  );
  return JSON.parse(json) as Record<string, unknown>;
}

const config = loadConfig();
const pkg = JSON.parse(read('package.json')) as {
  version: string;
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
};
const nsis = config.nsis as Record<string, unknown>;
const win = config.win as Record<string, unknown>;
const files = config.files as string[];

describe('packaging config (P2-E19-01)', () => {
  it('is reachable as `npm run package`', () => {
    expect(pkg.scripts.package).toBeDefined();
  });

  it('has a filename electron-builder actually looks for', () => {
    // app-builder-lib/out/util/config/load.js → findAndReadConfig. Renaming
    // this file to anything outside that list does not error; it silently
    // packages every default instead.
    const AUTO_DISCOVERED = [
      'electron-builder.yml',
      'electron-builder.yaml',
      'electron-builder.json',
      'electron-builder.json5',
      'electron-builder.toml',
      'electron-builder.js',
      'electron-builder.cjs',
      'electron-builder.ts',
    ];
    expect(AUTO_DISCOVERED).toContain(CONFIG_FILE);
    expect(fs.existsSync(path.join(root, CONFIG_FILE))).toBe(true);
  });

  it('identifies the app', () => {
    // appId is what Windows keys the install, the shortcut and (later) the
    // upgrade on. Changing it after a release orphans every installed copy.
    expect(config.appId).toBe('com.badsonstudios.switchboard');
    expect(config.productName).toBe('switchboard');
  });

  it('installs PER-USER, which is what makes it UAC-free', () => {
    // The item's headline done-when. perMachine would put the app under
    // Program Files and produce an elevation prompt on every install and every
    // auto-update — the thing E19-04's silent install cannot survive.
    expect(nsis.perMachine).toBe(false);
    expect(nsis.oneClick).toBe(true);
  });

  it('produces the artifact name the release + update items expect', () => {
    // E19-02 uploads this name and E19-03/04 look for it. The literal
    // `${version}` is electron-builder's macro, not a template hole.
    expect(nsis.artifactName).toBe('switchboard-Setup-${version}.exe');
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('unpacks node-pty from the asar', () => {
    // THE assertion of this item. Windows cannot LoadLibrary a .node or .dll
    // out of app.asar, and winpty spawns winpty-agent.exe as a real process
    // from a real path — so a packaged app with node-pty inside the archive
    // opens no terminals at all.
    const unpack = config.asarUnpack as string[];
    expect(unpack.some((p) => p.includes('node-pty'))).toBe(true);
  });

  it('ships an icon that exists and is a real .ico with a 256px entry', () => {
    const icon = String(win.icon);
    const buf = fs.readFileSync(path.join(root, icon));
    expect(buf.readUInt16LE(0)).toBe(0); // reserved
    expect(buf.readUInt16LE(2)).toBe(1); // type 1 = icon
    const count = buf.readUInt16LE(4);
    expect(count).toBeGreaterThan(0);
    // width byte 0 means 256 — electron-builder rejects a Windows icon whose
    // largest entry is smaller than that
    const widths = Array.from({ length: count }, (_, i) => buf[6 + 16 * i]);
    expect(widths).toContain(0);
  });

  it('targets nsis on Windows only (E19 decision 3)', () => {
    const targets = win.target as Array<{ target: string }>;
    expect(targets.map((t) => t.target)).toContain('nsis');
    expect(config.mac).toBeUndefined();
    expect(config.linux).toBeUndefined();
  });

  it('never publishes anything, anywhere (#273)', () => {
    // `null`, NOT absent. app-builder-lib's getPublishConfigs returns null the
    // moment it sees an explicit null and stops before resolving a provider.
    // With the key missing, electron-builder 26 escalates an unset policy to
    // `onTagOrDraft` on CI detection, infers a github provider from the git
    // remote to write update info, and kills a fully-successful build with
    // "GitHub Personal Access Token is not set" — which is exactly what
    // release.yml's first dry run did. Releases are made by `gh release create`
    // in the release job and by nothing else (E19 decision 2).
    expect('publish' in config, `${CONFIG_FILE} must set publish explicitly`).toBe(true);
    expect(config.publish).toBeNull();
  });

  it('says so at the invocation site too, so CI never escalates the policy', () => {
    // Belt and braces, and the thing electron-builder's own warning asks for:
    // with `--publish never` the implicit-publishing branch is never taken at
    // all, so the CI log stops claiming publishing was triggered. The
    // pass-through args follow it, so `npm run package -- --dir` still works.
    const script = read('scripts/package.js').replace(/\s+/g, ' ');
    expect(script).toContain("'--publish', 'never', ...process.argv.slice(2)");
  });

  it('writes to dist/, and dist/ is gitignored', () => {
    const dirs = config.directories as { output: string };
    expect(dirs.output).toBe('dist');
    expect(read('.gitignore').split(/\r?\n/)).toContain('dist/');
  });

  it('ships the build output and the manifest', () => {
    expect(files).toContain('out/**');
    expect(files).toContain('package.json');
  });
});

/**
 * The one assumption in `files` that can break the packaged app silently.
 *
 * The allowlist ships node-pty and nothing else from node_modules, because
 * electron-vite bundles everything that is not native. That is true TODAY. The
 * day someone adds a runtime dependency to main or preload — anything
 * `externalizeDepsPlugin` will leave as a bare `require()` — the dev build
 * keeps working (node_modules is right there) and only the INSTALLED app
 * throws MODULE_NOT_FOUND, which is the worst possible place to find out.
 *
 * So: derive the set from the source, and fail here instead.
 */
describe('the node_modules allowlist covers what the main-process bundle imports', () => {
  /** every .ts under a dir, excluding vitest files */
  function sources(dir: string): string[] {
    const abs = path.join(root, dir);
    if (!fs.existsSync(abs)) return [];
    return fs
      .readdirSync(abs, { withFileTypes: true })
      .flatMap((e) =>
        e.isDirectory()
          ? sources(path.join(dir, e.name))
          : e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')
            ? [path.join(dir, e.name)]
            : []
      );
  }

  /** `foo`, `foo/bar` and `@scope/foo/bar` all resolve to their package root */
  function packageRoot(spec: string): string {
    const parts = spec.split('/');
    return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  }

  const SPECIFIER = /(?:from\s+|require\(\s*|import\(\s*)['"]([^'"]+)['"]/g;

  // src/shared is in the scan because it is BUNDLED INTO main: a dependency
  // imported there becomes an external `require()` in main's output just as
  // surely as one imported by src/main itself.
  const imported = new Set<string>();
  for (const file of [...sources('src/main'), ...sources('src/preload'), ...sources('src/shared')]) {
    for (const m of read(file).matchAll(SPECIFIER)) {
      const spec = m[1];
      if (spec.startsWith('.') || spec.startsWith('/')) continue;
      imported.add(packageRoot(spec));
    }
  }

  // `dependencies` only: electron and every devDependency are supplied by the
  // runtime or compiled away, and node builtins are not packages at all.
  const runtimeDeps = [...imported].filter((d) => d in pkg.dependencies).sort();

  const shipped = (dep: string) =>
    files.some((p) => !p.startsWith('!') && p.startsWith(`node_modules/${dep}/`));

  it('finds runtime deps at all (guards against the guard passing on an empty list)', () => {
    // node-pty is the whole reason this file exists; if the scan stops seeing
    // it, the scan is broken, not the config.
    expect(runtimeDeps).toContain('node-pty');
  });

  it('every runtime dependency of main/preload is in the packaged files list', () => {
    const missing = runtimeDeps.filter((d) => !shipped(d));
    expect(
      missing,
      `main/preload require these at runtime but ${CONFIG_FILE}'s \`files\` allowlist does not ` +
        'ship them — the installed app would throw MODULE_NOT_FOUND. Add a ' +
        '`node_modules/<pkg>/**` pattern (and asarUnpack it if it is native).'
    ).toEqual([]);
  });

  it('the allowlist has no entries for packages nothing imports', () => {
    // The other direction: a pattern left behind for a dependency that was
    // dropped ships dead weight and reads like a requirement.
    const stale = files
      .filter((p) => !p.startsWith('!') && p.startsWith('node_modules/'))
      .map((p) => packageRoot(p.slice('node_modules/'.length)))
      .filter((d, i, a) => a.indexOf(d) === i)
      .filter((d) => !runtimeDeps.includes(d));
    expect(stale, 'shipped but never imported by main or preload').toEqual([]);
  });
});
