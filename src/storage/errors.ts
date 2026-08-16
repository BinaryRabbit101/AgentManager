/**
 * Storage's error vocabulary.
 *
 * Storage is a `critical` module (§6.2): everything here is fatal at boot by
 * design. What matters is that the message tells the owner what to do next —
 * §1.3 requires an integrity failure to be "reported with the backup path to
 * restore from", and a migration failure to name the file that failed.
 */
import type { BackupInfo } from './backups.js';

/** Base class, so the composition root can recognise a storage failure. */
export class StorageError extends Error {
  override readonly name: string = 'StorageError';
}

/**
 * `PRAGMA quick_check` failed, or the file is not a database at all.
 *
 * Fatal (§1.3). The message names the newest backup because that is the only
 * action available: migrations are forward-only and there is no repair path.
 */
export class DatabaseIntegrityError extends StorageError {
  override readonly name = 'DatabaseIntegrityError';

  constructor(
    readonly databasePath: string,
    readonly detail: string,
    readonly backup: BackupInfo | undefined,
    readonly backupsDir: string,
    options?: { cause?: unknown },
  ) {
    super(
      [
        `Database integrity check failed for ${databasePath}: ${detail}.`,
        backup === undefined
          ? `No backup is available in ${backupsDir}; restore an external copy or delete the file to start from an empty database.`
          : `Restore from the newest backup: ${backup.path}`,
      ].join(' '),
      options,
    );
  }
}

/** A numbered migration failed. The transaction was rolled back; the schema is unchanged. */
export class MigrationError extends StorageError {
  override readonly name = 'MigrationError';

  constructor(
    readonly setId: string,
    readonly migrationPath: string,
    detail: string,
    options?: { cause?: unknown },
  ) {
    super(
      `Migration ${migrationPath} (set "${setId}") failed and was rolled back: ${detail}. ` +
        'Migrations are forward-only; fix the migration or restore the pre-migration backup.',
      options,
    );
  }
}

/** The migration directory itself is malformed — a bad filename, a duplicate version. */
export class MigrationSetError extends StorageError {
  override readonly name = 'MigrationSetError';
}

/**
 * A repository was asked to act on a row that is not there.
 *
 * Distinguished from a bare `undefined` return because the two mean different
 * things: `get` returning `undefined` is an answer, while `update` on a missing
 * id is a caller bug that would otherwise succeed silently as a zero-row UPDATE.
 */
export class RecordNotFoundError extends StorageError {
  override readonly name = 'RecordNotFoundError';

  constructor(
    readonly table: string,
    readonly id: string,
  ) {
    super(`No row in ${table} with id ${JSON.stringify(id)}`);
  }
}

/**
 * A delete was refused by an `ON DELETE RESTRICT` foreign key (§1.4).
 *
 * "Deleting a project with history is refused; archive instead." The database
 * enforces it; this type is what makes the reason legible to the caller instead
 * of arriving as a raw `SQLITE_CONSTRAINT_FOREIGNKEY`.
 */
export class RestrictedDeleteError extends StorageError {
  override readonly name = 'RestrictedDeleteError';

  constructor(
    readonly table: string,
    readonly id: string,
    detail: string,
    options?: { cause?: unknown },
  ) {
    super(
      `Refusing to delete ${table} ${JSON.stringify(id)}: rows elsewhere still reference it (${detail}). ` +
        'Archive it instead — history is deliberately protected by ON DELETE RESTRICT (DESIGN §1.4).',
      options,
    );
  }
}

/** Something tried to open a database file this process already holds open (§1.3). */
export class DatabaseAlreadyOpenError extends StorageError {
  override readonly name = 'DatabaseAlreadyOpenError';

  constructor(readonly databasePath: string) {
    super(
      `${databasePath} is already open in this process. ` +
        'The core is the single owner of the database file; open it once and share the handle.',
    );
  }
}

/** Best-effort extraction of a readable reason from an unknown thrown value. */
export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** The SQLite result code of a driver error, when there is one. */
export function sqliteCode(error: unknown): string | undefined {
  if (error instanceof Error && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}
