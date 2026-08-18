/**
 * `compileSession` — a definition plus a project plus an assignment into the
 * object handed to `query()` (roster DESIGN.md §13).
 *
 * This is the **only** file in the system that constructs SDK option shapes
 * (§13; runner's option whitelist deliberately does not gain `mcpServers`), and
 * it is the single merge point for the agent environment. Everything it does is
 * a mapping from §13's table; the judgement calls are all upstream, in
 * `permissions.ts` and `persona.ts`.
 *
 * ## Decisions taken here against SDK-NOTES' open items
 *
 * **D2 — `Options.tools` as a restriction list: not adopted as the restriction
 * mechanism.** §6.2's composition algebra is deny-union / allow-intersection
 * across three layers; a `tools` allowlist is a fourth lever with a different
 * algebra and no defined composition, and `EffectivePermissions` (M1's frozen
 * contract) has no field to record it in — so a tool absent from `tools` but
 * present in `allow` would be a contradiction the audit record could not
 * express. Deny is also strictly stronger where it matters: a scoped deny holds
 * in every mode including `bypassPermissions` and blocks harness-internal direct
 * calls, whereas `tools` only shapes the base set. So "restriction is expressed
 * with `deny`, never by omission" (§6.1) stands unchanged, and `tools` is emitted
 * as the explicit `claude_code` preset — a no-op today that states the base set
 * rather than inheriting whatever a future SDK defaults to. (SDK-NOTES D5's
 * `tools: []` for M8's inert drafting call is a different question and remains
 * the right answer there.)
 *
 * **D3 — `managedSettings` adopted for the compiled deny set.** `settingSources:
 * ["project"]` deliberately loads the target repo's `.claude/settings.json`
 * (§7.3), so a repo-committed `permissions.allow` enters the session *outside*
 * roster's composition and §6.2's "allow is an intersection" is a guarantee about
 * roster's three layers, not about the running session. `managedSettings` is the
 * tier the engine treats as policy and filters restrictive-only, so the compiled
 * deny — which already contains `policy.globalDeny` and the `write: false` floor
 * — is emitted there **as well as** in `disallowedTools`. It cannot widen
 * anything (permissive arrays in that tier are dropped by the engine), both
 * copies derive from one `effective.deny`, and the gap it closes is a real one.
 *
 * **D4 — `disableBypassPermissionsMode: 'disable'` adopted, on every launch.**
 * M1's schema already makes `bypassPermissions` unrepresentable; this makes the
 * same invariant hold in the engine, where a resumed session, a loaded settings
 * file or a `setPermissionMode()` call could otherwise reach it. Cheap, and it
 * moves an invariant from "roster's schema is careful" to "the engine refuses".
 *
 * ## Added in M5 / M6
 *
 * `plugins` and the exact-name `skills` check (§7, `skills.ts`), and
 * `mcpServers` from the agent's `integrations` with every `secretRef` resolved
 * (§10, `integrations.ts`). `skills` was already emitted in M4, because omitting
 * the key is not "off" — the CLI's own defaults still apply (SDK-NOTES §5) — and
 * `[]` is the only safe value for an agent that declares none.
 *
 * ## Added in M7
 *
 * `mcpServers.agentmanager` — the orchestrator's per-launch toolset instance
 * (§13's mapping row, orchestrator R1) — together with §11's
 * `mcp__agentmanager__*` grant, the subagent deny that D4 requires, the higher
 * overseer turn/budget defaults and the model floor. The instance is obtained
 * from {@link CompileSessionInput.toolset}, which the *module* wires to
 * `ctx.require('orchestrator')?.getSessionToolset` — this file stays a pure
 * function of its inputs, and one that is called exactly once per launch,
 * because the instance is single-use (orchestrator SDK-NOTES G2).
 */
import type { Diagnostic, EffectivePermissions } from './contracts.js';
import type { EnvLayer } from './envMerge.js';
import { mergeAgentEnv } from './envMerge.js';
import type { RequestedSessionSurface } from './initMessage.js';
import { compileIntegrations } from './integrations.js';
import {
  ORCHESTRATION_SERVER,
  SUBAGENT_TOOL_NAMES,
  applyOrchestrationGrant,
  isOverseer,
  overseerModelDiagnostic,
  OVERSEER_DEFAULT_MAX_BUDGET_USD,
  OVERSEER_DEFAULT_MAX_TURNS,
  OVERSEER_ONLY_TOOL_NAMES,
} from './overseer.js';
import { composePersona } from './persona.js';
import type { PersonaComposition } from './persona.js';
import { compilePermissions, denyTools, grantTool } from './permissions.js';
import type { CompiledPermissions } from './permissions.js';
import { MODEL_ALIASES } from './schema.js';
import type {
  ClaudeAgentSdkOptions,
  CompileSessionInput,
  CompiledSession,
  SessionToolsetHandle,
} from './sessionOptions.js';
import { SKILL_TOOL, pluginConfigFor, skillsEnableSet } from './skills.js';
import type { AgentPluginConfig } from './skills.js';

