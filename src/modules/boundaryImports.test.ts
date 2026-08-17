/**
 * **Foundation M11 — the dependency-graph rule, and the gate's documentation.**
 *
 * foundation IMPLEMENTATION §11: *"A dependency-graph test fails if any
 * `src/modules/<feature>` file imports from another `src/modules/<feature>` —
 * cross-module access must go through the registry or bus."* And: *"The full
 * suite runs in CI on every change and is documented as the gate for merging
 * changes to config, module wiring, or listeners."*
 *
 * ## Why a lint rule and not only a grep
 *
 * The rule this file enforces is `eslint.config.js`'s `no-restricted-imports`
 * block, not a regular expression written here. That is the difference between a
 * boundary a developer meets when they type the import — in the editor, in the
 * pre-commit `npm run lint`, in `npm run ci` — and one they meet after the fact
 * in a test whose failure message is a path. §6.1 is a design rule about how the
 * elements are allowed to know about each other, and the tool that owns "which
 * imports are allowed" is the linter.
 *
 * So what this file does is **prove the rule fires**. Every case below is a
 * fixture linted through the repository's real ESLint configuration:
 *
 * - a violation of each tier, for **every** feature module against **every**
 *   sibling, so a new element added to the tree without a rule fails here;
 * - the legitimate imports each tier must keep allowing, so the rule cannot be
 *   satisfied by banning everything;
 * - a control asserting the fixture harness reports *no* error for clean code,
 *   because a harness that always errored would pass every case above.
 *
 * The fixtures are linted from memory (`ESLint#lintText`) against paths that do
 * not exist, so nothing is written into the tree and nothing has to be cleaned
 * up. Type-aware rules are switched off for the fixture run only — they need a
 * real file in the TypeScript project, and `no-restricted-imports` is a purely
 * syntactic rule that does not.
 *
 * ## The hole the lint rule cannot close, and who closes it
 *
 * `no-restricted-imports` sees `import`, `import type` and `export … from`. It
 * does **not** see `await import('…')` or `require('…')` — verified by the
 * fixture table below, which records that gap rather than assuming it away. The
 * tree-wide scan in the last section is what covers those two forms, over every
 * shipped file in every feature module. Between them the two halves cover every
 * way one module's file can name another's.
 *
 * ## The documented exception surface
 *
 * Stated once, here, because "no feature module imports another" is not quite
 * what the tree does:
 *
 * 1. **Shipped source: no exceptions at all.** Not even a type-only import of a
 *    sibling's ports file. An erased import still couples the two elements'
 *    source trees, and §6.1's purpose is that removing a module breaks no
 *    compile anywhere else. What a module needs from a sibling it declares
 *    locally — `orchestrator/ports.ts`, `runner/contracts.ts` — and adapts from
 *    whatever `ctx.require` returns.
 * 2. **Test scaffolding (`*.test.ts`, `__tests__/`, `__fixtures__/`,
 *    `__spike__/`): a sibling's pure units, but never its wiring.** A
 *    cross-element *agreement* test has to see both sides — `projects`'
 *    handoff test really does need roster's session compiler, `roster`'s seed
 *    test really does need orchestrator's seat constants — and no product
 *    dependency is created by a test file. What stays forbidden is importing a
 *    sibling's `index`/`module`/`service`/`routes`: constructing a sibling
 *    module is the lifecycle coupling tier 1 exists to prevent, and a test that
 *    needs two real modules running boots them through `src/main.ts`.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';

import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import { beforeAll, describe, expect, it } from 'vitest';

import { repoRoot } from './__tests__/helpers.js';

const MODULES_DIR = join(repoRoot, 'src', 'modules');

/**
 * The feature modules, discovered from the tree rather than listed.
 *
 * A hard-coded list would make the most important failure — a **new** element
 * added with no boundary rule — invisible, because the new element would not be
 * in the list doing the checking. A feature module is a directory under
 * `src/modules/` with an `index.ts`, which is exactly what the composition root
 * imports.
 */
function featureModules(): readonly string[] {
  return readdirSync(MODULES_DIR)
    .filter((entry) => statSync(join(MODULES_DIR, entry)).isDirectory())
    .filter((entry) => !entry.startsWith('__'))
    .filter((entry) => {
      try {
        return statSync(join(MODULES_DIR, entry, 'index.ts')).isFile();
      } catch {
        return false;
      }
    })
    .sort();
}

const FEATURES = featureModules();

// ---------------------------------------------------------------------------
// The lint rule, proven against fixtures
// ---------------------------------------------------------------------------

/**
 * The repository's real configuration, with type-aware linting switched off.
 *
 * `projectService` resolves a file against `tsconfig.json`, and a fixture path
 * is by design not in it. Turning the type-aware rules off is the whole of the
 * difference from `npm run lint`; the `no-restricted-imports` configuration
 * under test is read from `eslint.config.js` exactly as CI reads it.
 */
