/**
 * The `projects` repository (§1.4).
 *
 * Columns are the projects element's; foundation ships the table and this
 * repository because sessions, assignments and events all key on it, and §1.3
 * forbids any element hand-writing SQL against another element's table.
 *
 * `local_path_key` is the canonical lowercased identity key: two registrations
 * of the same directory under different casings are the same project, which is
 * a Windows fact the schema has to know.
 */
import { RecordNotFoundError } from '../errors.js';
import { newId } from '../ids.js';
import type { Database } from '../sqlite.js';
import type { Clock } from '../time.js';
import { isoTimestamp } from '../time.js';
import { orNull, runRestrictedDelete } from './sql.js';

export interface ProjectRecord {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly localPath: string | null;
  readonly localPathKey: string | null;
  readonly repoUrl: string | null;
  readonly defaultBranch: string | null;
  readonly vcs: string | null;
  readonly notes: string | null;
  readonly status: string;
  readonly workspacePolicy: string | null;
  readonly defaultsJson: string | null;
  readonly retentionJson: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastActivityAt: string | null;
  readonly archivedAt: string | null;
}

export interface ProjectInput {
  /** Defaults to a fresh ULID. */
  readonly id?: string;
  readonly slug: string;
  readonly name: string;
  readonly localPath?: string | null;
  /**
   * Defaults to `localPath` lowercased — the canonical identity key. Supplied
   * explicitly only when the projects element has a better canonicalisation
   * (resolved symlinks, short paths) than lowercasing.
   */
  readonly localPathKey?: string | null;
  readonly repoUrl?: string | null;
  readonly defaultBranch?: string | null;
  readonly vcs?: string | null;
  readonly notes?: string | null;
  readonly status?: string;
  readonly workspacePolicy?: string | null;
  readonly defaultsJson?: string | null;
  readonly retentionJson?: string | null;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly lastActivityAt?: string | null;
  readonly archivedAt?: string | null;
}

/** Every column a project may be updated through. `updated_at` is maintained here. */
export type ProjectPatch = Partial<Omit<ProjectInput, 'id' | 'createdAt' | 'updatedAt'>>;

export interface ListProjectsOptions {
  readonly includeArchived?: boolean;
}

export interface ProjectsRepository {
  create(input: ProjectInput): ProjectRecord;
  get(id: string): ProjectRecord | undefined;
  getBySlug(slug: string): ProjectRecord | undefined;
  /** Identity lookup: "is this directory already a project?" */
  getByPathKey(localPathKey: string): ProjectRecord | undefined;
  list(options?: ListProjectsOptions): readonly ProjectRecord[];
  update(id: string, patch: ProjectPatch): ProjectRecord;
  /** Stamps `last_activity_at` (and `updated_at`). Cheap enough to call per session event. */
  touch(id: string, at?: string): void;
  archive(id: string, at?: string): ProjectRecord;
  /**
   * Deletes the project.
   *
   * Throws `RestrictedDeleteError` when any session or assignment still
   * references it — §1.4's "deleting a project with history is refused;
   * archive instead", enforced by the database rather than by a check here that
   * could race.
   */
  delete(id: string): boolean;
}

interface ProjectRow {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly local_path: string | null;
  readonly local_path_key: string | null;
  readonly repo_url: string | null;
  readonly default_branch: string | null;
  readonly vcs: string | null;
  readonly notes: string | null;
  readonly status: string;
  readonly workspace_policy: string | null;
  readonly defaults_json: string | null;
  readonly retention_json: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly last_activity_at: string | null;
  readonly archived_at: string | null;
}

const COLUMNS = [
  'id',
  'slug',
  'name',
  'local_path',
  'local_path_key',
  'repo_url',
  'default_branch',
  'vcs',
  'notes',
  'status',
  'workspace_policy',
  'defaults_json',
  'retention_json',
  'created_at',
  'updated_at',
  'last_activity_at',
  'archived_at',
] as const;

/** Maps a patch field to its column. Also the allow-list for `update`. */
const PATCH_COLUMNS: Readonly<Record<keyof ProjectPatch, string>> = {
  slug: 'slug',
  name: 'name',
  localPath: 'local_path',
  localPathKey: 'local_path_key',
  repoUrl: 'repo_url',
  defaultBranch: 'default_branch',
  vcs: 'vcs',
  notes: 'notes',
  status: 'status',
  workspacePolicy: 'workspace_policy',
  defaultsJson: 'defaults_json',
  retentionJson: 'retention_json',
  lastActivityAt: 'last_activity_at',
  archivedAt: 'archived_at',
};

