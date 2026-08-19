/**
 * Task templates (roster DESIGN §2.4; work order WO5, 2026-08-19).
 *
 * > "We also should be able to attach agents that design specifically for
 * > example updating todo ticket replies, drafting emails, etc."
 *
 * A **task template** is a reusable prefill of the Start-work flow: the shape of
 * a recurring, non-code job — answer the open tickets, draft replies to a
 * mailbox — held as data so any capable agent can be attached to it in one pick
 * instead of the task being described from scratch every time.
 *
 * Four decisions, and each one is a way this could have become something worse:
 *
 * 1. **It lives in the library, as a file.** `templates/<slug>/template.json`, a
 *    sibling of `agents/`, loaded and watched by exactly the mechanism agent
 *    folders are (§2.1, §2.3). The rationale is §2.1's, unchanged: shareable,
 *    diffable, `git pull`-able, and hand-editable without a UI. A template in
 *    SQLite would be the one part of "the library is the roster" that is not.
 * 2. **A template suggests; it never gates.** `requiredIntegrations` produces a
 *    *warning* the picker shows beside a seated agent that lacks the connector,
 *    with a link into the agent's MCP integrations editor — and `suggestedRoles`
 *    is a ranking hint. Neither removes an agent from a picker. That is the
 *    owner's 2026-08-18 decision ("capabilities rank, they never gate") applied
 *    to the one new thing that could plausibly have re-introduced a gate.
 * 3. **It is data, not a code path.** Applying a template only *prefills* the
 *    creation call orchestrator already takes — goal, pattern, artifact path,
 *    pre-grants. Orchestrator gains one optional `templateId` recorded for
 *    provenance and nothing else; there is no template-shaped assignment.
 * 4. **A bad template costs exactly one template.** Loading is per-folder and
 *    never throws, exactly as §2.3 requires of a bad `agent.json`: the failure
 *    comes back as a {@link Diagnostic} the board can display, and its
 *    neighbours load.
 *
 * ## Variables
 *
 * Two, `{{slug}}` and `{{source}}`, and deliberately no general templating
 * engine — a template language is a thing that grows conditionals, and this one
 * has a fixed job. `{{slug}}` is the assignment's directory slug, supplied by
 * the caller; `{{source}}` is the one free input the dialog renders when a
 * template mentions it ("which mailbox?", "which ticket queue?"). A placeholder
 * that names anything else is left **verbatim**, so an author's typo is visible
 * in the prefilled field rather than silently eaten.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { z } from 'zod';

import type { Diagnostic } from './contracts.js';
import { RosterValidationError, issuesFromZod } from './errors.js';
import {
  AGENT_ID_MAX_LENGTH,
  AGENT_ID_MIN_LENGTH,
  AGENT_ID_PATTERN,
  RESERVED_AGENT_IDS,
} from './ids.js';
import { roleSchema } from './schema.js';
import { TEMPLATES_DIRNAME, writeFileAtomic, type StoreHooks } from './store.js';

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/** `templates/` — declared with the rest of the library layout in `store.ts`,
 *  and re-exported here so a reader of this module sees the whole shape. */
export { TEMPLATES_DIRNAME };

/** The structured definition, the way `agent.json` is an agent's. */
export const TEMPLATE_JSON_FILENAME = 'template.json';

/** The `schemaVersion` this build writes and is the newest it can read. */
export const TASK_TEMPLATE_SCHEMA_VERSION = 1;

/**
 * Why `value` is not a usable template id, or `undefined` when it is one.
 *
 * The same slug rules as an agent id, for the same reason — the id is a folder
 * name and a URL path segment (`ids.ts`) — and the same reserved set, which
 * already covers the Windows device names and the `/api/roster` segments. It is
 * a separate function rather than a call to `agentIdProblem` only so the message
 * says "template id"; a diagnostic that told an author their *agent* id was
 * wrong while they were editing a template would send them to the wrong file.
 */
