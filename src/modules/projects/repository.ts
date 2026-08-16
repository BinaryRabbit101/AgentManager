/**
 * `ProjectRepository` — typed CRUD over the registry (projects IMPLEMENTATION M1).
 *
 * ## What is stored where, and why this file is split across two owners
 *
 * The `projects` **table** is foundation's: it ships it in `0001_init.sql`
 * because sessions, assignments and events all key on it (foundation §1.4), and
 * §1.3 forbids any element hand-writing SQL against a table it does not own. So
 * every read and write of a project row here goes through
 * {@link ProjectsRepository}, foundation's repository — never through SQL of our
 * own. What this file adds on top is the *typing*: `defaults_json` and
 * `retention_json` become {@link ProjectDefaults} and {@link RetentionSettings},
 * `vcs` / `status` / `workspace_policy` become their unions, and a row missing
 * any of them reads back with the design's defaults applied rather than as
 * `null`.
 *
 * `project_default_agents` is a different matter: it is **this element's own
 * table**, shipped by this element's migration set, and the SQL against it lives
 * here because there is nowhere else it could honestly live.
 *
 * ## Identity
 *
 * Every lookup that means "is this directory already a project?" goes through
 * `local_path_key` (§7.4). The repository never canonicalises — `paths.ts` does,
 * once, and callers pass the result — so there is exactly one implementation of
 * the rule that `C:\Code\App` and a junction pointing at it are one project.
 */
import { isoTimestamp } from '../../storage/index.js';
import type { Clock, Database, ProjectRecord, ProjectsRepository } from '../../storage/index.js';

import {
  EMPTY_PROJECT_DEFAULTS,
  parseProjectDefaults,
  parseRetention,
  serializeProjectDefaults,
  serializeRetention,
  type ParseWarning,
} from './defaults.js';
import { dedupeSlug } from './slug.js';
import {
  isProjectStatus,
  isVcs,
  isWorkspacePolicy,
  type Project,
  type ProjectDefaults,
  type ProjectStatus,
  type RetentionDefaults,
  type RetentionSettings,
  type Vcs,
  type WorkspacePolicy,
} from './types.js';

/** Everything a new project row needs. Paths arrive already canonical. */
export interface CreateProjectInput {
  readonly name: string;
  /** Must already be free; use {@link ProjectRepository.allocateSlug} to get one. */
  readonly slug: string;
  /** Canonical display form (§1.1). */
  readonly localPath: string;
  /** Canonical lowercased identity key (§7.4). */
  readonly localPathKey: string;
  readonly vcs: Vcs;
  readonly repoUrl?: string | null;
  readonly defaultBranch?: string | null;
  readonly notes?: string;
  readonly status?: ProjectStatus;
  readonly workspacePolicy?: WorkspacePolicy;
  readonly defaults?: ProjectDefaults;
  /** Omitted or `null` = inherit the global retention settings (§3.3). */
  readonly retention?: RetentionSettings | null;
}

/** Every field a project may be updated through. `updatedAt` is not the caller's. */
export interface UpdateProjectPatch {
  readonly name?: string;
  readonly slug?: string;
  readonly localPath?: string;
  readonly localPathKey?: string;
  readonly vcs?: Vcs;
  readonly repoUrl?: string | null;
  readonly defaultBranch?: string | null;
  readonly notes?: string;
  readonly status?: ProjectStatus;
  readonly workspacePolicy?: WorkspacePolicy;
  readonly defaults?: ProjectDefaults;
  readonly retention?: RetentionSettings | null;
}

export interface ListProjectsOptions {
  readonly includeArchived?: boolean;
}

