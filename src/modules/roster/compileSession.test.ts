/**
 * `compileSession` (roster IMPLEMENTATION M4).
 *
 * Three kinds of assertion live here and they are deliberately different:
 *
 * 1. **Type-level.** `compiled.options` is typed as the pinned SDK's `Options`
 *    and is assigned to `Parameters<typeof query>[0]['options']` below, so
 *    `npm run typecheck` fails if the compiler ever emits a shape the SDK does
 *    not declare. This is the check that must stand on its own: this machine has
 *    no `CLAUDE_CODE_OAUTH_TOKEN` and never starts a session.
 * 2. **Options construction.** What the object actually contains, field by
 *    field, against §13's mapping table.
 * 3. **Runtime smoke.** `query()` accepting the object, gated on a token being
 *    present and skipped otherwise.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import { Secret } from '../../secrets/index.js';
import type { SecretResolver } from '../../secrets/index.js';

import { loadFixture } from './__tests__/fixtures.js';
import { makeTempDir, writeSkillFolder } from './__tests__/helpers.js';
import { DEFAULT_MAX_BUDGET_USD, DEFAULT_MAX_TURNS, compileSession } from './compileSession.js';
import { assertSessionStart } from './initMessage.js';
import { MUTATING_TOOL_DENY_RULES } from './permissions.js';
import type { PermissionPolicy } from './permissions.js';
import { allowsAskUserQuestion } from './sdkRules.js';
import type {
  AssignmentContext,
  CompilableAgent,
  CompileSessionInput,
  ProjectContext,
} from './sessionOptions.js';
import { SessionCompileError } from './sessionOptions.js';

const EMPTY_SECRETS: SecretResolver = { get: () => Promise.resolve(undefined) };

/**
 * Resolves the one ref M1's fixtures carry (`email-responder`'s Gmail token).
 *
 * The default for {@link inputFor}, because since M6 an unresolved `secretRef`
 * in an integration *fails the compile* (§10) — so a test about `settingSources`
 * that happened to use that fixture would otherwise fail for a reason that has
 * nothing to do with what it is asserting. {@link EMPTY_SECRETS} is still passed
 * explicitly by the tests that are about the failure itself.
 */
const FIXTURE_SECRETS: SecretResolver = {
  get: (key) => Promise.resolve(key === 'mcp.gmail.token' ? new Secret('gmail-t0ken') : undefined),
};
const OPEN_POLICY: PermissionPolicy = { allowPermissionElevation: true, globalDeny: [] };

const BASE_ENV = { PATH: 'C:\\Windows\\System32', HOME: 'C:\\Users\\owner' } as const;

const SOLO_ASSIGNMENT: AssignmentContext = { id: 'assignment-1', write: true };

const AGENT_DIR = 'C:\\library\\agents\\priya-bugfix';

/** The coder fixture with the one skill it declares actually present on disk. */
function coderWithSkills(): CompilableAgent {
  return {
    definition: loadFixture('coder'),
    persona: '# Priya',
    directory: AGENT_DIR,
    skills: ['triage-a-stack-trace'],
  };
}

function inputFor(overrides: Partial<CompileSessionInput> = {}): CompileSessionInput {
  return {
    agent: {
      definition: loadFixture('coder'),
      persona: '# Priya\n\nReproduces first, then fixes.',
      roleAddenda: { skeptic: '## As the skeptic\n\nArgue the case against.' },
      directory: AGENT_DIR,
      skills: ['triage-a-stack-trace'],
    },
    assignment: SOLO_ASSIGNMENT,
    policy: OPEN_POLICY,
    baseEnv: BASE_ENV,
    secrets: FIXTURE_SECRETS,
    ...overrides,
  };
}

const PROJECT: ProjectContext = {
  projectId: 'project-1',
  cwd: 'C:\\worktrees\\billing-priya',
  env: [{ name: 'APP_ENV', value: 'test' }],
  instructions: 'Billing runs on PHP 8.2.',
  workspace: { kind: 'worktree', path: 'C:\\worktrees\\billing-priya', branch: 'fix/500s' },
};