/**
 * Turn and budget defaults for an agent whose definition states none.
 *
 * The values §3's canonical definition carries. An overseer takes §11's higher
 * pair instead (`OVERSEER_DEFAULT_*`, M7) — "coordination is turn-expensive and
 * produces little output per turn" — and a definition's own `defaults` still
 * win over both, which is what "when unset" means.
 */
export const DEFAULT_MAX_TURNS = 60;
export const DEFAULT_MAX_BUDGET_USD = 2.5;

/** §11's "higher default `maxTurns` and `maxBudgetUsd`", now that M7 has said
 *  what higher means (`overseer.ts`). */
export { OVERSEER_DEFAULT_MAX_BUDGET_USD, OVERSEER_DEFAULT_MAX_TURNS } from './overseer.js';

/**
 * §8's warn-not-block model check.
 *
 * "An unrecognised string is accepted with a diagnostic, because a model
 * released after this build ships must not make an agent unloadable." So this
 * recognises the alias list, the documented alias variants (`opusplan`,
 * `sonnet[1m]`), and anything shaped like a full model id.
 */
function isRecognisedModel(model: string): boolean {
  const base = model.endsWith('[1m]') ? model.slice(0, -'[1m]'.length) : model;
  if ((MODEL_ALIASES as readonly string[]).includes(base)) return true;
  return /^claude-[a-z0-9][a-z0-9.-]*$/.test(base);
}

/** Stamps the agent id onto diagnostics raised by helpers that do not know it. */
function withAgentId(diagnostics: readonly Diagnostic[], agentId: string): Diagnostic[] {
  return diagnostics.map((diagnostic) => ({ agentId, ...diagnostic }));
}

/**
 * Compile a session.
 *
 * @throws {SessionCompileError} when a `secretRef` in the environment does not
 * resolve (§10) — the launch fails loudly rather than starting a session whose
 * tools will silently 401.
 */
