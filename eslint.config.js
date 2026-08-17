// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    // `app/**` is the emitted web bundle (vite.config.ts), not source.
    ignores: ['dist/**', 'app/**', 'node_modules/**', 'coverage/**', '.claude/**'],
  },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Unused args are fine when prefixed with `_` — matches the placeholder-heavy
      // shape of early milestones.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },

  // The frontend. Its own tsconfig (web/tsconfig.json) is what `projectService`
  // finds, which is what gives type-aware rules the DOM lib and the JSX setting.
  {
    files: ['web/**/*.ts', 'web/**/*.tsx'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },

  // Config files live outside tsconfig's `include`, so type-aware rules cannot apply.
  {
    files: ['**/*.js', '**/*.mjs', '*.config.ts'],
    extends: [tseslint.configs.disableTypeChecked],
  },

  // Plain JavaScript has `no-undef` on (TypeScript's own checker replaces it in
  // .ts files), so the two environments that have any need their globals named.
  // Named one by one rather than by pulling in `globals`: this is the complete
  // list either file uses, and a transitive dependency is not a dependency.
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: { console: 'readonly', process: 'readonly' },
    },
  },
  {
    // `web/public/theme-boot.js` — the pre-paint theme stamp (§14.2). It runs in
    // the browser before the bundle and is therefore not part of it.
    files: ['web/public/**/*.js'],
    languageOptions: {
      globals: { window: 'readonly', document: 'readonly' },
    },
  },

  // Must stay last: turns off every rule Prettier owns.
  prettier,
);