describe('compileSession — the §13 option mapping', () => {
  it('produces an object the SDK declares (type-level, no session started)', async () => {
    const compiled = await compileSession(inputFor());

    // If `compileSession` ever emits a field the pinned SDK does not declare,
    // or the wrong type for one it does, these two lines stop compiling.
    const options: Options = compiled.options;
    const queryParams: Parameters<typeof query>[0] = { prompt: 'noop', options };
    expect(queryParams.options).toBe(compiled.options);
  });

  it('maps the persona onto the claude_code preset in append mode', async () => {
    const compiled = await compileSession(inputFor());
    expect(compiled.options.systemPrompt).toMatchObject({
      type: 'preset',
      preset: 'claude_code',
      excludeDynamicSections: true,
    });
    const prompt = compiled.options.systemPrompt;
    const append = typeof prompt === 'object' && !Array.isArray(prompt) ? prompt.append : undefined;
    expect(append).toContain('# Priya');
    expect(append).toContain('## AgentManager runtime');
  });

  it('maps a replace-mode persona onto a plain string and sets no preset fields', async () => {
    const compiled = await compileSession(
      inputFor({
        agent: { definition: loadFixture('email-responder'), persona: '# Marcus\n\nAnswer mail.' },
      }),
    );
    expect(typeof compiled.options.systemPrompt).toBe('string');
    expect(compiled.options.systemPrompt).toContain('# Marcus');
    expect(compiled.options.systemPrompt).toContain('## AgentManager runtime');
  });

  it('appends the role addendum the assignment asked for', async () => {
    const compiled = await compileSession(
      inputFor({ assignment: { ...SOLO_ASSIGNMENT, role: 'skeptic' } }),
    );
    expect(compiled.systemPrompt.sections).toEqual(['persona', 'role', 'runtime']);
    expect(compiled.systemPrompt.text).toContain('## As the skeptic');
  });

  it('carries the composed permissions into allowedTools, disallowedTools and permissionMode', async () => {
    const compiled = await compileSession(inputFor());
    expect(compiled.options.allowedTools).toEqual(compiled.effective.allow);
    expect(compiled.options.disallowedTools).toEqual(compiled.effective.deny);
    expect(compiled.options.permissionMode).toBe(compiled.effective.mode);
    expect(compiled.options.permissionMode).toBe('acceptEdits');
  });

  it('emits ask rules through the inline settings object (§6.3), not through allow/deny', async () => {
    const compiled = await compileSession(inputFor());
    const settings = compiled.options.settings;
    expect(typeof settings).toBe('object');
    expect(typeof settings === 'object' ? settings.permissions?.ask : undefined).toEqual([
      'Bash(git commit*)',
    ]);
  });

  it('hardens the launch: disableBypassPermissionsMode in both settings tiers (SDK-NOTES D4)', async () => {
    const compiled = await compileSession(inputFor());
    const settings = compiled.options.settings;
    expect(
      typeof settings === 'object' ? settings.permissions?.disableBypassPermissionsMode : '',
    ).toBe('disable');
    expect(compiled.options.managedSettings?.permissions?.disableBypassPermissionsMode).toBe(
      'disable',
    );
  });

  it('repeats the compiled deny into managedSettings, the restrictive-only tier (SDK-NOTES D3)', async () => {
    const compiled = await compileSession(
      inputFor({ policy: { allowPermissionElevation: true, globalDeny: ['Bash(curl*)'] } }),
    );
    expect(compiled.options.managedSettings?.permissions?.deny).toEqual(compiled.effective.deny);
    expect(compiled.options.managedSettings?.permissions?.deny).toContain('Bash(curl*)');
    expect(compiled.options.managedSettings?.permissions?.allow).toBeUndefined();
  });

  it('states the tool base set as the claude_code preset rather than inheriting it (SDK-NOTES D2)', async () => {
    const compiled = await compileSession(inputFor());
    expect(compiled.options.tools).toEqual({ type: 'preset', preset: 'claude_code' });
  });

  it('never sets canUseTool — roster specifies the policy, the runner installs the callback', async () => {
    const compiled = await compileSession(inputFor());
    expect(compiled.options.canUseTool).toBeUndefined();
    expect(compiled.policy.default).toBe('deny');
  });

  it('always emits settingSources, and never user or local (§7.3, SDK-NOTES §5)', async () => {
    const compiled = await compileSession(inputFor());
    expect(compiled.options.settingSources).toEqual(['project']);
    const hermetic = await compileSession(
      inputFor({ agent: { definition: loadFixture('email-responder'), persona: 'x' } }),
    );
    expect(hermetic.options.settingSources).toEqual([]);
    for (const compiledSession of [compiled, hermetic]) {
      expect(compiledSession.options.settingSources).not.toContain('user');
      expect(compiledSession.options.settingSources).not.toContain('local');
    }
  });

  it('always emits skills, because omitting the key is not "off" (SDK-NOTES §5)', async () => {
    expect((await compileSession(inputFor())).options.skills).toEqual(['triage-a-stack-trace']);
    expect(
      (
        await compileSession(
          inputFor({ agent: { definition: loadFixture('email-responder'), persona: 'x' } }),
        )
      ).options.skills,
    ).toEqual([]);
    expect(
      (
        await compileSession(
          inputFor({ agent: { definition: loadFixture('minimal'), persona: '' } }),
        )
      ).options.skills,
    ).toEqual([]);
  });

  it('maps model, fallbackModel (a comma-separated string, not an array) and effort', async () => {
    const compiled = await compileSession(inputFor());
    expect(compiled.options.model).toBe('sonnet');
    expect(compiled.options.fallbackModel).toBe('haiku');
    expect(typeof compiled.options.fallbackModel).toBe('string');
    expect(compiled.options.effort).toBe('high');
  });

  it('falls back to the configured default model and warns about an unknown one', async () => {
    const withDefault = await compileSession(
      inputFor({
        agent: { definition: loadFixture('minimal'), persona: '' },
        defaultModel: 'sonnet',
      }),
    );
    expect(withDefault.options.model).toBe('sonnet');
    expect(withDefault.diagnostics).toEqual([]);

    const unknown = await compileSession(
      inputFor({
        agent: { definition: loadFixture('minimal'), persona: '' },
        defaultModel: 'gpt-9',
      }),
    );
    expect(unknown.options.model).toBe('gpt-9');
    expect(unknown.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      'roster.model.unrecognised',
    );
  });

  it('takes maxTurns and maxBudgetUsd from the definition, or roster defaults', async () => {
    const compiled = await compileSession(inputFor());
    expect(compiled.options.maxTurns).toBe(60);
    expect(compiled.options.maxBudgetUsd).toBe(2.5);

    const minimal = await compileSession(
      inputFor({ agent: { definition: loadFixture('minimal'), persona: '' } }),
    );
    expect(minimal.options.maxTurns).toBe(DEFAULT_MAX_TURNS);
    expect(minimal.options.maxBudgetUsd).toBe(DEFAULT_MAX_BUDGET_USD);
  });

  it('sets cwd from the project lease and leaves additionalDirectories empty when they agree', async () => {
    const compiled = await compileSession(inputFor({ project: PROJECT }));
    expect(compiled.options.cwd).toBe('C:\\worktrees\\billing-priya');
    expect(compiled.options.additionalDirectories).toEqual([]);
  });

  it('adds the workspace path only when it is not the cwd', async () => {
    const compiled = await compileSession(
      inputFor({
        project: {
          ...PROJECT,
          cwd: 'C:\\worktrees\\billing-priya\\services\\billing',
        },
      }),
    );
    expect(compiled.options.additionalDirectories).toEqual(['C:\\worktrees\\billing-priya']);
  });

  it('omits cwd entirely for a project-less agent rather than inheriting the service cwd', async () => {
    const compiled = await compileSession(
      inputFor({ agent: { definition: loadFixture('email-responder'), persona: 'x' } }),
    );
    expect('cwd' in compiled.options).toBe(false);
  });

  it('merges the environment once, here, in §13 order, and keeps PATH', async () => {
    const compiled = await compileSession(
      inputFor({
        project: PROJECT,
        assignment: { ...SOLO_ASSIGNMENT, env: [{ name: 'APP_ENV', value: 'assignment' }] },
        agentEnv: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', APP_ENV: 'foundation' },
      }),
    );
    expect(compiled.options.env?.['PATH']).toBe(BASE_ENV.PATH);
    expect(compiled.options.env?.['CLAUDE_CODE_DISABLE_AUTO_MEMORY']).toBe('1');
    expect(compiled.options.env?.['APP_ENV']).toBe('assignment');
  });

  it('resolves a project env secretRef, and fails the launch by name when it cannot', async () => {
    const withSecret = await compileSession(
      inputFor({
        project: { ...PROJECT, env: [{ name: 'DB_TOKEN', secretRef: 'project.billing.db' }] },
        secrets: {
          get: (key) =>
            Promise.resolve(key === 'project.billing.db' ? new Secret('t0k') : undefined),
        },
      }),
    );
    expect(withSecret.options.env?.['DB_TOKEN']).toBe('t0k');

    await expect(
      compileSession(
        inputFor({
          project: { ...PROJECT, env: [{ name: 'DB_TOKEN', secretRef: 'project.billing.db' }] },
        }),
      ),
    ).rejects.toBeInstanceOf(SessionCompileError);
  });

  it('carries the permission diagnostics out, stamped with the agent id', async () => {
    const compiled = await compileSession(
      inputFor({
        project: {
          ...PROJECT,
          elevation: { allow: ['WebSearch'], reason: 'sandbox' },
        },
        policy: { allowPermissionElevation: false, globalDeny: [] },
      }),
    );
    expect(compiled.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      'roster.permissions.elevation-dropped',
    ]);
    expect(compiled.diagnostics[0]?.agentId).toBe('priya-bugfix');
  });

  it('applies the write: false floor end to end', async () => {
    const compiled = await compileSession(
      inputFor({ assignment: { ...SOLO_ASSIGNMENT, write: false } }),
    );
    for (const rule of MUTATING_TOOL_DENY_RULES) {
      expect(compiled.options.disallowedTools).toContain(rule);
      expect(compiled.options.managedSettings?.permissions?.deny).toContain(rule);
    }
    expect(compiled.options.allowedTools).not.toContain('Edit');
  });
});

