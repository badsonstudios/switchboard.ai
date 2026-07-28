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
          selector: 'Literal[value=/#[0-9a-fA-F]{3,8}\\b/]',
          message: 'Raw hex color — use a token from theme/tokens.css (var(--...)).',
        },
        {
          selector: 'TemplateElement[value.raw=/#[0-9a-fA-F]{3,8}\\b/]',
          message: 'Raw hex color — use a token from theme/tokens.css (var(--...)).',
        },
        {
          selector: 'Literal[value=/\\brgba?\\(/]',
          message: 'Raw rgb() color — use a token from theme/tokens.css (var(--...)).',
        },
      ],
    },
  },
  {
    files: ['scripts/**/*.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { require: 'readonly', module: 'readonly', process: 'readonly', __dirname: 'readonly', console: 'readonly' },
    },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  }
);
