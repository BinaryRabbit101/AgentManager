/**
 * The starter roster (roster DESIGN §2.1, IMPLEMENTATION M10).
 *
 * M10's acceptance, criterion by criterion:
 *
 * - "A clean install produces a working board with the seeded agents visible and
 *   launchable" — the *visible* half is `module.test.ts`, which boots the real
 *   composition root and reads `GET /api/roster/agents`; the *launchable* half is
 *   here, because launchability is a property of `compileSession` rather than of
 *   the HTTP surface.
 * - "Every seeded agent passes validation and compiles to valid SDK options
 *   against a scratch project."
 * - "The architect and skeptic seeds have `roles` entries matching the names
 *   orchestrator's v1 pattern expects" — asserted against orchestrator's own
 *   `PAIR_SEATS`, not against a copy of the role names.
 *
 * Plus the two rules the brief states and the acceptance list leaves implicit:
 * seeds go through the real store and validation, and seeding never overwrites
 * an agent the owner authored.
 */
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Secret, type SecretResolver } from '../../secrets/index.js';
import { CRITIC_SEAT, DRAFTER_SEAT, PAIR_SEATS } from '../orchestrator/patterns.js';

import { bootstrapLibrary, readRosterMetadata } from './bootstrap.js';
import { compileSession } from './compileSession.js';
import { effectivePermissionsSchema } from './contracts.js';
import { agentDefinitionSchema } from './schema.js';
import {
  ADA,
  LIBRARY_README,
  LIBRARY_README_FILENAME,
  MIRA,
  PRIYA,
  RETIRED_SEED_TEMPLATES,
  SAM,
  SEED_AGENTS,
  SEED_TEMPLATES,
  seedDefinition,
  seedLibrary,
  seedTemplateDefinition,
} from './seed.js';
import { libraryPaths, type RosterStore } from './store.js';
import { taskTemplateSchema } from './templates.js';
import {
  FIXED_NOW,
  fakeGit,
  makeHarness,
  makeSpacedTempDir,
  writeFixtureAgent,
  type Harness,
  type TempDir,
} from './__tests__/helpers.js';

let temp: TempDir;
let harness: Harness;

/** The library as the installer leaves it, then as roster bootstraps it. */
function bootstrapped(harnessed: Harness): RosterStore {
  bootstrapLibrary({ root: harnessed.libraryRoot, git: fakeGit().git, initGit: false });
  return harnessed.store;
}

const NO_SECRETS: SecretResolver = { get: () => Promise.resolve(undefined) };

beforeEach(() => {
  temp = makeSpacedTempDir('agentmanager roster seed ');
  harness = makeHarness({ dataRoot: join(temp.path, 'data') });
});

afterEach(() => {
  harness.close();
  temp.cleanup();
});

// ---------------------------------------------------------------------------