function toRecord(row: ProjectRow): ProjectRecord {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    localPath: row.local_path,
    localPathKey: row.local_path_key,
    repoUrl: row.repo_url,
    defaultBranch: row.default_branch,
    vcs: row.vcs,
    notes: row.notes,
    status: row.status,
    workspacePolicy: row.workspace_policy,
    defaultsJson: row.defaults_json,
    retentionJson: row.retention_json,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastActivityAt: row.last_activity_at,
    archivedAt: row.archived_at,
  };
}

export function createProjectsRepository(db: Database, clock: Clock): ProjectsRepository {
  const list = COLUMNS.join(', ');
  const insert = db.prepare(
    `INSERT INTO projects (${list}) VALUES (${COLUMNS.map(() => '?').join(', ')})`,
  );
  const getStatement = db.prepare<[string], ProjectRow>(
    `SELECT ${list} FROM projects WHERE id = ?`,
  );
  const getBySlug = db.prepare<[string], ProjectRow>(`SELECT ${list} FROM projects WHERE slug = ?`);
  const getByPathKey = db.prepare<[string], ProjectRow>(
    `SELECT ${list} FROM projects WHERE local_path_key = ?`,
  );
  const listAll = db.prepare<[], ProjectRow>(`SELECT ${list} FROM projects ORDER BY name, id`);
  const listLive = db.prepare<[], ProjectRow>(
    `SELECT ${list} FROM projects WHERE archived_at IS NULL ORDER BY name, id`,
  );
  const touchStatement = db.prepare<[string, string, string]>(
    'UPDATE projects SET last_activity_at = ?, updated_at = ? WHERE id = ?',
  );
  const deleteStatement = db.prepare<[string]>('DELETE FROM projects WHERE id = ?');

  function mustGet(id: string): ProjectRecord {
    const row = getStatement.get(id);
    if (row === undefined) throw new RecordNotFoundError('projects', id);
    return toRecord(row);
  }

  const repository: ProjectsRepository = {
    create(input) {
      const now = isoTimestamp(clock());
      const id = input.id ?? newId();
      const localPath = orNull(input.localPath);
      insert.run(
        id,
        input.slug,
        input.name,
        localPath,
        input.localPathKey === undefined
          ? localPath === null
            ? null
            : localPath.toLowerCase()
          : orNull(input.localPathKey),
        orNull(input.repoUrl),
        orNull(input.defaultBranch),
        orNull(input.vcs),
        orNull(input.notes),
        input.status ?? 'active',
        orNull(input.workspacePolicy),
        orNull(input.defaultsJson),
        orNull(input.retentionJson),
        input.createdAt ?? now,
        input.updatedAt ?? input.createdAt ?? now,
        orNull(input.lastActivityAt),
        orNull(input.archivedAt),
      );
      return mustGet(id);
    },

    get: (id) => {
      const row = getStatement.get(id);
      return row === undefined ? undefined : toRecord(row);
    },
    getBySlug: (slug) => {
      const row = getBySlug.get(slug);
      return row === undefined ? undefined : toRecord(row);
    },
    getByPathKey: (key) => {
      const row = getByPathKey.get(key);
      return row === undefined ? undefined : toRecord(row);
    },
    list: (options = {}) =>
      (options.includeArchived === true ? listAll : listLive).all().map(toRecord),

    update(id, patch) {
      const assignments: string[] = [];
      const values: (string | null)[] = [];
      for (const [field, column] of Object.entries(PATCH_COLUMNS)) {
        const value = patch[field as keyof ProjectPatch];
        if (value === undefined) continue;
        assignments.push(`${column} = ?`);
        values.push(value === null ? null : String(value));
      }
      // `updated_at` is never the caller's to set: a patch that could leave it
      // stale would make "what changed since" unanswerable.
      assignments.push('updated_at = ?');
      values.push(isoTimestamp(clock()));

      const changes = db
        .prepare(`UPDATE projects SET ${assignments.join(', ')} WHERE id = ?`)
        .run(...values, id).changes;
      if (changes === 0) throw new RecordNotFoundError('projects', id);
      return mustGet(id);
    },

    touch(id, at) {
      const now = at ?? isoTimestamp(clock());
      touchStatement.run(now, now, id);
    },

    archive: (id, at) => repository.update(id, { archivedAt: at ?? isoTimestamp(clock()) }),

    delete: (id) => runRestrictedDelete('projects', id, () => deleteStatement.run(id).changes),
  };

  return repository;
}
