// Which Monaco language a path in the Changes tab should be tokenized as
// (#191). Pure and monaco-free on purpose, so it is unit-testable in the node
// environment without dragging the editor into the test run; the side-effect
// imports that make these ids real live next door in `monaco-languages.ts`,
// and `diff-language.test.ts` asserts the two lists cannot drift apart.
//
// WHY A TABLE AND NOT MONACO'S OWN REGISTRY
//
// `monaco.languages.getLanguages()` carries every registered language's
// extensions, and matching against it would be one line. It is rejected for
// three reasons:
//
//   1. it can only be exercised from an e2e run — a table is 40 unit
//      assertions that run in milliseconds;
//   2. the registry's claims are VS Code's, not ours: it takes `.m` for
//      Objective-C (it is MATLAB about as often) and the extension-less name
//      `config` for ini. In a read-only diff a wrong tokenizer is worse than
//      no tokenizer, because it paints confident nonsense — so this table
//      drops `.m` and `.svelte` rather than inherit a coin-flip;
//   3. the two gaps below need an explicit answer anyway, and a registry
//      lookup has nowhere to put one.
//
// THE TWO GAPS, both deliberate approximations:
//
//   • JSON has NO Monarch tokenizer in monaco. Its only JSON support is the
//     rich `language/json` service, which needs its own web worker — exactly
//     the thing #191 exists to avoid. JSON is a subset of JavaScript's literal
//     syntax, so `.json` is tokenized as `javascript`: strings, numbers,
//     `true`/`false`/`null` and punctuation all land where they should.
//   • TOML has no tokenizer either. `ini` is the near neighbour — sections,
//     `key = value`, `#` comments — and gets the common case right.

/** Monaco's id for "do not tokenize", and the answer for anything unlisted. */
export const PLAINTEXT = 'plaintext';

/**
 * Lower-cased extension (no dot) -> monaco language id.
 *
 * Every value here MUST be registered in `monaco-languages.ts`. An id that is
 * not registered is not an error at runtime — monaco silently tokenizes the
 * model as plain text — which is precisely the silent defect #191 was filed
 * for, so the test enforces it instead.
 */
const BY_EXTENSION: Readonly<Record<string, string>> = {
  // web / this app's own stack
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  // see "the two gaps" above
  json: 'javascript',
  jsonc: 'javascript',
  json5: 'javascript',
  webmanifest: 'javascript',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'html',
  htm: 'html',
  xhtml: 'html',
  // a Vue SFC IS html with <script>/<style> in it; monaco's html tokenizer
  // handles those blocks. `.svelte` is NOT on this list for the opposite
  // reason — `{#each}` and `$:` would paint as confident nonsense.
  vue: 'html',

  // prose and data
  md: 'markdown',
  markdown: 'markdown',
  mdx: 'mdx',
  yaml: 'yaml',
  yml: 'yaml',
  xml: 'xml',
  xsd: 'xml',
  xsl: 'xml',
  xslt: 'xml',
  svg: 'xml',
  plist: 'xml',
  resx: 'xml',
  csproj: 'xml',
  props: 'xml',
  targets: 'xml',

  // general purpose
  py: 'python',
  pyi: 'python',
  pyw: 'python',
  rs: 'rust',
  go: 'go',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  cs: 'csharp',
  csx: 'csharp',
  // monaco's cpp contribution registers `c` as well as `cpp`, so plain C gets
  // its own keyword set. `.h` stays cpp: it is ambiguous, and C++'s keywords
  // are a superset, so cpp is the choice that mis-colours less.
  c: 'c',
  h: 'cpp',
  cc: 'cpp',
  cpp: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hh: 'cpp',
  hxx: 'cpp',
  // `.mm` only. VS Code claims `.m` for Objective-C and it is MATLAB about as
  // often — the header says a wrong tokenizer is worse than none, so this is
  // where that costs us an extension rather than where we quietly ignore it.
  mm: 'objective-c',
  rb: 'ruby',
  gemspec: 'ruby',
  php: 'php',
  swift: 'swift',
  scala: 'scala',
  sbt: 'scala',
  dart: 'dart',
  lua: 'lua',
  pl: 'perl',
  pm: 'perl',
  r: 'r',

  // shells and build/infra files — the ones an agent's diff is full of
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  ksh: 'shell',
  ps1: 'powershell',
  psm1: 'powershell',
  psd1: 'powershell',
  bat: 'bat',
  cmd: 'bat',
  sql: 'sql',
  dockerfile: 'dockerfile',
  graphql: 'graphql',
  gql: 'graphql',
  proto: 'proto',
  tf: 'hcl',
  tfvars: 'hcl',
  hcl: 'hcl',
  ini: 'ini',
  cfg: 'ini',
  conf: 'ini',
  properties: 'ini',
  // see "the two gaps" above
  toml: 'ini',
};

/**
 * Whole lower-cased file name -> monaco language id, checked first.
 *
 * This is where the extension-less files and the dotfiles go: `.gitignore` and
 * friends have no extension at all by the rule below (`.foo` is a name, not a
 * suffix), so without this table every dotfile would be plain text.
 */
const BY_FILENAME: Readonly<Record<string, string>> = {
  dockerfile: 'dockerfile',
  gemfile: 'ruby',
  rakefile: 'ruby',
  '.bashrc': 'shell',
  '.bash_profile': 'shell',
  '.zshrc': 'shell',
  '.profile': 'shell',
  '.gitconfig': 'ini',
  '.editorconfig': 'ini',
  '.npmrc': 'ini',
  '.env': 'ini',
  '.babelrc': 'javascript',
  '.eslintrc': 'javascript',
  '.prettierrc': 'javascript',
};

/** Every language id the tables can produce, sorted — the registration list. */
export const USED_LANGUAGE_IDS: readonly string[] = [
  ...new Set([...Object.values(BY_EXTENSION), ...Object.values(BY_FILENAME)]),
].sort();

/**
 * The monaco language id for a repo-relative path, or `plaintext`.
 *
 * Takes the path git gave us, which is `/`-separated — but accepts `\` too,
 * because the pane is handed paths from more than one place and a Windows
 * separator leaking in should cost highlighting, not correctness.
 */
export function languageForPath(filePath: string): string {
  const base = filePath.replace(/\\/g, '/').split('/').pop()?.toLowerCase() ?? '';
  const byName = BY_FILENAME[base];
  if (byName) return byName;
  const dot = base.lastIndexOf('.');
  // `dot <= 0` covers both "no dot at all" (README) and "dot at the front"
  // (.gitignore) — a leading dot names the file, it does not introduce a suffix
  if (dot <= 0) return PLAINTEXT;
  return BY_EXTENSION[base.slice(dot + 1)] ?? PLAINTEXT;
}
