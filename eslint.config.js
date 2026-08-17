// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

/**
 * The feature modules of foundation DESIGN §6.1 — the elements that own a
 * `src/modules/<id>/` directory and are wired in by the composition root.
 *
 * Exported so `src/modules/boundaryImports.test.ts` asserts against this list
 * rather than a second copy of it: a new element that is added here and nowhere
 * else must still be caught, and one added to the tree but not here is what that
 * test's inventory check exists to find.
 */
export const FEATURES = ['roster', 'projects', 'runner', 'orchestrator', 'remote'];

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

  // The module-boundary rule of foundation DESIGN §6.1 — "feature modules never
  // import each other directly" — as a first-class lint rule rather than only as
  // a test that greps the tree (foundation IMPLEMENTATION §11).
  //
  // Two tiers, because the rule protects the *product's* dependency graph and a
  // test is not part of it:
  //
  //  1. **Shipped source** (everything not under `__tests__`/`__fixtures__`/
  //     `__spike__` and not a `*.test.ts`): **no** import of a sibling feature
  //     module, in any form. Cross-element access goes through the service
  //     registry (`ctx.require`) or the event bus, and the shape of what comes
  //     back is declared locally — `orchestrator/ports.ts`, `runner/contracts.ts`
  //     — instead of imported from the sibling. There are no exceptions, not even
  //     type-only ones: an erased import still couples the two elements' source
  //     trees, and the whole point of §6.1 is that removing the remote module (or
  //     any other) breaks no compile anywhere else.
  //  2. **Test scaffolding**: a *cross-element agreement* test has to be able to
  //     see both sides, so it may import a sibling's pure units (a compiler, a
  //     permission table, a ports type-guard, a `__tests__/` fixture). What it may
  //     never import is a sibling's **wiring** — `index.ts`, `module.ts`,
  //     `service.ts`, `routes.ts` — because constructing a sibling module is
  //     exactly the lifecycle coupling tier 1 forbids, in test clothing. A test
  //     that needs two real modules running boots them through `src/main.ts`.
  //
  // `src/modules/boundaryImports.test.ts` runs ESLint over fixtures for both
  // tiers, so the rule is proven to fire rather than merely configured.
  //
  // `regex` rather than `group`: a `group` pattern is matched with gitignore
  // semantics, where `../roster` also matches everything *below* `../roster` —
  // which cannot express tier 2's "the directory's wiring files, but not its
  // other files". The regexes below are anchored on the import specifier as
  // written, and cover both the relative spelling every file in the tree uses
  // and an absolute `…/modules/<sibling>` one, so a future path alias is caught.
  ...FEATURES.flatMap((feature) => {
    const siblings = FEATURES.filter((other) => other !== feature).join('|');
    const testFiles = [
      `src/modules/${feature}/**/*.test.ts`,
      `src/modules/${feature}/**/__tests__/**`,
      `src/modules/${feature}/**/__fixtures__/**`,
      `src/modules/${feature}/**/__spike__/**`,
    ];
    /** Anything at all inside a sibling element. */
    const anywhere = `^(?:\\.\\./)+(?:${siblings})(?:/|$)|(?:^|/)modules/(?:${siblings})(?:/|$)`;
    /** Only a sibling's composition surface: what constructs or mounts it. */
    const wiring =
      `^(?:\\.\\./)+(?:${siblings})(?:/(?:index|module|service|routes)\\.js)?$` +
      `|(?:^|/)modules/(?:${siblings})(?:/(?:index|module|service|routes)\\.js)?$`;

    const restrict = (regex, message) => ({
      'no-restricted-imports': ['error', { patterns: [{ regex, message }] }],
    });

    return [
      {
        files: [`src/modules/${feature}/**/*.ts`],
        ignores: testFiles,
        rules: restrict(
          anywhere,
          `foundation DESIGN §6.1: the "${feature}" module must not import another feature module. ` +
            'Reach it through ctx.require(<service>) or the event bus, and declare the shape you need ' +
            'locally (see orchestrator/ports.ts, runner/contracts.ts).',
        ),
      },
      {
        files: testFiles,
        rules: restrict(
          wiring,
          `foundation DESIGN §6.1: a "${feature}" test may import a sibling's pure units, but not its ` +
            'wiring (index/module/service/routes) — constructing a sibling module is the coupling the ' +
            'rule forbids. Boot both through src/main.ts instead.',
        ),
      },
    ];
  }),

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
