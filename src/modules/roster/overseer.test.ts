/**
 * Capabilities, roles and the overseer surface (roster IMPLEMENTATION **M7**).
 *
 * Every acceptance criterion of M7 is a named test below, and each is asserted
 * where the criterion is actually true — the grants and the subagent exclusion
 * on the *compiled options* rather than on a helper, the roster projection by a
 * deep key scan rather than by reading one field, and the toolset mount through
 * the **real** orchestrator factory rather than a hand-made stand-in, because
 * "roster mounts it" is a claim about two elements meeting.
 */
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { Clock } from '../../storage/index.js';
import {
  TOOLSET_SERVER_KEY,
  WORKER_TOOL_NAMES as ORCHESTRATOR_WORKER_TOOL_NAMES,
  createToolsetFactory,
  type ToolsetOptions,
} from '../orchestrator/toolset.js';

import { loadFixture } from './__tests__/fixtures.js';
import { makeTempDir, writeAgentFolder } from './__tests__/helpers.js';
import { compileSession } from './compileSession.js';
import { RosterValidationError } from './errors.js';
import {
  ORCHESTRATION_SERVER,
  OVERSEER_DEFAULT_MAX_BUDGET_USD,
  OVERSEER_DEFAULT_MAX_TURNS,
  OVERSEER_ONLY_TOOL_NAMES,
  OVERSEER_TOOL_NAMES,
  SUBAGENT_TOOL_NAMES,
  WORKER_TOOL_NAMES,
  orchestrationRule,
  projectRosterForOverseer,
} from './overseer.js';
import { parseAgentDefinition } from './parse.js';
import { renderRuntimeBlock } from './persona.js';
import type { PermissionPolicy } from './permissions.js';
import { createRosterStore } from './store.js';
import type { AgentDefinition, Role } from './schema.js';
import type {
  AssignmentContext,
  CompileSessionInput,
  CompiledSession,
  SessionToolsetProvider,
} from './sessionOptions.js';

import type { SecretResolver } from '../../secrets/index.js';

const EMPTY_SECRETS: SecretResolver = { get: () => Promise.resolve(undefined) };
const OPEN_POLICY: PermissionPolicy = { allowPermissionElevation: true, globalDeny: [] };
const SOLO: AssignmentContext = { id: 'assignment-1', write: true };

/**
 * The real orchestrator toolset factory.
 *
 * Its repositories are never touched by *mounting* — `createToolsetFactory`
 * closes over them and only a tool **call** reaches one — so the stubs are
 * empty on purpose: what this proves is that the object orchestrator builds is
 * the object roster puts on the options, and a fake server would prove nothing
 * about that.
 */
function realToolsetProvider(): { provider: SessionToolsetProvider; calls: number } {
  const clock: Clock = () => new Date('2026-08-17T00:00:00.000Z');
  const factory = createToolsetFactory({
    assignments: {},
    turns: {},
    mailbox: {},
    bus: { emit: () => undefined },
    clock,
    config: {},
    inbox: () => undefined,
    holdMs: 1,
    expireHours: 1,
  } as unknown as ToolsetOptions);

  const state = { calls: 0 };
  const provider: SessionToolsetProvider = (launch) => {
    state.calls += 1;
    return factory(launch);
  };
  return {
    provider,
    get calls() {
      return state.calls;
    },
  };
}

