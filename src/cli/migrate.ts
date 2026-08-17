/**
 * `agentmanager migrate` — "create the data root tree and tighten its ACL to the
 * current user … run the DB migration to create the schema" (DESIGN §4.4),
 * available to the installer without being PowerShell's to implement.
 *
 * It is `openStorage` and nothing else: the same bootstrap, the same pragmas,
 * the same pre-migration backup, the same `quick_check`. An installer that
 * created the tree itself would be a second implementation of §1.2 that drifts
 * from the one the service uses on every boot.
 *
 * **Which migrations run.** Foundation's numbered core set, and only that. The
 * element-owned sets of §1.3 are applied "in module topological order — the same
 * order `dependsOn` produces at start-up", and that order exists only inside the
 * composition root's module graph; reproducing it here would mean a second
 * module list to keep in step, which is the exact failure §1.3 avoids by
 * deriving the order from `dependsOn` in one place. So this verb brings the tree
 * and the core schema into existence, and the first `serve` applies the rest.
 * The installer's "start the core and wait for `/healthz`" step is what makes
 * that a complete install rather than a partial one, and the output says so.
 *
 * **The library directory.** Created, ACL'd with the rest of the tree, and left
 * empty: "its contents are roster's on first run", §4.4. Nothing here writes
 * `roster.json`, a `.gitignore`, or an agent.
 */
import { openStorage } from '../storage/index.js';

import { resolveInstall } from './resolve.js';
import { hasFlag, type CommandInput } from './types.js';

export interface MigrateReport {
  readonly dataRoot: string;
  readonly edition: string;
  readonly database: string;
  readonly libraryRoot: string;
  readonly installId: string;
  /** `PRAGMA user_version` after foundation's core set. */
  readonly schemaVersion: number;
  /** Filenames applied by this run; empty on a re-run, which is the idempotence proof. */
  readonly applied: readonly string[];
  /** Pre-migration copy, present only when something was applied. */
  readonly backupPath?: string;
  /**
   * True when this run changed the schema. The installer prints a different line
   * for "created" than for "already up to date", and both are successes.
   */
  readonly changed: boolean;
}

export function runMigrateCommand(input: CommandInput): number {
  const { ctx } = input;
  const { loaded, paths } = resolveInstall(input);

  const storage = openStorage({
    dataRoot: paths.dataRoot,
    libraryRoot: paths.library,
    worktreesRoot: paths.worktrees,
    ...(ctx.migrationsDir === undefined ? {} : { migrationsDir: ctx.migrationsDir }),
    retention: {
      eventDays: loaded.config.retention.eventDays,
      eventMaxRows: loaded.config.retention.eventMaxRows,
    },
    clock: ctx.clock,
    ...(ctx.tightenAcl === undefined ? {} : { tightenAcl: ctx.tightenAcl }),
    ...(ctx.storageAcl === undefined ? {} : { acl: ctx.storageAcl }),
  });

  try {
    const applied = storage.applied.map(
      (migration) => `${migration.setId}:${String(migration.version)}_${migration.name}`,
    );
    const report: MigrateReport = {
      dataRoot: paths.dataRoot,
      edition: loaded.config.edition,
      database: paths.database,
      libraryRoot: paths.library,
      installId: storage.installId,
      schemaVersion: storage.schemaVersion,
      applied,
      changed: applied.length > 0,
      ...(storage.backupPath === undefined ? {} : { backupPath: storage.backupPath }),
    };

    if (hasFlag(input, '--json')) {
      ctx.io.out(JSON.stringify(report, null, 2));
      return 0;
    }

    ctx.io.out(`data root      ${report.dataRoot}`);
    ctx.io.out(`edition        ${report.edition}`);
    ctx.io.out(`database       ${report.database}`);
    ctx.io.out(`library        ${report.libraryRoot} (contents are the roster's, left untouched)`);
    ctx.io.out(`schema version ${String(report.schemaVersion)}`);
    ctx.io.out(
      report.changed
        ? `applied        ${String(applied.length)} migration(s): ${applied.join(', ')}`
        : 'applied        nothing; the schema was already up to date',
    );
    if (report.backupPath !== undefined) ctx.io.out(`backup         ${report.backupPath}`);
    ctx.io.out(
      'Element-owned migrations are applied by the core on its first start, in module ' +
        'dependency order (DESIGN §1.3).',
    );
    return 0;
  } finally {
    // Leaves a single self-contained .db with no WAL siblings, so the core's
    // first open is not recovering after an installer.
    storage.close();
  }
}
