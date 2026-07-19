import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['out/**', 'dist/**', 'node_modules/**', 'spike/**', '.claude/**'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // §5.20: color values live ONLY in theme/tokens.css. Any raw color
    // literal in renderer code is a lint failure.
    files: ['src/renderer/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': [
        'error',
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