function fixtureLinter(): ESLint {
  return new ESLint({
    cwd: repoRoot,
    overrideConfig: [
      tseslint.configs.disableTypeChecked,
      {
        files: ['**/*.ts'],
        languageOptions: {
          parser: tseslint.parser,
          parserOptions: { projectService: false, project: null },
        },
      },
    ] as ESLint.Options['overrideConfig'],
  });
}

let linter: ESLint;

beforeAll(() => {
  linter = fixtureLinter();
});

interface Finding {
  readonly ruleId: string | null;
  readonly message: string;
}

/** Lints one fixture as if it were `path`, and returns what ESLint said. */
async function lintFixture(path: string, code: string): Promise<readonly Finding[]> {
  const [result] = await linter.lintText(code, { filePath: join(repoRoot, path) });
  const messages = result?.messages ?? [];
  // A parse error would make every "no error" assertion below vacuously true.
  for (const message of messages) {
    expect(message.fatal ?? false, `${path}: ${message.message}`).toBe(false);
  }
  return messages.map((message) => ({ ruleId: message.ruleId, message: message.message }));
}

async function restrictedImports(path: string, code: string): Promise<readonly Finding[]> {
  return (await lintFixture(path, code)).filter(
    (finding) => finding.ruleId === 'no-restricted-imports',
  );
}

