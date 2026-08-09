// Syntax COLOUR for the Changes tab, and nothing else (#191).
//
// Importing this module for its side effects registers a curated set of
// monaco's Monarch tokenizers. Monarch is a regex state machine that runs on
// the MAIN THREAD — no web worker, no language server, no diagnostics, no
// hovers, no completions. That is the whole design call, and it is the reason
// this file exists instead of a one-line `import 'monaco-editor'`:
//
//   `monaco-editor`'s package entry is `editor.main.js`, which registers the
//   four RICH language services (typescript, json, css, html) on top of the
//   Monarch ones. Those services assume a language-specific web worker. This
//   app bundles ONE worker — the plain `editor.worker` the diff algorithm
//   needs — and `MonacoEnvironment.getWorker` hands it back for every label.
//   The moment a model is given the id `typescript`, the rich TS service
//   starts asking that worker for `getSyntacticDiagnostics`, `provideInlayHints`
//   and `getNavigationTree`, and every request throws
//   `Missing requestHandler or method: ...` as an uncaught page error.
//   MEASURED at 8 uncaught errors per session in #161, which is why #161
//   reverted the one-line fix and filed #191 instead.
//
// So the fix is not "add the language", it is "add the language and drop the
// services". `DiffPane.tsx` imports monaco from `edcore.main` — the core
// editor with NO languages at all — and this file puts back exactly the
// tokenizers, which is all a read-only diff can use: there is nothing to
// complete, nothing to rename, and diagnostics on someone else's
// work-in-progress would be noise, not information.
//
// COST. Each `*.contribution.js` below registers metadata and a `loader` that
// dynamic-imports the actual tokenizer, so vite emits one small lazy chunk per
// language and the app fetches only the ones a diff actually opens. The
// startup cost of a long list is therefore a few hundred bytes of metadata,
// not a few hundred kilobytes of regex — so the list is bounded by usefulness
// rather than by budget. It stops at what an agent's diffs are actually full
// of; monaco ships ~90 of these and adding one is an import here plus a row in
// `diff-language.ts`, which is the whole cost of saying yes later.
//
// Tokenizing runs on the UI thread, per visible line, as monaco renders — so
// it scales with the VIEWPORT, not with the file, and a huge diff costs no
// more than a small one to scroll. Monaco also refuses to tokenize lines over
// `maxTokenizationLineLength` (20k characters, its default), which is what
// keeps a minified bundle in the file list from being a hazard.
//
// And it makes the app SMALLER, which was a surprise worth recording. Measured
// on a clean `npm run build`, out/renderer/assets:
//
//                       before        after
//   total            28,618 kB    10,753 kB
//   files                   94           39
//   main chunk        9,561 kB     9,475 kB
//
// The main chunk barely moves because the rich services are lazy. The 17.9 MB
// is four WORKER bundles vite was emitting for services that could never reach
// them — ts.worker 13,264 kB, css.worker 1,866 kB, html.worker 1,242 kB,
// json.worker 840 kB — shipped in every installer, downloaded by every user,
// and unreachable because `getWorker` ignores its `label`. After this change
// the build emits exactly one worker: `editor.worker`, the one the diff
// algorithm actually uses.
//
// The ids registered here are the ids `diff-language.ts` can produce, and
// `diff-language.test.ts` fails if the two lists ever disagree — an id that is
// mapped but not registered is not an error at runtime, monaco just silently
// tokenizes as plain text, which is the exact defect #191 is about.

import 'monaco-editor/esm/vs/basic-languages/bat/bat.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/cpp/cpp.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/csharp/csharp.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/css/css.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/dart/dart.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/dockerfile/dockerfile.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/go/go.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/graphql/graphql.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/hcl/hcl.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/html/html.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/ini/ini.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/java/java.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/kotlin/kotlin.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/less/less.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/lua/lua.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/mdx/mdx.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/objective-c/objective-c.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/perl/perl.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/php/php.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/powershell/powershell.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/protobuf/protobuf.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/python/python.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/r/r.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/ruby/ruby.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/rust/rust.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/scala/scala.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/scss/scss.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/shell/shell.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/sql/sql.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/swift/swift.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/xml/xml.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/yaml/yaml.contribution.js';