describe('the seed set (M10)', () => {
  it('is the four identities DESIGN names, with stable ids', () => {
    expect(SEED_AGENTS.map((seed) => seed.id)).toEqual([
      'priya-bugfix',
      'ada-architect',
      'sam-skeptic',
      'mira-overseer',
    ]);
    expect(SEED_AGENTS).toHaveLength(4);
    // A bug-patcher, a feature implementer, and an overseer — the other three
    // of M10's four kinds; the architect/skeptic pair is asserted below.
    expect(seedDefinition(PRIYA, FIXED_NOW).specialty).toBe('bug-patching');
    expect(seedDefinition(ADA, FIXED_NOW).specialty).toBe('feature-implementation');
    expect(seedDefinition(MIRA, FIXED_NOW).capabilities?.overseer).toBe(true);
  });

  it('every seed passes the agent schema, with a real persona', () => {
    for (const seed of SEED_AGENTS) {
      const definition = seedDefinition(seed, FIXED_NOW);
      // Parsed once by `seedDefinition`, and asserted again against the schema
      // itself so this criterion does not rest on that function's own choice of
      // parser.
      expect(agentDefinitionSchema.safeParse(definition).success).toBe(true);
      expect(definition.meta.origin).toBe('seed');
      expect(definition.id).toBe(seed.id);
      // "each with a real persona and a sane permission set" (M10).
      expect(seed.persona.split(/\s+/).length).toBeGreaterThan(80);
      expect(definition.permissions?.deny ?? []).toContain('Bash(git push*)');
      // No seed needs a credential, so a clean install has nothing to configure.
      expect(definition.integrations).toBeUndefined();
    }
  });

  it('the architect and skeptic seeds fill orchestrator’s v1 pair seats', () => {
    const drafterSeat = PAIR_SEATS.find((seat) => seat.key === DRAFTER_SEAT);
    const criticSeat = PAIR_SEATS.find((seat) => seat.key === CRITIC_SEAT);
    expect(drafterSeat).toBeDefined();
    expect(criticSeat).toBeDefined();

    const ada = seedDefinition(ADA, FIXED_NOW).capabilities?.roles ?? [];
    const sam = seedDefinition(SAM, FIXED_NOW).capabilities?.roles ?? [];

    // Asserted against the pattern's own seat definitions rather than against a
    // second copy of the role names: if orchestrator renames a role, this fails
    // rather than silently seeding an unusable pair.
    expect(ada).toContain('architect');
    expect(drafterSeat!.roles.some((role) => ada.includes(role))).toBe(true);
    expect(sam).toContain('skeptic');
    expect(criticSeat!.roles.some((role) => sam.includes(role))).toBe(true);

    // §3.3 refuses a pair whose seats are one identity, so the two seeds must
    // be two agents.
    expect(ADA.id).not.toBe(SAM.id);
  });

  it('the critic seat’s seed cannot edit, by deny and not by omission', () => {
    const sam = seedDefinition(SAM, FIXED_NOW);
    for (const tool of ['Edit', 'Write', 'NotebookEdit']) {
      expect(sam.permissions?.deny).toContain(tool);
      expect(sam.permissions?.allow ?? []).not.toContain(tool);
    }
  });

  it('the overseer seed satisfies §11 and declares no orchestration rules of its own', () => {
    const mira = seedDefinition(MIRA, FIXED_NOW);
    expect(mira.capabilities?.overseer).toBe(true);
    // §11: "a required `roles` entry containing `overseer`" — enforced by the
    // schema, and stated here because the seed is what has to satisfy it.
    expect(mira.capabilities?.roles).toContain('overseer');
    // §11's model floor is `sonnet`; below it the validator warns.
    expect(mira.model?.primary).toBe('sonnet');
    // The `mcp__agentmanager__*` grant is the compiler's, conditional on the
    // orchestrator module being mounted — a definition that carried it would be
    // claiming a toolset that may not exist.
    const rules = [
      ...(mira.permissions?.allow ?? []),
      ...(mira.permissions?.deny ?? []),
      ...(mira.permissions?.ask ?? []),
    ];
    expect(rules.some((rule) => rule.startsWith('mcp__agentmanager__'))).toBe(false);
    // Coordination is turn-expensive (§11).
    expect(mira.defaults?.maxTurns ?? 0).toBeGreaterThan(
      seedDefinition(SAM, FIXED_NOW).defaults?.maxTurns ?? 0,
    );
  });
});

// ---------------------------------------------------------------------------