export interface ProjectRepository {
  create(input: CreateProjectInput): Project;
  get(id: string): Project | undefined;
  getBySlug(slug: string): Project | undefined;
  /** Identity lookup (§7.4). The key must already be canonical and lowercased. */
  getByPathKey(localPathKey: string): Project | undefined;
  list(options?: ListProjectsOptions): readonly Project[];
  update(id: string, patch: UpdateProjectPatch): Project;
  archive(id: string, at?: string): Project;
  /** Stamps `last_activity_at` — called when a session starts on the project. */
  touch(id: string, at?: string): void;
  /**
   * Deletes the registry row and, by cascade, this element's rows for it.
   *
   * Never touches the project folder (§7.10), and is refused by foundation's
   * `ON DELETE RESTRICT` when sessions or assignments still reference the
   * project — archive instead.
   */
  delete(id: string): boolean;
  /** The first free slug in the `app`, `app-2`, `app-3` series (§1.1). */
  allocateSlug(name: string): string;
  /** The ordered default-agent list (§1.2), read from `project_default_agents`. */
  defaultAgents(projectId: string): readonly string[];
  /** Replaces the whole ordered list. Duplicates collapse, order is preserved. */
  setDefaultAgents(projectId: string, agentIds: readonly string[]): void;
}

export interface ProjectRepositoryOptions {
  /**
   * Used **only** for `project_default_agents`, this element's own table.
   *
   * The `projects` table is reached exclusively through {@link ProjectsRepository}.
   */
  readonly db: Database;
  /** Foundation's repository — the sanctioned path to the `projects` table (§1.3). */
  readonly projects: ProjectsRepository;
  /** The globals a partial `retention_json` is completed from (§3.3). */
  readonly retentionDefaults: RetentionDefaults;
  readonly clock: Clock;
  /** Told about anything a stored blob had to discard; the module logs it. */
  readonly onWarning?: (projectId: string, message: string) => void;
}

interface DefaultAgentRow {
  readonly agent_id: string;
}