function inputFor(
  definition: AgentDefinition,
  overrides: Partial<CompileSessionInput> = {},
): CompileSessionInput {
  return {
    agent: { definition, persona: `# ${definition.name}` },
    assignment: SOLO,
    policy: OPEN_POLICY,
    baseEnv: {},
    secrets: EMPTY_SECRETS,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// The two grants (§11's table, orchestrator R1b)
// ---------------------------------------------------------------------------

describe('the orchestration grant (DESIGN §11)', () => {
  it("an overseer's compiled options carry all six orchestrator rules and never the subagent tool", async () => {
    const toolset = realToolsetProvider();
    const compiled = await compileSession(
      inputFor(loadFixture('overseer'), { toolset: toolset.provider }),
    );

    for (const name of OVERSEER_TOOL_NAMES) {
      expect(compiled.options.allowedTools).toContain(orchestrationRule(name));
    }
    // Both names, current and legacy — and denied rather than merely absent,
    // because "restriction is expressed with deny, never by omission" (§6.1).
    for (const tool of SUBAGENT_TOOL_NAMES) {
      expect(compiled.options.allowedTools).not.toContain(tool);
      expect(compiled.options.disallowedTools).toContain(tool);
      expect(compiled.options.managedSettings?.permissions?.deny).toContain(tool);
    }
    expect(SUBAGENT_TOOL_NAMES).toEqual(['Agent', 'Task']);
  });

  it('a non-overseer with an assignment gets exactly the four scoped rules, and neither overseer-only one', async () => {
    const toolset = realToolsetProvider();
    // The coder fixture declares no orchestration rules at all, which is the
    // ordinary case: the grant is compiled from capabilities, not declared.
    const compiled = await compileSession(
      inputFor(loadFixture('coder'), { toolset: toolset.provider }),
    );

    const granted = (compiled.options.allowedTools ?? []).filter((rule) =>
      rule.startsWith(`mcp__${ORCHESTRATION_SERVER}__`),
    );
    expect(granted.sort()).toEqual([...WORKER_TOOL_NAMES].map(orchestrationRule).sort());

    // Both directions, as the criterion asks: the four are present…
    for (const name of WORKER_TOOL_NAMES) {
      expect(compiled.options.allowedTools).toContain(orchestrationRule(name));
    }
    // …and the two that create work or reveal the roster are not.
    expect(OVERSEER_ONLY_TOOL_NAMES).toEqual(['list_roster', 'create_assignment']);
    for (const name of OVERSEER_ONLY_TOOL_NAMES) {
      expect(compiled.options.allowedTools).not.toContain(orchestrationRule(name));
    }
  });

  it("a worker's declared mcp__agentmanager__* wildcard does not smuggle in the overseer tools", async () => {
    const toolset = realToolsetProvider();
    // The overseer fixture's own permission block, on an agent that is not one:
    // the wildcard is exactly the rule that would otherwise grant everything.
    const definition: AgentDefinition = {
      ...loadFixture('coder'),
      permissions: {
        mode: 'default',
        allow: ['Read', `mcp__${ORCHESTRATION_SERVER}__*`],
        deny: [],
        ask: [],
      },
    };
    const compiled = await compileSession(inputFor(definition, { toolset: toolset.provider }));

    expect(compiled.options.allowedTools).not.toContain(`mcp__${ORCHESTRATION_SERVER}__*`);
    for (const name of OVERSEER_ONLY_TOOL_NAMES) {
      expect(compiled.options.allowedTools).not.toContain(orchestrationRule(name));
    }
    expect(compiled.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      'roster.orchestration.rules-replaced',
    );
  });

  it('drops every mcp__agentmanager__* rule, with a diagnostic, when the toolset is not mounted', async () => {
    const compiled = await compileSession(inputFor(loadFixture('overseer')));

    expect(
      (compiled.options.allowedTools ?? []).filter((rule) => rule.includes(ORCHESTRATION_SERVER)),
    ).toEqual([]);
    expect(compiled.options.mcpServers?.[ORCHESTRATION_SERVER]).toBeUndefined();
    expect(compiled.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      'roster.orchestration.unavailable',
    );
  });

  it('refuses the grant when a layer denies the tool, because deny wins in every mode', async () => {
    const toolset = realToolsetProvider();
    const definition: AgentDefinition = {
      ...loadFixture('coder'),
      permissions: { deny: [orchestrationRule('send_to_agent')] },
    };
    const compiled = await compileSession(inputFor(definition, { toolset: toolset.provider }));

    expect(compiled.options.allowedTools).not.toContain(orchestrationRule('send_to_agent'));
    expect(compiled.options.disallowedTools).toContain(orchestrationRule('send_to_agent'));
    expect(compiled.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      'roster.orchestration.grant-denied',
    );
  });
});

// ---------------------------------------------------------------------------
// The mount (§13's toolset row, orchestrator R1)
// ---------------------------------------------------------------------------

describe('mounting the toolset (roster §13, orchestrator R1)', () => {
  it("puts orchestrator's per-launch server instance at options.mcpServers.agentmanager", async () => {
    const toolset = realToolsetProvider();
    const compiled = await compileSession(
      inputFor(loadFixture('overseer'), { toolset: toolset.provider }),
    );

    const mounted = compiled.options.mcpServers?.[ORCHESTRATION_SERVER];
    expect(mounted).toBeDefined();
    expect(mounted).toMatchObject({ type: 'sdk', name: ORCHESTRATION_SERVER });
    // The key both elements name, agreed rather than assumed.
    expect(TOOLSET_SERVER_KEY).toBe(ORCHESTRATION_SERVER);
    // And what the startup assertion will look for in the init message (§7.1).
    expect(compiled.requested.mcpServers).toContain(ORCHESTRATION_SERVER);
  });

  it('asks for exactly one instance per compile — an instance is single-use (SDK-NOTES G2)', async () => {
    const toolset = realToolsetProvider();
    await compileSession(inputFor(loadFixture('coder'), { toolset: toolset.provider }));
    expect(toolset.calls).toBe(1);

    const second = await compileSession(
      inputFor(loadFixture('coder'), { toolset: toolset.provider }),
    );
    expect(toolset.calls).toBe(2);
    expect(second.options.mcpServers?.[ORCHESTRATION_SERVER]).toBeDefined();
  });

  it("roster's worker grant is the same four names orchestrator's toolset exposes (R1b)", () => {
    expect([...WORKER_TOOL_NAMES].sort()).toEqual([...ORCHESTRATOR_WORKER_TOOL_NAMES].sort());
  });

  it('never lets an agent integration claim the reserved server key', async () => {
    const toolset = realToolsetProvider();
    const definition: AgentDefinition = {
      ...loadFixture('coder'),
      integrations: { [ORCHESTRATION_SERVER]: { transport: 'stdio', command: 'node' } },
    };
    const compiled = await compileSession(inputFor(definition, { toolset: toolset.provider }));

    expect(compiled.options.mcpServers?.[ORCHESTRATION_SERVER]).toMatchObject({ type: 'sdk' });
    expect(compiled.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      'roster.integration.reserved-name',
    );
  });
});

// ---------------------------------------------------------------------------
// The flag, the floor and the defaults (§11)
// ---------------------------------------------------------------------------

describe('the overseer flag itself (DESIGN §11)', () => {
  it('rejects capabilities.overseer without "overseer" in roles', () => {
    const raw = { ...loadFixture('coder') } as unknown as Record<string, unknown>;
    raw['capabilities'] = { overseer: true, roles: ['reviewer'] };

    const failure = (() => {
      try {
        parseAgentDefinition(raw, 'overseer.test.ts');
        return undefined;
      } catch (error) {
        return error;
      }
    })();

    expect(failure).toBeInstanceOf(RosterValidationError);
    expect((failure as RosterValidationError).issues[0]?.message).toContain('must list "overseer"');
  });

  it('gives an overseer the higher turn and budget defaults when it states none', async () => {
    const definition: AgentDefinition = { ...loadFixture('overseer') };
    delete (definition as { defaults?: unknown }).defaults;

    const compiled = await compileSession(inputFor(definition));
    expect(compiled.options.maxTurns).toBe(OVERSEER_DEFAULT_MAX_TURNS);
    expect(compiled.options.maxBudgetUsd).toBe(OVERSEER_DEFAULT_MAX_BUDGET_USD);

    // A declared pair still wins — "when unset" is the whole condition.
    const declared = await compileSession(inputFor(loadFixture('overseer')));
    expect(declared.options.maxTurns).toBe(200);
  });

  it('warns when an overseer runs below the sonnet floor, and not otherwise', async () => {
    const weak: AgentDefinition = { ...loadFixture('overseer'), model: { primary: 'haiku' } };
    const warned = await compileSession(inputFor(weak));
    expect(warned.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      'roster.overseer.model-below-floor',
    );

    const strong = await compileSession(inputFor(loadFixture('overseer')));
    expect(strong.diagnostics.map((diagnostic) => diagnostic.code)).not.toContain(
      'roster.overseer.model-below-floor',
    );

    // The same weak model on a worker is nobody's business (§11 is about the
    // coordinator's judgement, not about every agent).
    const worker: AgentDefinition = { ...loadFixture('coder'), model: { primary: 'haiku' } };
    const quiet = await compileSession(inputFor(worker));
    expect(quiet.diagnostics.map((diagnostic) => diagnostic.code)).not.toContain(
      'roster.overseer.model-below-floor',
    );
  });
});

// ---------------------------------------------------------------------------
// The roster projection (§11)
// ---------------------------------------------------------------------------

describe('the roster an overseer may read (DESIGN §11)', () => {
  it('carries names, specialties, tags and capabilities and nothing else', () => {
    const projected = projectRosterForOverseer([
      loadFixture('coder'),
      loadFixture('email-responder'),
      loadFixture('overseer'),
    ]);

    expect(projected.map((entry) => entry.id)).toEqual([
      'priya-bugfix',
      'marcus-inbox',
      'iris-overseer',
    ]);
    expect(projected[2]?.capabilities).toEqual({
      overseer: true,
      roles: ['overseer', 'reviewer'],
    });
  });

  it('contains no permissions or integrations key anywhere, by deep key scan', () => {
    const projected = projectRosterForOverseer([
      loadFixture('coder'),
      // The one fixture with an integration carrying a secretRef.
      loadFixture('email-responder'),
      loadFixture('overseer'),
    ]);

    const keys = new Set<string>();
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const item of value) walk(item);
        return;
      }
      if (typeof value !== 'object' || value === null) return;
      for (const [key, child] of Object.entries(value)) {
        keys.add(key);
        walk(child);
      }
    };
    walk(projected);

    for (const forbidden of ['permissions', 'integrations', 'env', 'headers', 'secretRef']) {
      expect([...keys]).not.toContain(forbidden);
    }
    // And nothing that merely *looks* like a credential survived the projection.
    expect(JSON.stringify(projected)).not.toContain('secretRef');
    expect(JSON.stringify(projected)).not.toContain('mcp.gmail.token');
  });
});