describe('seeding a library (M10)', () => {
  it('writes the four agents and the README into an empty library, once', () => {
    const store = bootstrapped(harness);

    const first = seedLibrary({ store, clock: () => FIXED_NOW });
    expect(first.reason).toBe('seeded');
    expect(first.seeded).toEqual(SEED_AGENTS.map((seed) => seed.id));
    expect(first.readmeWritten).toBe(true);
    expect(first.diagnostics).toEqual([]);

    // Ordinary library folders, indistinguishable from an authored agent.
    expect(readdirSync(join(harness.libraryRoot, 'agents')).sort()).toEqual(
      [...SEED_AGENTS.map((seed) => seed.id)].sort(),
    );
    const priyaDir = join(harness.libraryRoot, 'agents', 'priya-bugfix');
    expect(readFileSync(join(priyaDir, 'persona.md'), 'utf8')).toBe(PRIYA.persona);
    // `store.write` generated the plugin manifest, so the seed carries skills
    // the same way any other agent would (§7.1).
    expect(
      JSON.parse(readFileSync(join(priyaDir, '.claude-plugin', 'plugin.json'), 'utf8')) as {
        name: string;
      },
    ).toMatchObject({ name: 'priya-bugfix' });

    expect(readFileSync(join(harness.libraryRoot, LIBRARY_README_FILENAME), 'utf8')).toBe(
      LIBRARY_README,
    );
    expect(readRosterMetadata(libraryPaths(harness.libraryRoot)).seededAt).toBe(
      FIXED_NOW.toISOString(),
    );

    // A second run changes nothing at all.
    const second = seedLibrary({ store, clock: () => FIXED_NOW });
    expect(second.reason).toBe('already-seeded');
    expect(second.seeded).toEqual([]);
    expect(second.readmeWritten).toBe(false);
  });

  it('never overwrites a user-authored agent, and never returns a deleted seed', () => {
    const store = bootstrapped(harness);
    seedLibrary({ store, clock: () => FIXED_NOW });

    // The owner rewrites a starter agent's persona and deletes another.
    const priyaPersona = join(harness.libraryRoot, 'agents', 'priya-bugfix', 'persona.md');
    writeFileSync(priyaPersona, '# Mine now\n', 'utf8');
    store.purge('sam-skeptic');

    seedLibrary({ store, clock: () => FIXED_NOW });

    expect(readFileSync(priyaPersona, 'utf8')).toBe('# Mine now\n');
    expect(existsSync(join(harness.libraryRoot, 'agents', 'sam-skeptic'))).toBe(false);
  });

  it('leaves a library that already holds agents completely alone', () => {
    bootstrapped(harness);
    // What a `git clone` of someone else's roster looks like on first boot.
    writeFixtureAgent(harness.libraryRoot, 'coder');

    const result = seedLibrary({ store: harness.store, clock: () => FIXED_NOW });

    expect(result.reason).toBe('library-not-empty');
    expect(result.seeded).toEqual([]);
    expect(readdirSync(join(harness.libraryRoot, 'agents'))).toEqual(['priya-bugfix']);
    // The decision is still recorded, so a *second* boot does not seed into it
    // either — the emptiness that mattered was the emptiness on first run.
    expect(readRosterMetadata(libraryPaths(harness.libraryRoot)).seededAt).not.toBeNull();
  });

  it('skips an id whose folder exists even if the library looks empty', () => {
    const store = bootstrapped(harness);
    seedLibrary({ store, clock: () => FIXED_NOW, agents: [PRIYA] });
    // `seededAt` cleared, and a store that reports an empty listing while
    // `priya-bugfix/` is still on disk. Contrived on purpose: the two guards are
    // independent, and this is the only way to reach the second one now that the
    // first would normally answer first. A folder that exists is never written
    // over, whatever the listing says.
    writeFileSync(
      libraryPaths(harness.libraryRoot).rosterJson,
      JSON.stringify({ schemaVersion: 1, seededAt: null }),
      'utf8',
    );
    const blindStore: RosterStore = { ...store, folderNames: () => [] };

    const result = seedLibrary({ store: blindStore, clock: () => FIXED_NOW, agents: [PRIYA, ADA] });
    expect(result.skipped).toEqual(['priya-bugfix']);
    expect(result.seeded).toEqual(['ada-architect']);
    expect(
      readFileSync(join(harness.libraryRoot, 'agents', 'priya-bugfix', 'persona.md'), 'utf8'),
    ).toBe(PRIYA.persona);
  });

  it('reports a seed that will not write as a diagnostic, not a throw', () => {
    const store = bootstrapped(harness);
    const failing: RosterStore = {
      ...store,
      write: () => {
        throw new Error('the library is read-only');
      },
    };

    const result = seedLibrary({ store: failing, clock: () => FIXED_NOW });
    expect(result.seeded).toEqual([]);
    expect(result.diagnostics).toHaveLength(SEED_AGENTS.length);
    expect(result.diagnostics[0]?.code).toBe('roster.seed-failed');
    expect(result.diagnostics[0]?.level).toBe('warn');
  });
});

// ---------------------------------------------------------------------------
// "Every seeded agent passes validation and compiles to valid SDK options
//  against a scratch project"
// ---------------------------------------------------------------------------