export async function compileSession(input: CompileSessionInput): Promise<CompiledSession> {
  const { agent, project, assignment, policy } = input;
  const definition = agent.definition;
  const diagnostics: Diagnostic[] = [];

  // --- permissions (§6.2) --------------------------------------------------
  let compiled: CompiledPermissions = compilePermissions(
    definition.permissions,
    {
      ...(project?.permissionOverride === undefined
        ? {}
        : { permissions: project.permissionOverride }),
      ...(project?.elevation === undefined ? {} : { elevation: project.elevation }),
    },
    {
      write: assignment.write,
      ...(assignment.scopeRules === undefined ? {} : { scopeRules: assignment.scopeRules }),
    },
    policy,
  );
  diagnostics.push(...withAgentId(compiled.diagnostics, definition.id));

  // --- skills and the plugin (§7) -----------------------------------------
  const enableSet = skillsEnableSet(definition, agent.skills);
  diagnostics.push(...enableSet.diagnostics);

  const plugins: AgentPluginConfig[] = [];
  if (enableSet.enabled) {
    // `directory` is this module's name for the folder and `dir` is the store's
    // (`ResolvedAgent`); the runner hands over the latter, so reading only the
    // former would mount no plugin on every real launch. See `sessionOptions.ts`.
    const { plugin, diagnostics: pluginDiagnostics } = pluginConfigFor(
      definition.id,
      agent.directory ?? agent.dir,
    );
    diagnostics.push(...pluginDiagnostics);
    if (plugin !== undefined) plugins.push(plugin);
  }
  // §7.2: setting the option auto-adds the tool, so this entry is about
  // *auto-approval* — without it every skill invocation would prompt. Added only
  // when something can actually fire, so `skills.mode: "none"` yields "an empty
  // enable set and no `Skill` tool prompt" (M5) rather than a grant for a tool
  // the session will never offer.
  if (enableSet.enabled) compiled = grantTool(compiled, SKILL_TOOL);

  // --- the orchestration surface (§11, §13's toolset row) ------------------
  // The toolset instance is asked for **once**, here, and never cached: it is
  // single-use, and a reused one produces a session that believes it has the
  // tools and gets no answers (orchestrator SDK-NOTES G2).
  const declaresOverseer = isOverseer(definition);
  let toolsetHandle: SessionToolsetHandle | undefined;
  if (input.toolset !== undefined) {
    toolsetHandle = input.toolset({
      assignmentId: assignment.id,
      agentId: definition.id,
      ...(assignment.role === undefined ? {} : { role: assignment.role }),
      isOverseer: declaresOverseer,
    });
  }

  // **Owner decision, 2026-08-18**: capabilities are ranking hints, never gates
  // (orchestrator DESIGN §9-6). The coordinator's surface is granted by the
  // *seat* — whoever holds the lead seat of an overseer assignment — and the
  // element that knows who holds it is orchestrator, which answers by mounting
  // the two tools. So the grant follows the **mount**: what the instance
  // actually exposes decides which rules are compiled, and
  // `capabilities.overseer` is only the fallback for a launch with no toolset
  // to ask. Roster stays the sole composer of rules; it simply stops being the
  // sole decider of who is a coordinator.
  const overseer =
    toolsetHandle === undefined
      ? declaresOverseer
      : OVERSEER_ONLY_TOOL_NAMES.every((name) => toolsetHandle?.toolNames?.includes(name) ?? false);

  const orchestration = applyOrchestrationGrant(compiled, {
    agentId: definition.id,
    overseer,
    available: toolsetHandle !== undefined,
    ...(toolsetHandle?.toolNames === undefined
      ? {}
      : { mountedToolNames: toolsetHandle.toolNames }),
  });
  compiled = orchestration.compiled;
  diagnostics.push(...orchestration.diagnostics);

  // D4, in the tier that actually enforces it: the SDK's subagent tool is denied
  // by name — both the current one and the legacy `Task` — on every launch.
  // "AgentManager routes work between agents; agents do not spawn their own
  // hidden sub-hierarchies" (§11), and §6.1 is explicit that restriction is
  // expressed with `deny` rather than by omission from `allow`.
  compiled = denyTools(compiled, SUBAGENT_TOOL_NAMES);

  const effective: EffectivePermissions = compiled.effective;

  // --- system prompt (§4, §5) ---------------------------------------------
  const roleAddendum =
    assignment.role === undefined ? undefined : agent.roleAddenda?.[assignment.role];
  const systemPrompt: PersonaComposition = composePersona({
    mode: definition.persona.mode,
    persona: agent.persona,
    ...(roleAddendum === undefined ? {} : { roleAddendum }),
    ...(project?.instructions === undefined ? {} : { projectInstructions: project.instructions }),
    runtime: {
      agentId: definition.id,
      agentName: definition.name,
      assignmentId: assignment.id,
      ...(assignment.role === undefined ? {} : { role: assignment.role }),
    },
  });

  // --- environment (§13, §10) ---------------------------------------------
  const layers: EnvLayer[] = [];
  if (input.agentEnv !== undefined) {
    layers.push({
      source: 'foundation.agentEnv',
      entries: Object.entries(input.agentEnv).map(([name, value]) => ({ name, value })),
    });
  }
  if (project?.env !== undefined) layers.push({ source: 'project', entries: project.env });
  if (assignment.env !== undefined) layers.push({ source: 'assignment', entries: assignment.env });

  const merged = await mergeAgentEnv({
    base: input.baseEnv ?? process.env,
    layers,
    secrets: input.secrets,
    agentName: definition.name,
    agentId: definition.id,
  });
  diagnostics.push(...merged.diagnostics);

  // --- integrations → mcpServers (§10) ------------------------------------
  // After the env merge, because a stdio server's `env` is the session env plus
  // its own resolved entries: `Options.env` replaces rather than merges, and so
  // does a server's, so a server declaring one variable would otherwise lose
  // `PATH`. Throws rather than warns when a ref does not resolve.
  const integrations = await compileIntegrations({
    agentId: definition.id,
    agentName: definition.name,
    integrations: definition.integrations,
    secrets: input.secrets,
    sessionEnv: merged.env,
  });
  diagnostics.push(...integrations.diagnostics);

  // §13's toolset row: the per-launch instance sits beside the agent's own
  // servers under the one key roster reserves for it. The key is roster's, not
  // an agent's to claim — `agentmanager` is already a reserved agent id
  // (`ids.ts`), and an integration that named itself that would otherwise
  // silently replace the orchestration surface or be replaced by it.
  const mcpServers: Record<
    string,
    (typeof integrations.servers)[string] | SessionToolsetHandle['server']
  > = { ...integrations.servers };
  if (Object.prototype.hasOwnProperty.call(mcpServers, ORCHESTRATION_SERVER)) {
    delete mcpServers[ORCHESTRATION_SERVER];
    diagnostics.push({
      level: 'warn',
      code: 'roster.integration.reserved-name',
      message:
        `integration "${ORCHESTRATION_SERVER}" was dropped: that MCP server name is reserved for ` +
        'the orchestration toolset roster mounts itself (DESIGN §11, §13)',
      agentId: definition.id,
      path: `integrations.${ORCHESTRATION_SERVER}`,
    });
  }
  if (toolsetHandle !== undefined) mcpServers[ORCHESTRATION_SERVER] = toolsetHandle.server;
  const mcpServerNames = Object.keys(mcpServers);

  // --- model (§8) ----------------------------------------------------------
  const model = definition.model?.primary ?? input.defaultModel;
  if (model !== undefined && !isRecognisedModel(model)) {
    diagnostics.push({
      level: 'warn',
      code: 'roster.model.unrecognised',
      message:
        `model "${model}" is not a known alias or model id; it is passed through unchanged ` +
        '(DESIGN §8 — validation is warn-not-block so a newly released model cannot make an ' +
        'agent unloadable)',
      agentId: definition.id,
      path: 'model.primary',
    });
  }
  // §11's model floor, on the model the session will actually run — a `default`
  // that resolves to something weak is the same problem as a weak one declared.
  if (overseer) {
    const floor = overseerModelDiagnostic(definition.id, model);
    if (floor !== undefined) diagnostics.push(floor);
  }
  /** `fallbackModel` is a **comma-separated string**, not an array, on the
   *  pinned SDK (SDK-NOTES §5). `model.fallback` is a single value, so it maps
   *  straight across; a future list would join with `,` here and nowhere else. */
  const fallbackModel = definition.model?.fallback;

  // --- workspace (§13) -----------------------------------------------------
  const cwd = project?.cwd;
  const workspacePath = project?.workspace?.path;
  const additionalDirectories =
    workspacePath !== undefined && workspacePath !== cwd ? [workspacePath] : [];

  // --- the options object --------------------------------------------------
  const deny = [...effective.deny];
  const options: ClaudeAgentSdkOptions = {
    systemPrompt:
      systemPrompt.mode === 'replace'
        ? systemPrompt.text
        : {
            type: 'preset',
            preset: 'claude_code',
            append: systemPrompt.text,
            // §5's prompt-cache note. Confirmed present on the pinned SDK
            // (SDK-NOTES §2) and meaningless for the `replace` string form,
            // which is why it is only set on this branch.
            excludeDynamicSections: true,
          },
    // D2: stated, not inherited. See the module note.
    tools: { type: 'preset', preset: 'claude_code' },
    allowedTools: [...effective.allow],
    disallowedTools: deny,
    permissionMode: effective.mode,
    // §6.3: `ask` rules exist only in settings; the compiler emits them inline
    // rather than writing files. D4's hardening rides along.
    // `allow` is deliberately *not* repeated here: `allowedTools` already
    // carries it, and one auto-approve list is one place to be wrong.
    settings: {
      permissions: {
        deny: [...deny],
        ask: [...effective.ask],
        disableBypassPermissionsMode: 'disable',
      },
    },
    // D3: the restrictive-only policy tier, so a repo-committed settings file
    // loaded by `settingSources: ["project"]` cannot undercut the compiled deny.
    managedSettings: {
      permissions: {
        deny: [...deny],
        disableBypassPermissionsMode: 'disable',
      },
    },
    // Always emitted: when omitted, *all* sources load (SDK-NOTES §5). `user`
    // and `local` are unrepresentable in the schema (§7.3).
    settingSources: [...definition.settingSources],
    // §7.1: the agent folder *is* a plugin. Absolute path, and
    // `skipMcpDiscovery` so a stray `.mcp.json` in the folder cannot mount a
    // server §10 never approved (SDK-NOTES §4).
    plugins,
    skills: enableSet.skills,
    // §10's per-agent servers, plus §11's orchestration toolset under the one
    // key roster reserves (§13, orchestrator R1).
    mcpServers,
    additionalDirectories,
    env: merged.env,
    maxTurns:
      definition.defaults?.maxTurns ?? (overseer ? OVERSEER_DEFAULT_MAX_TURNS : DEFAULT_MAX_TURNS),
    maxBudgetUsd:
      definition.defaults?.maxBudgetUsd ??
      (overseer ? OVERSEER_DEFAULT_MAX_BUDGET_USD : DEFAULT_MAX_BUDGET_USD),
    ...(cwd === undefined ? {} : { cwd }),
    ...(model === undefined ? {} : { model }),
    ...(fallbackModel === undefined ? {} : { fallbackModel }),
    // Top-level `effort` exists on the pinned SDK (SDK-NOTES §5), so §8's
    // "drop with a diagnostic" branch is dead code here — kept in DESIGN as the
    // guard for a future SDK that removes the option.
    ...(definition.model?.effort === undefined ? {} : { effort: definition.model.effort }),
    // `canUseTool` is deliberately absent: roster specifies the default-deny
    // *policy* (§6.1) and the runner installs the callback (runner §5.1).
  };

  const requested: RequestedSessionSurface = {
    agentId: definition.id,
    pluginPaths: plugins.map((plugin) => plugin.path),
    skills: enableSet.skills,
    mcpServers: mcpServerNames,
  };

  return {
    options,
    effective,
    policy: compiled.policy,
    systemPrompt,
    requested,
    diagnostics,
  };
}