export function templateIdProblem(value: string): string | undefined {
  if (value.length < AGENT_ID_MIN_LENGTH) {
    return `template id must be at least ${AGENT_ID_MIN_LENGTH} characters`;
  }
  if (value.length > AGENT_ID_MAX_LENGTH) {
    return `template id must be at most ${AGENT_ID_MAX_LENGTH} characters`;
  }
  if (!AGENT_ID_PATTERN.test(value)) {
    return (
      'template id must be a slug: lower-case letters and digits in hyphen-separated ' +
      `groups (got "${value}")`
    );
  }
  if (RESERVED_AGENT_IDS.has(value)) return `template id "${value}" is reserved`;
  return undefined;
}

// ---------------------------------------------------------------------------
// The schema
// ---------------------------------------------------------------------------

export const templateIdSchema = z.string().superRefine((value, ctx) => {
  const problem = templateIdProblem(value);
  if (problem !== undefined) ctx.addIssue({ code: 'custom', message: problem });
});

/**
 * `template.json`, schema version 1.
 *
 * `strictObject` throughout for §3's reason: unknown keys are rejected rather
 * than ignored, so a template written against a newer build fails loudly here
 * instead of silently losing the field that made it work.
 *
 * Note which fields are **absent**: there is no `projectId`, no `agentIds` and
 * no budget. A template describes a *kind of work*, not an instance of it — the
 * project, the people and the numbers are the dialog's, every time.
 */
export const taskTemplateSchema = z.strictObject({
  schemaVersion: z.literal(TASK_TEMPLATE_SCHEMA_VERSION),
  id: templateIdSchema,
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  /**
   * `solo` or `pair`, and nothing wider.
   *
   * `overseer` is missing on purpose: a team's lead needs a token budget the
   * pattern gives no default for (orchestrator §7.2), so a template that
   * prefilled `overseer` would prefill a form that still could not be
   * submitted — a prefill that leaves Start disabled is worse than no prefill.
   */
  pattern: z.enum(['solo', 'pair']),
  /** The brief, with `{{source}}` where the one free input belongs. */
  goalTemplate: z.string().min(1).max(4000),
  /** Overrides ui §6's generic `docs/assignments/<slug>-<shortId>/DRAFT.md`. */
  artifactPathTemplate: z.string().min(1).max(500).optional(),
  /** The dialog's write toggle, pre-answered. Absent reads as read-only. */
  write: z.boolean().optional(),
  /** MCP connector ids (roster §10) the seated agent should carry. A **warning**
   *  when it does not — never a filter on the picker. */
  requiredIntegrations: z.array(z.string().min(1)).max(20).optional(),
  /** A ranking hint for the agent list, never a gate (owner decision
   *  2026-08-18). */
  suggestedRoles: z.array(roleSchema).max(5).optional(),
  /** Bare tool names that feed WO4's assignment-scoped pre-grants (orchestrator
   *  §2.3). Never a scoped rule: a pre-grant answers "do not stop and ask about
   *  this tool", and a pattern would be a permission rule, which is roster's
   *  compiler's to compose and not a template's to assert. */
  preGrantTools: z.array(z.string().min(1)).max(20).optional(),
});

export type TaskTemplate = z.infer<typeof taskTemplateSchema>;

// ---------------------------------------------------------------------------
// Parsing — the same two guarantees `parse.ts` gives a definition
// ---------------------------------------------------------------------------

export type TemplateParseResult =
  | { readonly ok: true; readonly value: TaskTemplate }
  | { readonly ok: false; readonly error: RosterValidationError };

/** Validates a raw document. Never throws — one bad file costs one template. */
export function safeParseTaskTemplate(raw: unknown, source?: string): TemplateParseResult {
  const result = taskTemplateSchema.safeParse(raw);
  if (result.success) return { ok: true, value: result.data };
  return {
    ok: false,
    error: new RosterValidationError(
      'task template is not valid',
      issuesFromZod(result.error.issues),
      source,
    ),
  };
}

/** {@link safeParseTaskTemplate}, throwing {@link RosterValidationError}. */
export function parseTaskTemplate(raw: unknown, source?: string): TaskTemplate {
  const result = safeParseTaskTemplate(raw, source);
  if (!result.ok) throw result.error;
  return result.value;
}

/**
 * Parses the text of a `template.json`.
 *
 * A leading byte-order mark is stripped for `parse.ts`'s reason: the library is
 * meant to be hand-edited on Windows, several editors write one, and a BOM would
 * otherwise fail as a syntax error pointing at character 0 of a file that looks
 * perfectly fine.
 */
