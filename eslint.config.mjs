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
    },
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
      globals: { process: 'readonly', console: 'readonly' },
    },
  }
);