describe('every seed is launchable (M10)', () => {
  it('loads into the registry with no error diagnostics', () => {
    const store = bootstrapped(harness);
    seedLibrary({ store, clock: () => FIXED_NOW });
    harness.service.load();

    const listed = harness.service.list();
    expect(listed.agents.map((agent) => agent.definition.id).sort()).toEqual(
      [...SEED_AGENTS.map((seed) => seed.id)].sort(),
    );
    const problems = [
      ...listed.diagnostics,
      ...listed.agents.flatMap((agent) => agent.diagnostics),
    ].filter((diagnostic) => diagnostic.level === 'error');
    expect(problems).toEqual([]);
    // No credential badge on any card: none of the four declares an integration.
    expect(listed.agents.every((agent) => agent.definition.integrations === undefined)).toBe(true);
  });

  it('compiles to valid SDK options against a scratch project', async () => {
    const store = bootstrapped(harness);
    seedLibrary({ store, clock: () => FIXED_NOW });
    harness.service.load();

    const scratch = join(temp.path, 'scratch project');
    for (const seed of SEED_AGENTS) {
      const agent = harness.service.registry.get(seed.id);
      expect(agent, `${seed.id} is in the registry`).toBeDefined();

      const compiled = await compileSession({
        agent: agent!,
        project: {
          projectId: 'scratch',
          cwd: scratch,
          env: [],
          workspace: { kind: 'primary', path: scratch, branch: 'main' },
        },
        assignment: { id: 'seed-check', write: true, scopeRules: {} },
        policy: { allowPermissionElevation: true, globalDeny: [] },
        baseEnv: { PATH: '/usr/bin' },
        secrets: NO_SECRETS,
      });

      // The option object the SDK would be handed, with the fields every launch
      // depends on actually present.
      expect(compiled.options.cwd).toBe(scratch);
      expect(compiled.options.systemPrompt).toBeDefined();
      expect(compiled.options.env?.['PATH']).toBe('/usr/bin');
      expect(compiled.options.permissionMode).toBeDefined();
      // The composition is well-formed by roster's own contract.
      expect(effectivePermissionsSchema.safeParse(compiled.effective).success).toBe(true);
      // §6.1: never reachable, from any input.
      expect(compiled.options.permissionMode).not.toBe('bypassPermissions');
      expect(compiled.diagnostics.filter((d) => d.level === 'error')).toEqual([]);
      // The persona the seed ships is genuinely in the prompt.
      expect(JSON.stringify(compiled.options.systemPrompt)).toContain(
        seed.persona.split('\n')[0]?.slice(0, 40) ?? '',
      );
    }
  });

  it('the read-only seeds stay read-only once composed', async () => {
    const store = bootstrapped(harness);
    seedLibrary({ store, clock: () => FIXED_NOW });
    harness.service.load();

    for (const id of ['sam-skeptic', 'mira-overseer']) {
      const compiled = await compileSession({
        agent: harness.service.registry.get(id)!,
        assignment: { id: 'seed-check', write: true, scopeRules: {} },
        policy: { allowPermissionElevation: true, globalDeny: [] },
        baseEnv: {},
        secrets: NO_SECRETS,
      });
      // Even on a `write: true` assignment: the definition's own deny is the
      // ceiling, and `deny` is a union no later layer can remove (§6.2).
      expect(compiled.effective.deny).toContain('Edit');
      expect(compiled.effective.allow).not.toContain('Edit');
    }
  });
});

// ---------------------------------------------------------------------------
// Task templates: the empty seed list, and the retired starters
// (WO5; retired 2026-08-19 by owner decision)
// ---------------------------------------------------------------------------