export function createProjectRepository(options: ProjectRepositoryOptions): ProjectRepository {
  const { db, projects, retentionDefaults, clock } = options;

  const selectAgents = db.prepare<[string], DefaultAgentRow>(
    'SELECT agent_id FROM project_default_agents WHERE project_id = ? ORDER BY "rank", agent_id',
  );
  const deleteAgents = db.prepare<[string]>(
    'DELETE FROM project_default_agents WHERE project_id = ?',
  );
  const insertAgent = db.prepare<[string, string, number]>(
    'INSERT INTO project_default_agents (project_id, agent_id, "rank") VALUES (?, ?, ?)',
  );

  const replaceAgents = db.transaction((projectId: string, agentIds: readonly string[]): void => {
    deleteAgents.run(projectId);
    // `PRIMARY KEY (project_id, agent_id)` makes a repeated id a constraint
    // failure rather than a duplicate row, so the list is de-duplicated here
    // and the *first* mention keeps its position.
    const seen = new Set<string>();
    let rank = 0;
    for (const agentId of agentIds) {
      if (agentId.length === 0 || seen.has(agentId)) continue;
      seen.add(agentId);
      insertAgent.run(projectId, agentId, rank);
      rank += 1;
    }
  });

  function warningsFor(projectId: string): ParseWarning | undefined {
    const sink = options.onWarning;
    return sink === undefined ? undefined : (message): void => sink(projectId, message);
  }

  /** One row, with its JSON columns typed and its default agents joined back on. */
  function toProject(record: ProjectRecord): Project {
    const warn = warningsFor(record.id);
    const defaults = parseProjectDefaults(record.defaultsJson, warn);
    const agentIds = selectAgents.all(record.id).map((row) => row.agent_id);

    return {
      id: record.id,
      slug: record.slug,
      name: record.name,
      // NOT NULL in the projects element's column contract (§1.1) but nullable
      // in foundation's shipped table, which several elements share. An empty
      // string is the only honest reading of a project row with no path.
      localPath: record.localPath ?? '',
      localPathKey: record.localPathKey ?? '',
      repoUrl: record.repoUrl,
      defaultBranch: record.defaultBranch,
      vcs: isVcs(record.vcs) ? record.vcs : 'none',
      notes: record.notes ?? '',
      status: isProjectStatus(record.status) ? record.status : 'active',
      workspacePolicy: isWorkspacePolicy(record.workspacePolicy) ? record.workspacePolicy : 'auto',
      defaults: { ...defaults, agentIds },
      retention: parseRetention(record.retentionJson, retentionDefaults, warn),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      lastActivityAt: record.lastActivityAt,
      archivedAt: record.archivedAt,
    };
  }

  function mustGet(id: string): Project {
    const record = projects.get(id);
    if (record === undefined) {
      throw new Error(`Internal error: project ${id} vanished between write and read.`);
    }
    return toProject(record);
  }

  return {
    create(input) {
      const defaults = input.defaults ?? EMPTY_PROJECT_DEFAULTS;
      // One transaction, so a project can never exist without the default-agent
      // list it was created with.
      return db.transaction((): Project => {
        const record = projects.create({
          slug: input.slug,
          name: input.name,
          localPath: input.localPath,
          localPathKey: input.localPathKey,
          repoUrl: input.repoUrl ?? null,
          defaultBranch: input.defaultBranch ?? null,
          vcs: input.vcs,
          notes: input.notes ?? '',
          status: input.status ?? 'active',
          workspacePolicy: input.workspacePolicy ?? 'auto',
          defaultsJson: serializeProjectDefaults(defaults),
          retentionJson: serializeRetention(input.retention ?? null),
        });
        if (defaults.agentIds.length > 0) replaceAgents(record.id, defaults.agentIds);
        return toProject(projects.get(record.id) ?? record);
      })();
    },

    get: (id) => {
      const record = projects.get(id);
      return record === undefined ? undefined : toProject(record);
    },
    getBySlug: (slug) => {
      const record = projects.getBySlug(slug);
      return record === undefined ? undefined : toProject(record);
    },
    getByPathKey: (key) => {
      const record = projects.getByPathKey(key);
      return record === undefined ? undefined : toProject(record);
    },
    list: (listOptions = {}) =>
      projects
        .list(listOptions.includeArchived === true ? { includeArchived: true } : {})
        .map(toProject),

    update(id, patch) {
      return db.transaction((): Project => {
        projects.update(id, {
          ...(patch.name === undefined ? {} : { name: patch.name }),
          ...(patch.slug === undefined ? {} : { slug: patch.slug }),
          ...(patch.localPath === undefined ? {} : { localPath: patch.localPath }),
          ...(patch.localPathKey === undefined ? {} : { localPathKey: patch.localPathKey }),
          ...(patch.vcs === undefined ? {} : { vcs: patch.vcs }),
          ...(patch.repoUrl === undefined ? {} : { repoUrl: patch.repoUrl }),
          ...(patch.defaultBranch === undefined ? {} : { defaultBranch: patch.defaultBranch }),
          ...(patch.notes === undefined ? {} : { notes: patch.notes }),
          ...(patch.status === undefined ? {} : { status: patch.status }),
          ...(patch.workspacePolicy === undefined
            ? {}
            : { workspacePolicy: patch.workspacePolicy }),
          ...(patch.defaults === undefined
            ? {}
            : { defaultsJson: serializeProjectDefaults(patch.defaults) }),
          // `retention: null` is a real instruction — "go back to inheriting the
          // globals" — so it is applied, while `undefined` leaves the column alone.
          ...(patch.retention === undefined
            ? {}
            : { retentionJson: serializeRetention(patch.retention) }),
        });
        if (patch.defaults !== undefined) replaceAgents(id, patch.defaults.agentIds);
        return mustGet(id);
      })();
    },

    archive: (id, at) => {
      projects.archive(id, at);
      return mustGet(id);
    },

    touch: (id, at) => {
      projects.touch(id, at ?? isoTimestamp(clock()));
    },

    delete: (id) => projects.delete(id),

    allocateSlug: (name) =>
      dedupeSlug(name, (candidate) => projects.getBySlug(candidate) !== undefined),

    defaultAgents: (projectId) => selectAgents.all(projectId).map((row) => row.agent_id),

    setDefaultAgents: (projectId, agentIds) => {
      replaceAgents(projectId, agentIds);
    },
  };
}
