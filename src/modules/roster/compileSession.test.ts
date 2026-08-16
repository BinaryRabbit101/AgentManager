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
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import { Secret } from '../../secrets/index.js';
import type { SecretResolver } from '../../secrets/index.js';

import { loadFixture } from './__tests__/fixtures.js';
import { DEFAULT_MAX_BUDGET_USD, DEFAULT_MAX_TURNS, compileSession } from './compileSession.js';
import { MUTATING_TOOL_DENY_RULES } from './permissions.js';
import type { PermissionPolicy } from './permissions.js';
import type { AssignmentContext, CompileSessionInput, ProjectContext } from './sessionOptions.js';
import { SessionCompileError } from './sessionOptions.js';

const EMPTY_SECRETS: SecretResolver = { get: () => Promise.resolve(undefined) };
const OPEN_POLICY: PermissionPolicy = { allowPermissionElevation: true, globalDeny: [] };

const BASE_ENV = { PATH: 'C:\\Windows\\System32', HOME: 'C:\\Users\\owner' } as const;

const SOLO_ASSIGNMENT: AssignmentContext = { id: 'assignment-1', write: true };

function inputFor(overrides: Partial<CompileSessionInput> = {}): CompileSessionInput {
  return {
    agent: {
      definition: loadFixture('coder'),
      persona: '# Priya\n\nReproduces first, then fixes.',
      roleAddenda: { skeptic: '## As the skeptic\n\nArgue the case against.' },
      directory: 'C:\\library\\agents\\priya-bugfix',
    },
    assignment: SOLO_ASSIGNMENT,
    policy: OPEN_POLICY,
    baseEnv: BASE_ENV,
    secrets: EMPTY_SECRETS,
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
});