// ---------------------------------------------------------------------------
// Role addenda (§4, M7's "role addendum lookup from roles/<role>.md")
// ---------------------------------------------------------------------------

describe('role addenda (DESIGN §4)', () => {
  const ADDENDUM = '## As the skeptic\n\nArgue the case against before you agree.';

  function agentWithRoles(): { dir: string; cleanup: () => void; definition: AgentDefinition } {
    const temp = makeTempDir('agentmanager-roster-roles-');
    const definition = loadFixture('coder');
    writeAgentFolder(temp.path, definition, {
      persona: '# Priya\n',
      files: {
        [join('roles', 'skeptic.md')]: ADDENDUM,
        [join('roles', 'reviewer.md')]: '## As the reviewer\n\nRead the diff twice.',
      },
    });
    return {
      dir: temp.path,
      cleanup: () => {
        temp.cleanup();
      },
      definition,
    };
  }

  it('appends the addendum only when the assignment supplies that role, and snapshot-matches', async () => {
    const agent = agentWithRoles();
    try {
      const store = createRosterStore({ root: agent.dir });
      const outcome = store.load(agent.definition.id);
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;

      // The store read every `roles/*.md` while it read the folder, so the
      // compiler never touches the disk (§13).
      expect(Object.keys(outcome.agent.roleAddenda).sort()).toEqual(['reviewer', 'skeptic']);

      const composed = async (role?: Role): Promise<CompiledSession> =>
        compileSession({
          agent: outcome.agent,
          assignment: { ...SOLO, ...(role === undefined ? {} : { role }) },
          policy: OPEN_POLICY,
          baseEnv: {},
          secrets: EMPTY_SECRETS,
        });

      const skeptic = await composed('skeptic');
      const implementer = await composed('implementer');
      const none = await composed();

      // The snapshot: §4's four slots in order, blank-line joined, with the
      // addendum in the second one and the runtime block naming the seat.
      expect(skeptic.systemPrompt.sections).toEqual(['persona', 'role', 'runtime']);
      expect(skeptic.systemPrompt.text).toBe(
        [
          '# Priya',
          ADDENDUM,
          renderRuntimeBlock({
            agentId: agent.definition.id,
            agentName: agent.definition.name,
            assignmentId: SOLO.id,
            role: 'skeptic',
          }),
        ].join('\n\n'),
      );

      // A role whose file does not exist, and no role at all, both compose
      // without the slot rather than with an empty one.
      expect(implementer.systemPrompt.sections).toEqual(['persona', 'runtime']);
      expect(implementer.systemPrompt.text).not.toContain(ADDENDUM);
      expect(none.systemPrompt.sections).toEqual(['persona', 'runtime']);
      expect(none.systemPrompt.text).not.toContain('reviewer');
    } finally {
      agent.cleanup();
    }
  });

  it('makes an edited role file a real change to the agent, not a no-op reload', () => {
    const agent = agentWithRoles();
    try {
      const store = createRosterStore({ root: agent.dir });
      const before = store.load(agent.definition.id);
      writeAgentFolder(agent.dir, agent.definition, {
        persona: '# Priya\n',
        files: { [join('roles', 'skeptic.md')]: `${ADDENDUM}\n\nAnd say so plainly.` },
      });
      const after = store.load(agent.definition.id);

      expect(before.ok && after.ok).toBe(true);
      if (!before.ok || !after.ok) return;
      expect(after.agent.contentHash).not.toBe(before.agent.contentHash);
    } finally {
      agent.cleanup();
    }
  });
});
