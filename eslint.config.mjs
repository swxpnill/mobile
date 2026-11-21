import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/dist/**', '**/build/**', '**/.expo/**'] },
  ...tseslint.configs.recommended,
  prettier,
  {
    // Colours come from the theme (canvas tokens, light and Graphite dark), never literals.
    files: ['apps/mobile/src/**/*.{ts,tsx}', 'apps/mobile/app/**/*.{ts,tsx}'],
    ignores: ['apps/mobile/src/theme/tokens.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'Literal[value=/^#[0-9a-fA-F]{3,8}$|^rgba?[(]/]',
          message: 'Use a theme token (src/theme/tokens.ts) instead of a raw colour.',
        },
      ],
    },
  },
);