describe('seeding the starter task templates (WO5, retired 2026-08-19)', () => {
  it('ships no starters, and a fresh library seeds none — but still stamps', () => {
    expect(SEED_TEMPLATES).toEqual([]);

    const store = bootstrapped(harness);
    const result = seedLibrary({ store, clock: () => FIXED_NOW });
    expect(result.templates.reason).toBe('seeded');
    expect(result.templates.seeded).toEqual([]);
    // The Start-work strip renders only when templates exist, so this is
    // the dialog opening with no "Start from" section at all.
    expect(harness.service.listTemplates().templates).toEqual([]);
    // The stamp still records that the (empty) decision was taken, keeping
    // the once-ever semantics for any future seed.
    expect(readRosterMetadata(libraryPaths(harness.libraryRoot)).templatesSeededAt).toBe(
      FIXED_NOW.toISOString(),
    );
  });

  it('keeps the retired starters valid — they are the retirement comparison key', () => {
    expect(RETIRED_SEED_TEMPLATES.map((seed) => seed.id)).toEqual([
      'todo-ticket-replies',
      'email-reply-drafts',
    ]);
    for (const seed of RETIRED_SEED_TEMPLATES) {
      // A retired seed that stops parsing could never byte-match what seeding
      // wrote, and the pass would silently stop cleaning installs.
      expect(taskTemplateSchema.safeParse(seedTemplateDefinition(seed)).success).toBe(true);
    }
  });

  it('removes an untouched retired starter from a stamped install', () => {
    const store = bootstrapped(harness);
    // What the owner's install looks like: both starters written by an earlier
    // build's seed pass, `templatesSeededAt` stamped that day.
    const before = seedLibrary({
      store,
      clock: () => FIXED_NOW,
      templates: RETIRED_SEED_TEMPLATES,
      retired: [],
    });
    expect(before.templates.seeded).toEqual(['todo-ticket-replies', 'email-reply-drafts']);

    const result = seedLibrary({ store, clock: () => FIXED_NOW });
    expect(result.templates.reason).toBe('already-seeded');
    expect(result.templates.removed).toEqual(['todo-ticket-replies', 'email-reply-drafts']);
    expect(existsSync(join(harness.libraryRoot, 'templates', 'todo-ticket-replies'))).toBe(false);
    expect(existsSync(join(harness.libraryRoot, 'templates', 'email-reply-drafts'))).toBe(false);

    // And the pass is idempotent: a second boot has nothing left to remove.
    expect(seedLibrary({ store, clock: () => FIXED_NOW }).templates.removed).toEqual([]);
  });

  it('never removes a starter the owner has edited, nor their own templates', () => {
    const store = bootstrapped(harness);
    seedLibrary({
      store,
      clock: () => FIXED_NOW,
      templates: RETIRED_SEED_TEMPLATES,
      retired: [],
    });

    // One starter edited — even trivially — is the owner's now.
    const mine = join(harness.libraryRoot, 'templates', 'todo-ticket-replies', 'template.json');
    const edited = readFileSync(mine, 'utf8').replace(
      'Reply to todo tickets',
      'Reply to my tickets',
    );
    writeFileSync(mine, edited, 'utf8');

    const result = seedLibrary({ store, clock: () => FIXED_NOW });
    // The untouched one goes; the edited one stays, this boot and every boot.
    expect(result.templates.removed).toEqual(['email-reply-drafts']);
    expect(readFileSync(mine, 'utf8')).toBe(edited);
    expect(seedLibrary({ store, clock: () => FIXED_NOW }).templates.removed).toEqual([]);
    expect(existsSync(join(harness.libraryRoot, 'templates', 'todo-ticket-replies'))).toBe(true);
  });

  it('reports a template that will not write as a diagnostic, not a throw', () => {
    const store = bootstrapped(harness);
    // A `templates/` that is a *file* is the cheapest real way to make every
    // write fail: no folder can be created underneath it. The seed list is
    // empty now, so the write path is exercised through its test seam.
    rmSync(join(harness.libraryRoot, 'templates'), { recursive: true, force: true });
    writeFileSync(join(harness.libraryRoot, 'templates'), 'not a directory', 'utf8');

    const result = seedLibrary({
      store,
      clock: () => FIXED_NOW,
      templates: RETIRED_SEED_TEMPLATES,
      retired: [],
    });
    expect(result.templates.seeded).toEqual([]);
    expect(result.templates.diagnostics).toHaveLength(RETIRED_SEED_TEMPLATES.length);
    expect(result.templates.diagnostics[0]?.code).toBe('roster.seed-failed');
    expect(result.templates.diagnostics[0]?.level).toBe('warn');
    // And the agents still arrived — one broken half does not take the other.
    expect(result.seeded).toEqual(SEED_AGENTS.map((seed) => seed.id));
  });
});

// ---------------------------------------------------------------------------

describe('the library README (M10)', () => {
  it('says it is a git repo and safe to hand-edit, and is not rewritten', () => {
    const store = bootstrapped(harness);
    seedLibrary({ store, clock: () => FIXED_NOW });

    const path = join(harness.libraryRoot, LIBRARY_README_FILENAME);
    const text = readFileSync(path, 'utf8');
    expect(text).toContain('git repository');
    expect(text).toContain('safe to hand-edit');
    expect(text).toContain('persona.md');
    // The owner's edits to their own README survive.
    writeFileSync(path, '# My roster\n', 'utf8');
    seedLibrary({ store, clock: () => FIXED_NOW });
    expect(readFileSync(path, 'utf8')).toBe('# My roster\n');
  });
});

// ---------------------------------------------------------------------------

describe('a seed exports and re-imports (M9 × M10)', () => {
  it('round-trips a starter agent through a .agentpack', async () => {
    const store = bootstrapped(harness);
    seedLibrary({ store, clock: () => FIXED_NOW });
    harness.service.load();

    const bytes = harness.service.exportPack('sam-skeptic').bytes;
    const result = await harness.service.importPack(bytes, { commit: true });
    expect(result.committed).toBe(true);
    expect(result.proposedId).toBe('sam-skeptic-2');

    const clone = harness.service.get('sam-skeptic-2').definition;
    const source = harness.service.get('sam-skeptic').definition;
    const { meta: _cloneMeta, id: _cloneId, ...cloneRest } = clone;
    const { meta: _sourceMeta, id: _sourceId, ...sourceRest } = source;
    expect(cloneRest).toEqual(sourceRest);
    expect(clone.meta.origin).toBe('imported');
    // No credential anywhere in the bytes, because there is none to carry.
    expect(bytes.includes(Buffer.from('secretRef'))).toBe(false);
    // And a secret store that holds nothing changes nothing about the import.
    expect(new Secret('unused')).toBeInstanceOf(Secret);
  });
});