export function parseTaskTemplateJson(text: string, source?: string): TaskTemplate {
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^\uFEFF/, '')) as unknown;
  } catch (error) {
    throw new RosterValidationError(
      'task template is not valid JSON',
      [{ path: '', message: error instanceof Error ? error.message : String(error) }],
      source,
    );
  }
  return parseTaskTemplate(raw, source);
}

/** The bytes written to `template.json`: schema order, two-space indent, LF. */
export function serialiseTaskTemplate(template: TaskTemplate): string {
  const ordered: Record<string, unknown> = {
    schemaVersion: template.schemaVersion,
    id: template.id,
    name: template.name,
    description: template.description,
    pattern: template.pattern,
    goalTemplate: template.goalTemplate,
    artifactPathTemplate: template.artifactPathTemplate,
    write: template.write,
    requiredIntegrations: template.requiredIntegrations,
    suggestedRoles: template.suggestedRoles,
    preGrantTools: template.preGrantTools,
  };
  const compact: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(ordered)) {
    if (value !== undefined) compact[key] = value;
  }
  return `${JSON.stringify(compact, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// Variables
// ---------------------------------------------------------------------------

/** The whole vocabulary. Two names, closed, and no engine behind them. */
export const TEMPLATE_VARIABLES = ['slug', 'source'] as const;
export type TemplateVariable = (typeof TEMPLATE_VARIABLES)[number];

const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

/** Which of the two a template's own text actually mentions, in a fixed order. */
export function templateVariables(template: TaskTemplate): readonly TemplateVariable[] {
  const text = `${template.goalTemplate}\n${template.artifactPathTemplate ?? ''}`;
  const found = new Set<string>();
  for (const match of text.matchAll(PLACEHOLDER)) {
    const name = match[1];
    if (name !== undefined) found.add(name);
  }
  return TEMPLATE_VARIABLES.filter((name) => found.has(name));
}

/**
 * Substitutes `{{slug}}` and `{{source}}`; leaves everything else verbatim.
 *
 * A value that was not supplied renders as the empty string rather than as the
 * placeholder — the field is editable and a half-filled sentence is easier to
 * finish than one with braces in it. A placeholder naming anything *outside*
 * the vocabulary survives untouched, so `{{soruce}}` shows up in the prefilled
 * goal as the typo it is.
 */
export function renderTemplateText(
  text: string,
  values: Readonly<Partial<Record<TemplateVariable, string>>>,
): string {
  return text.replace(PLACEHOLDER, (whole, rawName: string) => {
    const name = rawName as TemplateVariable;
    if (!TEMPLATE_VARIABLES.includes(name)) return whole;
    return values[name] ?? '';
  });
}

// ---------------------------------------------------------------------------
// The integrations check (WO5: "answers 'agent X lacks connector Y' as data")
// ---------------------------------------------------------------------------

/** One seated agent's shortfall against a template's `requiredIntegrations`. */
export interface TemplateIntegrationGap {
  readonly agentId: string;
  readonly agentName: string;
  /** Connector ids the template asks for that this agent does not declare. */
  readonly missing: readonly string[];
}

/**
 * The connectors in `required` that `provided` does not carry, order preserved.
 *
 * The one definition of the check. The Start-work dialog restates it in the
 * browser so the warning tracks the tick-box without a request per keystroke,
 * and a web test pins that restatement against this function — the same
 * arrangement §10's integration form uses against `integrationsSchema`, and for
 * the same reason: a rule stated twice is a rule that drifts once.
 */
export function missingIntegrations(
  required: readonly string[] | undefined,
  provided: readonly string[],
): readonly string[] {
  if (required === undefined) return [];
  const have = new Set(provided);
  return required.filter((name) => !have.has(name));
}

// ---------------------------------------------------------------------------
// What a loaded folder is
// ---------------------------------------------------------------------------

export interface ResolvedTemplate {
  readonly template: TaskTemplate;
  /** Absolute path to the template folder. Never leaves the server (§3.2). */
  readonly dir: string;
  /** sha-256 over the authored bytes — what makes a reload a no-op (§2.3). */
  readonly contentHash: string;
  readonly diagnostics: readonly Diagnostic[];
}

/** The result of reading one folder. Never a throw. */
export type TemplateLoadOutcome =
  | { readonly ok: true; readonly template: ResolvedTemplate }
  | {
      readonly ok: false;
      /** The folder name, which is what the id *should* have been. */
      readonly id: string;
      readonly dir: string;
      readonly diagnostics: readonly Diagnostic[];
    };

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

export interface TemplateStoreOptions {
  /** The library root — `templates/` is resolved beneath it. */
  readonly root: string;
  readonly hooks?: StoreHooks;
}

export interface TemplateStore {
  /** `<libraryRoot>/templates`. */
  readonly dir: string;
  /** Absolute path to one template's folder; the folder need not exist. */
  templateDir(id: string): string;
  /** Folder names directly under `templates/`, dot-folders excluded. */
  folderNames(): readonly string[];
  hasFolder(id: string): boolean;
  load(id: string): TemplateLoadOutcome;
  /** Writes `template.json` atomically and reads the folder back. */
  write(template: TaskTemplate): ResolvedTemplate;
  /** Deletes one template's folder. A folder that is not there is a no-op. */
  remove(id: string): void;
}

export function createTemplateStore(options: TemplateStoreOptions): TemplateStore {
  const dir = join(resolve(options.root), TEMPLATES_DIRNAME);
  const hooks = options.hooks ?? {};
  const templateDir = (id: string): string => join(dir, id);

  function readFolder(folder: string, expectedId: string): TemplateLoadOutcome {
    const path = join(folder, TEMPLATE_JSON_FILENAME);

    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch (cause) {
      return {
        ok: false,
        id: expectedId,
        dir: folder,
        diagnostics: [
          {
            level: 'error',
            code: 'roster.unreadable-template',
            message: `${TEMPLATE_JSON_FILENAME} could not be read: ${
              cause instanceof Error ? cause.message : String(cause)
            }`,
            path,
          },
        ],
      };
    }

    let template: TaskTemplate;
    try {
      template = parseTaskTemplateJson(text, path);
    } catch (cause) {
      if (cause instanceof RosterValidationError) {
        return {
          ok: false,
          id: expectedId,
          dir: folder,
          // The same diagnostic *shape* a malformed `agent.json` produces
          // (`RosterValidationError.report()` — every offending field path, one
          // per line), under its own code so the board can say which kind of
          // file to go and open.
          diagnostics: [
            {
              level: 'error',
              code: 'roster.invalid-template',
              message: cause.report(),
              path,
            },
          ],
        };
      }
      throw cause;
    }

    // The folder name *is* the id, exactly as it is for an agent (§2.1). A
    // disagreement is not a detail to paper over: the folder decides where the
    // file lives and the field decides what the dialog posts as `templateId`.
    if (template.id !== expectedId) {
      return {
        ok: false,
        id: expectedId,
        dir: folder,
        diagnostics: [
          {
            level: 'error',
            code: 'roster.template-id-mismatch',
            message:
              `folder "${expectedId}" holds a template with id "${template.id}"; ` +
              'the folder name is the template id (DESIGN §2.4). Rename one to match the other.',
            path,
          },
        ],
      };
    }

    return {
      ok: true,
      template: {
        template,
        dir: folder,
        contentHash: createHash('sha256').update(text, 'utf8').digest('hex'),
        diagnostics: [],
      },
    };
  }

  return {
    dir,
    templateDir,

    folderNames() {
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        // No `templates/` yet is an empty set, not a failure: bootstrap creates
        // it, and a library that arrived by `git clone` may not have one.
        return [];
      }
      return entries
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
        .map((entry) => entry.name)
        .sort();
    },

    hasFolder: (id) => existsSync(templateDir(id)),

    load: (id) => readFolder(templateDir(id), id),

    write(template) {
      const folder = templateDir(template.id);
      // Composed with `node:path`, never concatenated — `store.ts`’s rule, and
      // the one that keeps a library under `D:\Agent Manager\lib` working.
      mkdirSync(folder, { recursive: true });
      writeFileAtomic(join(folder, TEMPLATE_JSON_FILENAME), serialiseTaskTemplate(template), hooks);
      const outcome = readFolder(folder, template.id);
      if (!outcome.ok) {
        // Unreachable in practice — the bytes were just serialised from a parsed
        // template — but a silent `undefined` here would be a template that
        // "wrote" and then vanished from the index.
        throw new RosterValidationError(
          `the template "${template.id}" could not be read back after writing`,
          outcome.diagnostics.map((diagnostic) => ({ path: '', message: diagnostic.message })),
          folder,
        );
      }
      return outcome.template;
    },

    remove(id) {
      // The same retry posture the test helpers use everywhere on Windows —
      // an editor or the watcher holding a handle briefly must not turn a
      // deliberate delete into a crash.
      rmSync(templateDir(id), { recursive: true, force: true, maxRetries: 5 });
    },
  };
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

export interface TemplateRegistryChange {
  readonly changed: boolean;
  /** Ids that appeared, vanished, or whose authored bytes differ. Sorted. */
  readonly templateIds: readonly string[];
}

export interface TemplateRegistry {
  list(): readonly ResolvedTemplate[];
  get(id: string): ResolvedTemplate | undefined;
  /** Everything wrong across `templates/`, for the board's banner (§2.3). */
  diagnostics(): readonly Diagnostic[];
  reloadAll(): TemplateRegistryChange;
  /** Rereads one folder — the watcher's per-folder path. */
  reload(id: string): TemplateRegistryChange;
}

/**
 * The in-memory index, shaped exactly like the agent registry's (`registry.ts`).
 *
 * Failures are remembered rather than discarded for the same reason they are
 * there: a folder whose `template.json` is corrupt is not a template — nothing
 * lists it and nothing can apply it — but the index still knows the id exists,
 * and the board still gets to say so.
 */
export function createTemplateRegistry(store: TemplateStore): TemplateRegistry {
  const live = new Map<string, ResolvedTemplate>();
  const failed = new Map<string, readonly Diagnostic[]>();

  function absorb(id: string, touched: Set<string>): void {
    const outcome = store.load(id);
    const previous = live.get(id);

    if (outcome.ok) {
      failed.delete(id);
      live.set(id, outcome.template);
      if (previous === undefined || previous.contentHash !== outcome.template.contentHash) {
        touched.add(id);
      }
      return;
    }

    live.delete(id);
    const before = failed.get(id);
    failed.set(id, outcome.diagnostics);
    // A folder that was a template and now is not is a change the board must
    // see; one that was already broken in the same way is not, or every
    // keystroke in an editor on a malformed file would be an event.
    if (previous !== undefined || before === undefined || !same(before, outcome.diagnostics)) {
      touched.add(id);
    }
  }

  function change(ids: Iterable<string>): TemplateRegistryChange {
    const templateIds = [...new Set(ids)].sort();
    return templateIds.length === 0
      ? { changed: false, templateIds: [] }
      : { changed: true, templateIds };
  }

  return {
    list: () => [...live.values()].sort((a, b) => (a.template.id < b.template.id ? -1 : 1)),
    get: (id) => live.get(id),

    diagnostics() {
      const out: Diagnostic[] = [];
      for (const diagnostics of failed.values()) out.push(...diagnostics);
      for (const entry of live.values()) out.push(...entry.diagnostics);
      return out;
    },

    reloadAll() {
      const touched = new Set<string>();
      const seen = new Set(store.folderNames());
      for (const id of seen) absorb(id, touched);
      for (const id of [...live.keys()]) {
        if (!seen.has(id)) {
          live.delete(id);
          touched.add(id);
        }
      }
      for (const id of [...failed.keys()]) {
        if (!seen.has(id)) failed.delete(id);
      }
      return change(touched);
    },

    reload(id) {
      const touched = new Set<string>();
      if (!store.hasFolder(id)) {
        const wasLive = live.delete(id);
        const wasFailed = failed.delete(id);
        if (wasLive || wasFailed) touched.add(id);
        return change(touched);
      }
      absorb(id, touched);
      return change(touched);
    },
  };
}

/** Two diagnostic lists that would render identically on the board. */
function same(a: readonly Diagnostic[], b: readonly Diagnostic[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((left, index) => {
    const right = b[index];
    return right !== undefined && left.code === right.code && left.message === right.message;
  });
}