describe('M11 — a feature module may not import a sibling feature module (§6.1)', () => {
  it('rejects a sibling import from shipped source, for every feature against every sibling', async () => {
    // Every ordered pair, so the rule cannot be right for the pair someone
    // happened to test and missing for the rest — and so an element added to
    // `src/modules/` with no rule in `eslint.config.js` fails here.
    expect(FEATURES.length).toBeGreaterThanOrEqual(5);

    for (const feature of FEATURES) {
      for (const sibling of FEATURES.filter((other) => other !== feature)) {
        const findings = await restrictedImports(
          `src/modules/${feature}/fixture.ts`,
          `import { thing } from '../${sibling}/service.js';\nexport const used = thing;\n`,
        );
        expect(findings.length, `${feature} -> ${sibling}`).toBe(1);
        expect(findings[0]?.message).toContain('§6.1');
        expect(findings[0]?.message).toContain(feature);
      }
    }
  });

  it('rejects a type-only sibling import too — an erased import still couples the trees', async () => {
    const findings = await restrictedImports(
      'src/modules/orchestrator/fixture.ts',
      "import type { RosterService } from '../roster/service.js';\nexport type Alias = RosterService;\n",
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain('ctx.require');
  });

  it('rejects `export … from` and a sibling reached from a nested directory', async () => {
    // Two spellings the relative depth or the statement kind could have hidden.
    expect(
      await restrictedImports(
        'src/modules/projects/fixture.ts',
        "export * from '../runner/repository.js';\n",
      ),
    ).toHaveLength(1);
    expect(
      await restrictedImports(
        'src/modules/projects/nested/fixture.ts',
        "import { x } from '../../runner/repository.js';\nexport const y = x;\n",
      ),
    ).toHaveLength(1);
  });

  it('allows the imports §6.1 leaves open: foundation, the module system, and the element itself', async () => {
    // The negative control. A rule that banned everything would satisfy every
    // assertion above and stop the codebase compiling — these are the imports
    // every feature module makes on every line of every file.
    for (const specifier of [
      '../../config/index.js',
      '../../storage/index.js',
      '../../secrets/index.js',
      '../types.js',
      '../registry.js',
      './repository.js',
      './types.js',
      'node:path',
      'zod',
    ]) {
      expect(
        await restrictedImports(
          'src/modules/projects/fixture.ts',
          `import { thing } from '${specifier}';\nexport const used = thing;\n`,
        ),
        specifier,
      ).toEqual([]);
    }
  });
});

describe('M11 — the exception surface: a test may see a sibling’s units, never its wiring', () => {
  const TEST_PATHS = [
    'src/modules/projects/fixture.test.ts',
    'src/modules/projects/__tests__/helper.ts',
    'src/modules/projects/__fixtures__/sample.ts',
  ];

  it('allows the cross-element agreement imports the suite actually relies on', async () => {
    // These are the real imports in the tree today — `projects` reading roster's
    // session compiler and orchestrator's ports, `remote` reading runner's fake
    // query. Tier 2 exists for them, and naming them here is what makes the
    // exception a documented surface rather than a blanket amnesty.
    for (const specifier of [
      '../roster/compileSession.js',
      '../roster/permissions.js',
      '../roster/sessionOptions.js',
      '../roster/__tests__/fixtures.js',
      '../orchestrator/ports.js',
      '../orchestrator/patterns.js',
      '../orchestrator/toolset.js',
      '../runner/__tests__/fakeQuery.js',
    ]) {
      expect(
        await restrictedImports(
          'src/modules/projects/fixture.test.ts',
          `import { thing } from '${specifier}';\nexport const used = thing;\n`,
        ),
        specifier,
      ).toEqual([]);
    }
  });

  it('rejects a sibling’s wiring from every kind of test file', async () => {
    for (const path of TEST_PATHS) {
      const depth = path.includes('/__') ? '../..' : '..';
      for (const wiring of ['index.js', 'module.js', 'service.js', 'routes.js']) {
        const findings = await restrictedImports(
          path,
          `import { thing } from '${depth}/roster/${wiring}';\nexport const used = thing;\n`,
        );
        expect(findings.length, `${path} -> ${wiring}`).toBe(1);
        expect(findings[0]?.message).toContain('src/main.ts');
      }
      // A bare directory import resolves to `index.ts`, so it is the same thing
      // spelled differently and must fail the same way.
      expect(
        await restrictedImports(
          path,
          `import { thing } from '${depth}/roster';\nexport const used = thing;\n`,
        ),
        path,
      ).toHaveLength(1);
    }
  });

  it('does not mistake a unit whose name starts like a wiring file for wiring', async () => {
    // `roster/moduleWatcher.js` is not `roster/module.js`; a prefix match would
    // say it was, and the exception surface would be narrower than documented.
    expect(
      await restrictedImports(
        'src/modules/projects/fixture.test.ts',
        "import { thing } from '../roster/moduleHelpers.js';\nexport const used = thing;\n",
      ),
    ).toEqual([]);
  });

  it('reports nothing at all for a clean fixture, so the harness is not always failing', async () => {
    expect(
      await lintFixture(
        'src/modules/projects/fixture.ts',
        "import { join } from 'node:path';\nexport const there = join('a', 'b');\n",
      ),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The tree-wide scan: the forms the lint rule cannot see
// ---------------------------------------------------------------------------

/** Removes comments, preserving line structure so a report names a real line. */
function stripComments(source: string): string {
  const blank = (text: string): string => text.replace(/[^\n]/gu, ' ');
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, blank)
    .replace(
      /(^|[^:/])\/\/[^\n]*/gu,
      (match, keep: string) => keep + blank(match.slice(keep.length)),
    );
}

/**
 * Every module specifier in a source file, in any form a specifier can take:
 * `from '…'`, a bare `import '…'`, `import('…')` and `require('…')`.
 */
function specifiers(source: string): readonly string[] {
  const code = stripComments(source);
  const found: string[] = [];
  for (const match of code.matchAll(
    /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)(['"])([^'"]+)\1/gu,
  )) {
    const specifier = match[2];
    if (specifier !== undefined) found.push(specifier);
  }
  return found;
}

/** The shipped `.ts` files of one feature module, as repo-relative paths. */
function shippedSources(feature: string): readonly string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry.startsWith('__')) continue;
      const child = join(dir, entry);
      if (statSync(child).isDirectory()) {
        walk(child);
        continue;
      }
      if (!entry.endsWith('.ts') || entry.endsWith('.test.ts')) continue;
      found.push(relative(repoRoot, child).replaceAll('\\', '/'));
    }
  };
  walk(join(MODULES_DIR, feature));
  return found;
}

/** True when `specifier` names something inside a feature module other than `self`. */
function crossesInto(self: string, specifier: string): string | undefined {
  for (const other of FEATURES) {
    if (other === self) continue;
    const pattern = new RegExp(`^(?:\\.\\./)+${other}(?:/|$)|(?:^|/)modules/${other}(?:/|$)`, 'u');
    if (pattern.test(specifier)) return other;
  }
  return undefined;
}

describe('M11 — the tree-wide dependency graph, including the forms ESLint cannot see', () => {
  it('records that a dynamic import is invisible to the lint rule, which is why this scan exists', async () => {
    // Not a complaint about ESLint: `no-restricted-imports` is documented as a
    // rule about import *declarations*. Pinning the gap makes the division of
    // labour below deliberate, and turns "someone should check" into a test that
    // fails the day the rule grows to cover it and this scan becomes redundant.
    expect(
      await restrictedImports(
        'src/modules/projects/fixture.ts',
        "export const late = await import('../roster/service.js');\n",
      ),
    ).toEqual([]);
  });

  it('finds every specifier form when it scans, so the scan is not vacuously clean', () => {
    // The positive control for the scanner itself, over a sample carrying each
    // form once — plus a comment and a URL, which a naive stripper eats.
    const sample = [
      "// import { a } from '../roster/commented.js';",
      "/* import { b } from '../roster/blocked.js'; */",
      '// see https://example.invalid/docs',
      "import { c } from '../roster/statement.js';",
      "import type { D } from '../projects/typed.js';",
      "export * from '../runner/reexport.js';",
      "const e = await import('../orchestrator/dynamic.js');",
      "const f = require('../remote/required.js');",
      "import './sideEffect.js';",
    ].join('\n');

    const found = specifiers(sample);
    expect(found).toEqual([
      '../roster/statement.js',
      '../projects/typed.js',
      '../runner/reexport.js',
      '../orchestrator/dynamic.js',
      '../remote/required.js',
      './sideEffect.js',
    ]);
    // And the matcher agrees about which of those cross an element boundary.
    expect(found.filter((specifier) => crossesInto('roster', specifier) !== undefined)).toEqual([
      '../projects/typed.js',
      '../runner/reexport.js',
      '../orchestrator/dynamic.js',
      '../remote/required.js',
    ]);
  });

  it('has no shipped file in any feature module naming another feature module', () => {
    const offenders: { file: string; specifier: string; sibling: string }[] = [];
    let scanned = 0;

    for (const feature of FEATURES) {
      const files = shippedSources(feature);
      // Each element must actually contribute files: a path filter that matched
      // nothing would report a clean graph forever.
      expect(files.length, feature).toBeGreaterThanOrEqual(5);
      scanned += files.length;

      for (const file of files) {
        for (const specifier of specifiers(readFileSync(join(repoRoot, file), 'utf8'))) {
          const sibling = crossesInto(feature, specifier);
          if (sibling !== undefined) offenders.push({ file, specifier, sibling });
        }
      }
    }

    expect(offenders).toEqual([]);
    expect(scanned).toBeGreaterThan(60);
  });

  it('leaves the composition root free to import them all, because that is its job', () => {
    // The one file that must know how the elements fit together (§6.2). It is
    // not under `src/modules/<feature>/`, so neither the lint rule nor the scan
    // above applies to it — stated here so the omission is a decision.
    const main = readFileSync(join(repoRoot, 'src', 'main.ts'), 'utf8');
    const imported = specifiers(main).filter(
      (specifier) => crossesInto('main', specifier) !== undefined,
    );
    for (const feature of FEATURES) {
      expect(
        imported.some((specifier) => specifier.includes(`/${feature}/`)),
        feature,
      ).toBe(true);
    }
    // …and remote only ever as a dynamic import or a type (§6.2's edition gate).
    for (const specifier of imported.filter((value) => value.includes('/remote/'))) {
      expect(main).toMatch(
        new RegExp(`(?:import type[^;]*|await import\\()\\s*['"]${specifier}['"]`, 'u'),
      );
    }
  });
});

// ---------------------------------------------------------------------------
// The gate, documented
// ---------------------------------------------------------------------------

describe('M11 — the suite is the documented CI gate for config, module wiring and listeners', () => {
  const scripts = (
    JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    }
  ).scripts;

  it('is reachable through the single `test:boundary` entry point', () => {
    // §11's last criterion is about reachability, so it is asserted rather than
    // trusted: these two files must be *selected* by the script's own filters,
    // not merely exist. `__filename` is compared against each positional token
    // the script passes to vitest, which is how vitest itself selects files.
    const script = scripts['test:boundary'] ?? '';
    const tokens = script
      .split(/\s+/u)
      .filter((token) => !token.startsWith('-') && !['vitest', 'run', 'server'].includes(token));
    const here = fileURLToPath(import.meta.url).replaceAll('\\', '/');
    const inventory = here.replace('boundaryImports', 'boundaryInventory');

    expect(
      tokens.some((token) => here.includes(token)),
      script,
    ).toBe(true);
    expect(
      tokens.some((token) => inventory.includes(token)),
      script,
    ).toBe(true);
    // The element-scoped import check runner wrote first is in the gate too —
    // its filename does not contain "boundary", so it has to be named.
    expect(script).toContain('src/modules/runner/boundaries.test.ts');
  });

  it('cannot be skipped by running the ordinary commands', () => {
    // `npm test` runs every file, and `npm run ci` runs `lint` — which is where
    // the import rule itself is enforced, so the gate covers both halves of M11.
    expect(scripts['test']).toContain('vitest run');
    expect(scripts['ci']).toContain('npm run lint');
    expect(scripts['ci']).toContain('npm test');
  });

  it('says in the README what the gate covers and when it is required', () => {
    const readme = readFileSync(join(repoRoot, 'README.md'), 'utf8');
    expect(readme).toMatch(/merge gate/iu);
    expect(readme).toContain('npm run test:boundary');
    // §11's wording: "the gate for merging changes to config, module wiring, or
    // listeners". All three, plus the two rules M11 itself adds.
    for (const phrase of ['config validation', 'module wiring', 'listeners']) {
      expect(readme, phrase).toContain(phrase);
    }
    expect(readme).toMatch(/module inventory/iu);
    expect(readme).toMatch(/no-restricted-imports/u);
  });
});
