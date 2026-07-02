// ESLint 9 flat config for the agent-kgpacks-ts monorepo.
//
// Composes typescript-eslint's recommended rules with eslint-config-prettier so
// ESLint never reports formatting issues that Prettier owns.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.mts', '**/*.cts', '**/*.js', '**/*.mjs', '**/*.cjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // Allow deliberately-unused bindings when prefixed with `_` (e.g. retained
      // parameters kept for API/back-compat, or intentionally-ignored catch vars).
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          args: 'after-used',
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },
  {
    // Browser + JSX language options for the deployable apps (apps/frontend).
    // Additive only: scopes browser globals and JSX parsing to apps/** without
    // changing any rule. The default block above is Node-only and excludes .tsx.
    files: ['apps/**/*.{ts,tsx}'],
    languageOptions: {
      globals: {
        ...globals.browser,
      },
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
  },
  prettier,
);
