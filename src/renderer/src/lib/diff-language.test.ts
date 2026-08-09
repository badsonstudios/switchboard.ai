import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { languageForPath, PLAINTEXT, USED_LANGUAGE_IDS } from './diff-language';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../../..');

describe('languageForPath', () => {
  it('maps this app\'s own stack', () => {
    expect(languageForPath('src/renderer/src/App.tsx')).toBe('typescript');
    expect(languageForPath('src/main/index.ts')).toBe('typescript');
    expect(languageForPath('scripts/ev.js')).toBe('javascript');
    expect(languageForPath('src/renderer/src/theme/tokens.css')).toBe('css');
    expect(languageForPath('src/renderer/index.html')).toBe('html');
    expect(languageForPath('PROGRESS.md')).toBe('markdown');
    expect(languageForPath('.github/workflows/ci.yml')).toBe('yaml');
  });

  it('tokenizes JSON as javascript, because monaco has no Monarch JSON', () => {
    // Deliberate — the only JSON support monaco ships is the rich language
    // service, which needs its own worker. See diff-language.ts.
    expect(languageForPath('package.json')).toBe('javascript');
    expect(languageForPath('tsconfig.json')).toBe('javascript');
  });

  it('tokenizes TOML as ini, its nearest neighbour', () => {
    expect(languageForPath('Cargo.toml')).toBe('ini');
  });

  it('covers the common languages an agent edits', () => {
    expect(languageForPath('main.py')).toBe('python');
    expect(languageForPath('src/lib.rs')).toBe('rust');
    expect(languageForPath('cmd/serve.go')).toBe('go');
    expect(languageForPath('App.java')).toBe('java');
    expect(languageForPath('Program.cs')).toBe('csharp');
    expect(languageForPath('vec.h')).toBe('cpp');
    expect(languageForPath('app.rb')).toBe('ruby');
    expect(languageForPath('index.php')).toBe('php');
    expect(languageForPath('build.gradle.kts')).toBe('kotlin');
    expect(languageForPath('deploy.sh')).toBe('shell');
    expect(languageForPath('scripts/new-pr.ps1')).toBe('powershell');
    expect(languageForPath('switchboard.cmd')).toBe('bat');
    expect(languageForPath('migrations/001.sql')).toBe('sql');
    expect(languageForPath('infra/main.tf')).toBe('hcl');
  });

  it('matches whole file names for the ones with no extension', () => {
    expect(languageForPath('Dockerfile')).toBe('dockerfile');
    expect(languageForPath('services/api/Dockerfile')).toBe('dockerfile');
    expect(languageForPath('Gemfile')).toBe('ruby');
    expect(languageForPath('.editorconfig')).toBe('ini');
  });

  it('is case-insensitive and takes only the last path segment', () => {
    expect(languageForPath('SRC/App.TSX')).toBe('typescript');
    expect(languageForPath('docs/README.MD')).toBe('markdown');
    // a directory that looks like a file must not decide the answer
    expect(languageForPath('some.ts/notes.md')).toBe('markdown');
  });

  it('accepts backslash separators', () => {
    // the pane is handed paths from more than one place; a Windows separator
    // leaking in should cost highlighting, not correctness
    expect(languageForPath('src\\main\\index.ts')).toBe('typescript');
    expect(languageForPath('C:\\Projects\\app\\Dockerfile')).toBe('dockerfile');
  });

  it('falls back to plaintext instead of guessing', () => {
    expect(languageForPath('LICENSE')).toBe(PLAINTEXT);
    expect(languageForPath('notes.txt')).toBe(PLAINTEXT);
    expect(languageForPath('.gitignore')).toBe(PLAINTEXT);
    expect(languageForPath('a.wat')).toBe(PLAINTEXT);
    // left plain on purpose rather than guessed — see the header
    expect(languageForPath('matrix.m')).toBe(PLAINTEXT);
    expect(languageForPath('Counter.svelte')).toBe(PLAINTEXT);
    // ...but the unambiguous sibling is still recognised
    expect(languageForPath('View.mm')).toBe('objective-c');
    expect(languageForPath('')).toBe(PLAINTEXT);
    expect(languageForPath('trailing.')).toBe(PLAINTEXT);
  });

});

/**
 * The drift guard (#191).
 *
 * A language id that `diff-language.ts` maps to but `monaco-languages.ts`
 * never registers does NOT throw — monaco quietly tokenizes the model as plain
 * text. That silent failure is the whole bug this item fixed, so it gets a
 * test rather than a comment.
 *
 * Read as source text on purpose: importing `monaco-languages.ts` would pull
 * the entire editor (and its CSS) into the unit run, which is precisely what
 * keeping `diff-language.ts` monaco-free bought us.
 */
describe('monaco-languages.ts registers exactly what diff-language.ts maps', () => {
  const source = fs.readFileSync(path.join(HERE, 'monaco-languages.ts'), 'utf8');
  const imported = [...source.matchAll(/^import '([^']+\.contribution\.js)';$/gm)].map(
    (m) => m[1]
  );

  it('imports contributions, and no duplicates', () => {
    expect(imported.length).toBeGreaterThan(0);
    expect(new Set(imported).size, 'duplicate import').toBe(imported.length);
  });

  it('every imported contribution file exists', () => {
    for (const spec of imported) {
      expect(fs.existsSync(path.join(REPO_ROOT, 'node_modules', spec)), spec).toBe(true);
    }
  });

  /**
   * The ids one contribution file registers. Its own declaration, not its
   * folder name — `protobuf/protobuf.contribution.js` registers `proto`, and
   * `cpp/cpp.contribution.js` registers both `c` and `cpp`.
   */
  const idsOf = (spec: string): string[] => {
    const text = fs.readFileSync(path.join(REPO_ROOT, 'node_modules', spec), 'utf8');
    return [...text.matchAll(/\bid:\s*"([^"]+)"/g)].map((m) => m[1]);
  };

  it('registers every id the tables can produce', () => {
    const registered = new Set(imported.flatMap(idsOf));
    const missing = USED_LANGUAGE_IDS.filter((id) => !registered.has(id));
    expect(missing, 'mapped but never registered — these silently render as plain text').toEqual(
      []
    );
  });

  it('imports nothing the tables never ask for', () => {
    // dead weight in the other direction: a registration no path can reach
    const used = new Set(USED_LANGUAGE_IDS);
    const unreachable = imported.filter((spec) => !idsOf(spec).some((id) => used.has(id)));
    expect(unreachable, 'registered but unreachable — no extension maps to it').toEqual([]);
  });
});
