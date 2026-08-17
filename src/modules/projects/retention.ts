/**
 * Transcript retention (projects DESIGN §3.3, §7.1; IMPLEMENTATION M5).
 *
 * > "**Metadata (assignments, sessions, tokens, summaries) is kept
 * > indefinitely.** […] **Transcript files** are pruned by a daily job: older
 * > than `transcriptDays`, or oldest-first once the project exceeds
 * > `transcriptCapMb`."
 *
 * Three properties of this file are the design, not implementation detail.
 *
 * **The size measure is a column, never a directory walk.** §3.3 is explicit
 * about why: "foundation's transcript tree is grouped by month rather than by
 * project and has no per-project directory to measure". So the cap is checked
 * against `SUM(sessions.transcript_bytes)` — foundation's
 * `sessions.transcriptBytesByProject`, one indexed read — and nothing here ever
 * opens the transcripts root. A test proves it by making the column disagree
 * with the files: the column is what trips the cap.
 *
 * **The entry survives its transcript.** Pruning "deletes the file, NULLs
 * `sessions.transcript_path` in the same transaction […] and zeroes
 * `transcript_bytes`. The entry stays in the timeline." Both halves are
 * foundation's `TranscriptStore.prune`, which orders the file delete before the
 * row update deliberately (foundation §1.5) — so this file calls it rather than
 * reimplementing either half.
 *
 * **Pinned is absolute.** "Sessions with `pinned` set are exempt from both
 * paths." Not "unless the cap is badly exceeded": a pin is the user saying keep
 * this, and a retention job that overrides it is a retention job nobody trusts
 * enough to leave enabled.
 *
 * Archiving does not prune (§3.3), which is why the job walks archived projects
 * too — for the *age* rule they are ordinary projects; it is only *removal* that
 * asks the user whether to prune.
 */
import type { SessionRecord, SessionsRepository, TranscriptStore } from '../../storage/index.js';

import type { ProjectRepository } from './repository.js';
import type { Project, RetentionDefaults, RetentionSettings } from './types.js';

/** What one project's prune did. Ids, not counts: the log names what it removed. */
export interface ProjectPruneResult {
  readonly projectId: string;
  /** Sessions pruned for being older than `transcriptDays`. */
  readonly byAge: readonly string[];
  /** Sessions pruned oldest-first to get back under `transcriptCapMb`. */
  readonly byCap: readonly string[];
  /** `SUM(transcript_bytes)` after the job — the number the cap is checked on. */
  readonly bytesAfter: number;
}

export interface RetentionRunResult {
  readonly projects: readonly ProjectPruneResult[];
  readonly pruned: number;
}

export interface RetentionDeps {
  readonly projects: ProjectRepository;
  readonly sessions: SessionsRepository;
  /** Foundation's store: it owns the layout, the delete and the row update (§3.2). */
  readonly transcripts: Pick<TranscriptStore, 'prune'>;
  /** The globals a project with `retention_json` NULL inherits (§3.3). */
  readonly defaults: RetentionDefaults;
  readonly log?: (message: string, detail?: Record<string, unknown>) => void;
}

/** §3.3: "a project may override either number"; `null` inherits both. */
export function effectiveRetention(
  project: Pick<Project, 'retention'>,
  defaults: RetentionDefaults,
): RetentionSettings {
  return project.retention ?? { ...defaults };
}

/**
 * The instant a session's transcript is dated from.
 *
 * `endedAt` when it has one, `startedAt` otherwise — a session still running has
 * not aged out yet, and one that never started has no transcript to age. A
 * session with neither is left alone rather than treated as infinitely old.
 */
export function transcriptAge(session: SessionRecord): string | undefined {
  return session.endedAt ?? session.startedAt ?? undefined;
}

/** Everything on the project whose transcript is still on disk and prunable. */
function prunable(
  sessions: SessionsRepository,
  projectId: string,
  keepPinned: boolean,
): readonly SessionRecord[] {
  return sessions
    .list({ projectId })
    .filter((session) => session.transcriptPath !== null)
    .filter((session) => !(keepPinned && session.pinned));
}

/** Oldest first, so the cap rule takes the least useful transcript first (§3.3). */
function oldestFirst(sessions: readonly SessionRecord[]): readonly SessionRecord[] {
  return [...sessions].sort((a, b) => {
    const left = transcriptAge(a) ?? '';
    const right = transcriptAge(b) ?? '';
    if (left === right) return a.id < b.id ? -1 : 1;
    return left < right ? -1 : 1;
  });
}

/**
 * Prunes one project: age first, then the size cap on what is left (§3.3).
 *
 * The order matters and is the design's: age is an absolute statement about
 * value ("nobody reads a three-month-old transcript"), while the cap is a
 * statement about disk. Applying age first means the cap only ever has to remove
 * transcripts that are still *inside* the retention window, which is the case
 * the user would want warned about rather than the routine one.
 */
export function pruneProject(project: Project, deps: RetentionDeps, now: Date): ProjectPruneResult {
  const settings = effectiveRetention(project, deps.defaults);
  const byAge: string[] = [];
  const byCap: string[] = [];

  const cutoff = new Date(now.getTime() - settings.transcriptDays * 24 * 60 * 60 * 1000)
    .toISOString()
    .replace(/\.\d{3}Z$/, '.000Z');

  for (const session of prunable(deps.sessions, project.id, settings.keepPinned)) {
    const age = transcriptAge(session);
    if (age === undefined || age >= cutoff) continue;
    if (deps.transcripts.prune(session.id)) byAge.push(session.id);
  }

  // §3.3's measure, and the whole reason `transcript_bytes` exists: one indexed
  // read, no directory walk.
  const capBytes = Math.round(settings.transcriptCapMb * 1024 * 1024);
  let bytes = deps.sessions.transcriptBytesByProject(project.id);

  if (bytes > capBytes) {
    for (const session of oldestFirst(prunable(deps.sessions, project.id, settings.keepPinned))) {
      if (bytes <= capBytes) break;
      if (!deps.transcripts.prune(session.id)) continue;
      byCap.push(session.id);
      bytes = deps.sessions.transcriptBytesByProject(project.id);
    }
  }

  if (byAge.length + byCap.length > 0) {
    deps.log?.(
      `pruned ${String(byAge.length + byCap.length)} transcript(s) on project ${project.name}`,
      {
        projectId: project.id,
        byAge: byAge.length,
        byCap: byCap.length,
        transcriptDays: settings.transcriptDays,
        transcriptCapMb: settings.transcriptCapMb,
      },
    );
  }

  return { projectId: project.id, byAge, byCap, bytesAfter: bytes };
}

/**
 * The daily job (§3.3), over every project — archived ones included.
 *
 * "Archiving does not prune" means archiving is not *itself* a prune trigger,
 * not that an archived project's transcripts are retained forever: its history
 * is intact after a restore (§2.3), and its history is the metadata, which this
 * job never touches.
 */
export function runRetention(deps: RetentionDeps, now: Date): RetentionRunResult {
  const projects: ProjectPruneResult[] = [];
  let pruned = 0;
  for (const project of deps.projects.list({ includeArchived: true })) {
    const result = pruneProject(project, deps, now);
    projects.push(result);
    pruned += result.byAge.length + result.byCap.length;
  }
  return { projects, pruned };
}

/** §3.3's cadence. Exported so the module and its test agree on one number. */
export const RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000;