// ---------------------------------------------------------------------------
// M5 — skills packaging (§7)
// ---------------------------------------------------------------------------

describe('compileSession — skills and the plugin (§7)', () => {
  it('mounts the agent folder as a local plugin, absolute, with MCP discovery skipped', async () => {
    const compiled = await compileSession(inputFor({ agent: coderWithSkills() }));

    expect(compiled.options.plugins).toEqual([
      { type: 'local', path: AGENT_DIR, skipMcpDiscovery: true },
    ]);
  });

  it('adds "Skill" to the effective allow set, so a skill call is not a prompt (§7.2)', async () => {
    const compiled = await compileSession(inputFor({ agent: coderWithSkills() }));

    expect(compiled.effective.allow).toContain('Skill');
    expect(compiled.options.allowedTools).toContain('Skill');
    expect(compiled.options.allowedTools).toEqual(compiled.effective.allow);
  });

  it('yields an empty enable set, no plugin and no Skill grant for mode "none"', async () => {
    const compiled = await compileSession(
      inputFor({ agent: { definition: loadFixture('email-responder'), persona: 'x', skills: [] } }),
    );

    expect(compiled.options.skills).toEqual([]);
    expect(compiled.options.plugins).toEqual([]);
    expect(compiled.options.allowedTools).not.toContain('Skill');
    expect(compiled.effective.allow).not.toContain('Skill');
  });

  it('drops a declared skill whose folder has gone, with a diagnostic, and still launches', async () => {
    const compiled = await compileSession(
      inputFor({
        agent: { ...coderWithSkills(), skills: [] },
      }),
    );

    expect(compiled.options.skills).toEqual([]);
    // No plugin either: nothing left that could fire.
    expect(compiled.options.plugins).toEqual([]);
    expect(compiled.diagnostics.map((d) => d.code)).toContain('roster.skills.missing-folder');
  });

  it('refuses to mount a relative plugin path rather than letting the SDK skip it silently', async () => {
    const compiled = await compileSession(
      inputFor({
        agent: {
          definition: loadFixture('coder'),
          persona: 'x',
          directory: 'agents/priya-bugfix',
          skills: ['triage-a-stack-trace'],
        },
      }),
    );

    expect(compiled.options.plugins).toEqual([]);
    expect(compiled.diagnostics.map((d) => d.code)).toContain('roster.skills.relative-plugin-path');
  });

  it('publishes what it asked for, in the shape the startup assertion consumes', async () => {
    const compiled = await compileSession(inputFor({ agent: coderWithSkills() }));

    expect(compiled.requested).toEqual({
      agentId: 'priya-bugfix',
      pluginPaths: [AGENT_DIR],
      skills: ['triage-a-stack-trace'],
      mcpServers: [],
    });
    // The init message that would satisfy it produces no diagnostics.
    expect(
      assertSessionStart(compiled.requested, {
        plugins: [{ name: 'priya-bugfix', path: AGENT_DIR }],
        skills: ['triage-a-stack-trace'],
        mcp_servers: [],
      }),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// M6 — integrations and secret resolution (§10)
// ---------------------------------------------------------------------------

describe('compileSession — integrations (§10)', () => {
  it('compiles the agent’s integrations into mcpServers with the secret resolved', async () => {
    const compiled = await compileSession(
      inputFor({ agent: { definition: loadFixture('email-responder'), persona: 'x' } }),
    );

    expect(compiled.options.mcpServers?.['gmail']).toMatchObject({
      type: 'stdio',
      command: 'npx',
      env: { GMAIL_TOKEN: 'gmail-t0ken', GMAIL_PROFILE: 'work' },
    });
  });

  it('spreads the session environment into a stdio server, so PATH survives (§10)', async () => {
    const compiled = await compileSession(
      inputFor({ agent: { definition: loadFixture('email-responder'), persona: 'x' } }),
    );
    const gmail = compiled.options.mcpServers?.['gmail'];
    const env = gmail !== undefined && 'env' in gmail ? gmail.env : undefined;

    expect(env?.['PATH']).toBe(BASE_ENV.PATH);
  });

  it('fails the launch, naming the agent and the ref, when a credential is missing', async () => {
    const failure = await compileSession(
      inputFor({
        agent: { definition: loadFixture('email-responder'), persona: 'x' },
        secrets: EMPTY_SECRETS,
      }),
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(SessionCompileError);
    expect((failure as SessionCompileError).message).toContain('Marcus');
    expect((failure as SessionCompileError).message).toContain('mcp.gmail.token');
  });

  it('emits an empty mcpServers record for an agent that declares none', async () => {
    const compiled = await compileSession(inputFor());
    expect(compiled.options.mcpServers).toEqual({});
    expect(compiled.requested.mcpServers).toEqual([]);
  });

  it('never leaks a resolved secret into the diagnostics or the audit record', async () => {
    const compiled = await compileSession(
      inputFor({ agent: { definition: loadFixture('email-responder'), persona: 'x' } }),
    );

    expect(JSON.stringify(compiled.diagnostics)).not.toContain('gmail-t0ken');
    expect(JSON.stringify(compiled.effective)).not.toContain('gmail-t0ken');
    expect(JSON.stringify(compiled.requested)).not.toContain('gmail-t0ken');
  });
});

// ---------------------------------------------------------------------------
// The two owed SDK-spike fixes, in the compiled options
// ---------------------------------------------------------------------------

describe('compileSession — the compiled options honour the M0 spike findings', () => {
  it('never emits AskUserQuestion into allowedTools (runner SDK-NOTES C2)', async () => {
    const definition = loadFixture('coder');
    const compiled = await compileSession(
      inputFor({
        agent: {
          definition: {
            ...definition,
            permissions: { ...definition.permissions, allow: ['Read', 'AskUserQuestion'] },
          },
          persona: 'x',
        },
      }),
    );

    expect(allowsAskUserQuestion(compiled.options.allowedTools ?? [])).toBe(false);
    const settings = compiled.options.settings;
    expect(typeof settings === 'object' ? settings.permissions?.ask : []).toContain(
      'AskUserQuestion',
    );
  });

  it('never emits Edit(*), and expresses a file scope as Edit(path) (orchestrator C1)', async () => {
    const definition = loadFixture('coder');
    const compiled = await compileSession(
      inputFor({
        agent: {
          definition: {
            ...definition,
            permissions: { ...definition.permissions, allow: ['Edit', 'Edit(*)', 'Read'] },
          },
          persona: 'x',
        },
        assignment: {
          ...SOLO_ASSIGNMENT,
          scopeRules: { allow: ['Write(./services/billing/**)'] },
        },
      }),
    );

    expect(compiled.options.allowedTools).not.toContain('Edit(*)');
    expect(compiled.options.allowedTools).toContain('Edit(./services/billing/**)');
  });
});

// ---------------------------------------------------------------------------
// Runtime smoke test
// ---------------------------------------------------------------------------

/**
 * Gated: this machine has no `CLAUDE_CODE_OAUTH_TOKEN` (SDK-NOTES M0 verified
 * the surface statically for the same reason). The type-level check above and
 * the construction tests stand alone; this one proves the *engine* accepts the
 * object when there is an account to run it under.
 */
const hasToken =
  typeof process.env['CLAUDE_CODE_OAUTH_TOKEN'] === 'string' &&
  process.env['CLAUDE_CODE_OAUTH_TOKEN'] !== '';

describe.skipIf(!hasToken)('compileSession — runtime smoke', () => {
  it(
    'query() accepts the compiled options with a trivial prompt',
    { timeout: 120_000 },
    async () => {
      const compiled = await compileSession(
        inputFor({ baseEnv: process.env, project: { ...PROJECT, cwd: process.cwd() } }),
      );
      const controller = new AbortController();
      const session = query({
        prompt: 'Reply with the single word: ok',
        options: {
          ...compiled.options,
          // Keep the smoke test inert and cheap: no tools, one turn.
          tools: [],
          maxTurns: 1,
          abortController: controller,
        },
      });

      let sawInit = false;
      for await (const message of session) {
        if (message.type === 'system') sawInit = true;
        if (message.type === 'result') break;
      }
      controller.abort();
      expect(sawInit).toBe(true);
    },
  );

  /**
   * M5's one acceptance item that cannot be proved without an account: "an agent
   * with two skills launches with both present in the init message's `skills`
   * array (integration test against a real short session)".
   *
   * The *comparison* it makes is `assertSessionStart`, which
   * `initMessage.test.ts` exercises against a fabricated init message on every
   * run — so what is gated here is only the question of whether the engine
   * really loads a local plugin's skills, which is the half no static reading
   * can settle (SDK-NOTES §7).
   */
  it(
    'an agent with two skills sees both in the init message’s skills array',
    { timeout: 120_000 },
    async () => {
      const temp = makeTempDir('agentmanager-roster-live-skills-');
      try {
        const agentDir = join(temp.path, 'priya-bugfix');
        mkdirSync(agentDir, { recursive: true });
        mkdirSync(join(agentDir, '.claude-plugin'), { recursive: true });
        writeFileSync(
          join(agentDir, '.claude-plugin', 'plugin.json'),
          JSON.stringify({ name: 'priya-bugfix', version: '1.0.0' }),
          'utf8',
        );
        writeSkillFolder(agentDir, 'triage-a-stack-trace');
        writeSkillFolder(agentDir, 'apply-a-patch');

        const definition = loadFixture('coder');
        const compiled = await compileSession(
          inputFor({
            agent: {
              definition: {
                ...definition,
                skills: {
                  mode: 'declared',
                  names: ['triage-a-stack-trace', 'apply-a-patch'],
                },
              },
              persona: '# Priya',
              directory: agentDir,
              skills: ['apply-a-patch', 'triage-a-stack-trace'],
            },
            baseEnv: process.env,
            project: { ...PROJECT, cwd: process.cwd() },
          }),
        );

        const controller = new AbortController();
        const session = query({
          prompt: 'Reply with the single word: ok',
          options: { ...compiled.options, maxTurns: 1, abortController: controller },
        });

        let init: { skills?: string[]; plugins?: { name: string; path: string }[] } | undefined;
        for await (const message of session) {
          if (message.type === 'system' && message.subtype === 'init') init = message;
          if (message.type === 'result') break;
        }
        controller.abort();

        expect(init).toBeDefined();
        // The assertion helper, run against a real init message rather than a
        // fabricated one — the same call the runner makes at session start.
        expect(assertSessionStart(compiled.requested, init ?? {})).toEqual([]);
      } finally {
        temp.cleanup();
      }
    },
  );
});
