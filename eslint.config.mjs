import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import react from 'eslint-plugin-react';

// A useEffect arrow with an EXPRESSION body hands its value to React as the
// effect's cleanup. That crashed the whole renderer once (E9-02): Chromium's
// scrollIntoView({block}) returns a Promise, React called it as a cleanup, and
// the tree unmounted to a blank window. Braces make the return explicit; an
// effect that really does return a cleanup disables this by name, in one line.
const EFFECT_BODY_MESSAGE =
  'useEffect callback must use a block body — an expression body silently returns its value as the cleanup.';
// §5.20's net for a colour written by hand instead of taken from a token.
// It used to be `#[0-9a-fA-F]{3,8}\b`, which reads most of this repo's ISSUE
// NUMBERS as colours — `'#358'` is three hex digits — and cost #358 a test
// title (#365). Comments were never affected; only string literals. Three facts
// separate a colour from a reference:
//
//   • a CSS hex colour is 3, 4, 6 or 8 digits — `#12345` is neither;
//   • an issue reference is DECIMAL, so a token carrying a–f is always a colour;
//   • this repo's issue numbers are 3–4 digits, so ONLY the all-numeric short
//     forms are genuinely ambiguous (`#358` is also the colour `#335588`).
//
// The ambiguous ones are then decided by position: an all-numeric 3–4 digit
// token is a colour when it is the WHOLE string (`{ color: '#000' }` — how
// every inline style in this tree writes one) and an issue reference when it
// sits inside a sentence. Everything else is a colour wherever it appears.
//
// Known gap, accepted: an all-numeric shorthand inside a longer CSS string
// (`'1px solid #000'`) reads as prose and slips through. Nothing in this tree
// writes one — the template-literal styles all interpolate a token
// (`1px solid ${hue}`) — and closing it would take the issue numbers back.
const HEX = '[0-9a-fA-F]';
/** 3, 4, 6 or 8 hex digits, not part of a longer run */
const HEX_RUN = `(?:${HEX}{8}|${HEX}{6}|${HEX}{4}|${HEX}{3})(?!${HEX})`;
/** the same run, narrowed to the shapes no issue number can wear */
const COLOR_RUN = `(?:${HEX}{8}|${HEX}{6}|(?=${HEX}*[a-fA-F])(?:${HEX}{4}|${HEX}{3}))(?!${HEX})`;
const HEX_COLOR = `^\\s*#${HEX_RUN}\\s*$|#${COLOR_RUN}`;
const HEX_MESSAGE = 'Raw hex color — use a token from theme/tokens.css (var(--...)).';

const EFFECT_BODY_RULES = [
  {
    selector:
      "CallExpression[callee.name='useEffect'] > ArrowFunctionExpression[body.type!='BlockStatement']",
    message: EFFECT_BODY_MESSAGE,
  },
  {
    selector:
      "CallExpression[callee.property.name='useEffect'] > ArrowFunctionExpression[body.type!='BlockStatement']",
    message: EFFECT_BODY_MESSAGE,
  },
];

