/**
 * The two boundaries M3's acceptance names, checked statically over this
 * element's own source.
 *
 * 1. **"Runner issues no SQL against `agents`, `projects`, `assignments`, or
 *    `questions` outside foundation's repositories."** Runner composes SQL for
 *    exactly two tables — `sessions`, which it owns (§1), and `session_inputs`,
 *    which arrives in its own migration (§3.5). Everything else goes through
 *    `ctx.store`.
 * 2. **Feature modules never import each other** (foundation §6.1). Runner
 *    reaches roster, projects and orchestrator through the service registry and
 *    the structural contracts in `contracts.ts`; an import of a sibling element
 *    would make the registry decorative.
 *
 * Foundation M11 owns the repository-wide version of both checks. This is the
 * runner-scoped one, written now because M3 is the milestone that could break
 * them: it is the first code that needs another element's data.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const elementRoot = dirname(fileURLToPath(import.meta.url));

/**
 * The element's shipped source: every `.ts` file except tests, fixtures and the
 * M0 spike.
 *
 * Tests are excluded on purpose — the rule is about the SQL runner *issues*,
 * and a fixture that seeds another element's table through foundation's
 * repositories is exactly what the harness is supposed to do.
 */
function sourceFiles(root: string = elementRoot): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root)) {
    if (entry === '__tests__' || entry === '__spike__') continue;
    const path = join(root, entry);
    if (statSync(path).isDirectory()) {
      files.push(...sourceFiles(path));
      continue;
    }
    if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) files.push(path);
  }
  return files;
}

const SQL_KEYWORD =
  /\b(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM|CREATE\s+TABLE|ALTER\s+TABLE|FROM|JOIN)\b/u;

/** Lines that carry SQL, which in this element are all inside `db.prepare(…)`. */
function sqlLines(source: string): string[] {
  return source.split(/\r?\n/u).filter((line) => SQL_KEYWORD.test(line));
}

const FORBIDDEN_TABLES = ['agents', 'projects', 'assignments', 'questions'];
const OWNED_TABLES = ['sessions', 'session_inputs'];

describe('SQL stays inside runner’s own tables (M3 acceptance)', () => {
  it('names only sessions and session_inputs on any SQL-carrying line', () => {
    const offenders: { file: string; sql: string; table: string }[] = [];

    for (const file of sourceFiles()) {
      for (const sql of sqlLines(readFileSync(file, 'utf8'))) {
        for (const table of FORBIDDEN_TABLES) {
          // A word-boundary match, so `session_inputs` cannot be mistaken for
          // `sessions` and `assignmentId` cannot be mistaken for `assignments`.
          if (new RegExp(`\\b${table}\\b`, 'u').test(sql)) {
            offenders.push({ file, sql: sql.trim(), table });
          }
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('still composes SQL for the tables it does own, so the check is not vacuous', () => {
    const all = sourceFiles()
      .map((file) => readFileSync(file, 'utf8'))
      .flatMap(sqlLines)
      .join('\n');

    for (const table of OWNED_TABLES) {
      expect(new RegExp(`\\b${table}\\b`, 'u').test(all)).toBe(true);
    }
  });
});

describe('no feature module imports another (foundation §6.1)', () => {
  it('reaches roster, projects and orchestrator only through the registry', () => {
    const offenders: { file: string; line: string }[] = [];
    const siblingImport = /from\s+'(?:\.\.\/)(?:roster|projects|orchestrator|remote)(?:\/[^']*)?'/u;

    for (const file of sourceFiles()) {
      for (const line of readFileSync(file, 'utf8').split(/\r?\n/u)) {
        if (siblingImport.test(line)) offenders.push({ file, line: line.trim() });
      }
    }

    expect(offenders).toEqual([]);
  });
});
