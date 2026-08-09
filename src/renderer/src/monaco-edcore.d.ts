// Types for monaco's `edcore.main` entry point (#191).
//
// monaco-editor ships declarations for two entries only — the package root
// (`editor.main.d.ts`, the editor PLUS the four rich language services) and
// `editor.api.d.ts` (the API surface alone). `edcore.main.js` — the core
// editor with no languages, which is the entry this app deliberately uses so
// those services never load — has no `.d.ts` beside it, so TypeScript cannot
// resolve the import at all.
//
// Its runtime exports are exactly `editor.api2.js`'s, which is what
// `editor.api.d.ts` describes: the same `editor`/`languages` namespaces, the
// same `Environment`, minus the css/html/json/typescript service namespaces we
// are not importing and must not use. Re-exporting `editor.api` is therefore
// not an approximation — it is the honest shape, and it is narrower than the
// package root's in exactly the right place.
declare module 'monaco-editor/esm/vs/editor/edcore.main' {
  // `.js` on purpose: monaco's package `exports` map is a literal `"./*":
  // "./*"`, so an extensionless specifier substitutes to a path that is not on
  // disk and resolves to nothing — quietly, as an empty module rather than an
  // error. With the extension it substitutes to `editor.api.js`, which TS then
  // pairs with `editor.api.d.ts`.
  export * from 'monaco-editor/esm/vs/editor/editor.api.js';
}