export default tseslint.config(
  { ignores: ['out/**', 'dist/**', 'node_modules/**', 'spike/**', '.claude/**'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // §5.21: user-visible strings go through i18n — no JSX text literals.
    files: ['src/renderer/**/*.tsx'],
    plugins: { react },
    rules: {
      'react/jsx-no-literals': [
        'error',
        { noStrings: true, ignoreProps: true, noAttributeStrings: false },
      ],
    },
  },
  {
    // effect-cleanup guard applies everywhere (see EFFECT_BODY_RULES above)
    files: ['src/**/*.{ts,tsx}'],
    rules: { 'no-restricted-syntax': ['error', ...EFFECT_BODY_RULES] },
  },
  {
    // §5.23 + P2-E15-04: every IPC channel goes through the broker, which is
    // what makes the capability check unavoidable. The TYPE system stops you
    // registering an UNTAGGED channel; only this stops you registering outside
    // the broker entirely, which would reopen the whole hole with one import.
    files: ['src/main/**/*.ts'],
    ignores: ['src/main/ipc/**'],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...EFFECT_BODY_RULES,
        {
          selector: "ImportSpecifier[imported.name='ipcMain']",
          message:
            'Register IPC through IpcBroker (src/main/ipc/broker.ts), not ipcMain directly — the broker is where the capability check lives (P2-E15-04).',
        },
        {
          selector: "MemberExpression[object.name='ipcMain']",
          message: 'Use IpcBroker (src/main/ipc/broker.ts) instead of ipcMain directly.',
        },
      ],
    },
  },
  {
    // §5.23: src/shared is imported by BOTH processes, so it must not reach
    // into either. An import from main/ or renderer/ would bundle that
    // process's code into the other and quietly re-make the contribution
    // registry main-only — the exact defect P2-E15-02 fixed (AR-P0-2).
    files: ['src/shared/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': ['error', ...EFFECT_BODY_RULES],
      'no-restricted-imports': [
        'error',
        {
          patterns: ['**/main/**', '**/renderer/**', '../main*', '../renderer*'],
        },
      ],
    },
  },
  {
    // §5.20: color values live ONLY in theme/tokens.css. Renderer files match
    // the block above too, and flat config REPLACES a rule's options rather
    // than merging them — so this last-matching object must repeat the effect
    // rules, or they'd be silently dropped for the renderer.
    files: ['src/renderer/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...EFFECT_BODY_RULES,
        {
          selector: `Literal[value=/${HEX_COLOR}/]`,
          message: HEX_MESSAGE,
        },
        {
          selector: `TemplateElement[value.raw=/${HEX_COLOR}/]`,
          message: HEX_MESSAGE,
        },
        {
          selector: 'Literal[value=/\\brgba?\\(/]',
          message: 'Raw rgb() color — use a token from theme/tokens.css (var(--...)).',
        },
      ],
      // #191: the diff pane imports monaco from `edcore.main` (core editor, no
      // languages) and puts the Monarch tokenizers back by hand. The package
      // root — and the four `language/*` services it pulls in — assume a
      // per-language web worker this app does not bundle, and throw uncaught
      // `Missing requestHandler or method: ...` the moment a model is given a
      // language id. Measured at 8 page errors per session (#161). One import
      // is all it takes to bring that back, so it is a lint error.
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'monaco-editor',
              message:
                "Import 'monaco-editor/esm/vs/editor/edcore.main' instead — the package root loads the rich language services, which throw against this app's single plain worker (#191). See src/renderer/src/lib/monaco-languages.ts.",
            },
          ],
          patterns: [
            {
              group: [
                'monaco-editor/esm/vs/editor/editor.main*',
                'monaco-editor/esm/vs/language/*',
              ],
              message:
                "Rich monaco language services need their own web workers, which this app does not bundle (#191). Register a Monarch tokenizer in src/renderer/src/lib/monaco-languages.ts instead.",
            },
          ],
        },
      ],
    },
  },
  {
    // #255: src/ joins e2e/ on the TYPE-CHECKED preset — WHOLE, with no rule
    // held off anywhere. The switch surfaced 552 errors, so it landed in five
    // tranches (T0 config + autofixes, T1/T2 product, T3/T4 tests), each one
    // deleting its own `rules: { … 'off' }` block in the same PR as its fixes.
    // T4 was the last; nothing is left to delete, and the whole campaign added
    // not one inline disable comment anywhere under `src/`.
    //
    // Two blocks, not one, because `src/shared/**` is a member of BOTH tsconfigs
    // and a `project` ARRAY resolves a file against the first project that
    // happens to include it — one block would quietly type-lint shared through
    // the node lens while looking like it considered both. Two blocks say which
    // lens each tree is checked under, out loud.
    //
    // `src/*.ts` (test-setup, test-temp-dirs, test-fake-timers) are the node
    // project's root-level members; without the second glob they would be the
    // only files under src/ left on the untyped tier.
    files: ['src/{main,preload,shared,build}/**/*.{ts,tsx,mts,cts}', 'src/*.{ts,tsx,mts,cts}'],
    ignores: ['**/__eslint-probe__*'],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        project: './tsconfig.node.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // The renderer half of the block above. `tsconfig.web.json` is the same
    // project `npm run typecheck` uses, so lint and tsc see one program.
    //
    // `ignores` (both blocks): `scripts/eslint-hex-rule.test.js` lints snippets
    // at the fictional path `src/renderer/src/__eslint-probe__.ts` — "the file
    // never has to exist; the path is what picks the config block". Under
    // `parserOptions.project` a path in no tsconfig is a FATAL parse error, and
    // one fatal message makes ESLint drop every other message for that text, so
    // all 13 of those tests go red. The probe only ever exercises the untyped
    // `no-restricted-syntax` rules, so keeping it off the typed tier costs
    // nothing and needs no change to the test.
    files: ['src/renderer/**/*.{ts,tsx,mts,cts}'],
    ignores: ['**/__eslint-probe__*'],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        project: './tsconfig.web.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // `require-await` was 365 of the 552 errors the switch surfaced, and 270 of
    // those are React Testing Library's `act(async () => …)`: the callback is
    // `async` to ASK React for the async path, not because an `await` went
    // missing. The rule takes no options in typescript-eslint 8.64, so it is
    // per-glob all-or-nothing — and a test file is the one place in this tree
    // where an `async` with no `await` is routinely load-bearing rather than a
    // mistake.
    //
    // This is the campaign's ONLY carve-out, and it is a scoped rule-off with a
    // reason rather than a disable comment: PRODUCT code keeps `require-await`
    // everywhere, in both processes. The three product hits it had were fixed
    // by saying what the function really is — `() => Promise.resolve(x)` where
    // the contract is the return type (T1's `credentialStoreToken.resolve`,
    // T2's bridge stub), and a plain `void` where nothing was ever async
    // (T2's `moveHome`).
    files: ['src/**/*.test.{ts,tsx}'],
    rules: { '@typescript-eslint/require-await': 'off' },
  },
  {
    // e2e/ is the one tree on the TYPE-CHECKED preset (#245). The rest of the
    // repo is on plain `recommended`; here the extra rules earn their keep,
    // because a spec's assertion is only as good as the types under it — an
    // `any` leaking out of a boundary (`JSON.parse` on the workspace file was
    // the big one) makes `expect(x.foo).toBe(...)` compile no matter what `foo`
    // is, and a spec that cannot fail to compile is not a spec.
    //
    // The glob is wider than what exists today ON PURPOSE: `tsconfig.e2e.json`
    // includes `e2e/**/*`, so a future `.tsx`/`.mts` in here would typecheck and
    // then silently drop back to the untyped tier if this only said `.ts`.
    // `tsconfig.e2e.json` is the same project `npm run typecheck` uses, so lint
    // and tsc see one program.
    files: ['e2e/**/*.{ts,tsx,mts,cts}', 'playwright.config.ts'],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        project: './tsconfig.e2e.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // electron-builder.js sits at the root (the only place, and under the only
    // name, electron-builder auto-discovers it) but is the same kind of file as
    // these: plain CJS, run by node outside any bundler.
    files: ['scripts/**/*.js', 'electron-builder.js'],
    ignores: ['scripts/**/*.test.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: {
        require: 'readonly',
        module: 'readonly',
        process: 'readonly',
        __dirname: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        Buffer: 'readonly',
      },
    },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    // vitest files under scripts/ are ESM (vite transforms them), unlike the
    // CJS scripts they test — so they must not inherit the block above.
    files: ['scripts/**/*.test.js'],
    languageOptions: {
      sourceType: 'module',
      // `ignores` on the block above strips its globals too, so restate them
      // (`Buffer` for #435's tests, which assert on raw bytes)
      globals: { process: 'readonly', console: 'readonly', Buffer: 'readonly' },
    },
  }
);
