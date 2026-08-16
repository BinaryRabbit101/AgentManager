# Roster M0 — Claude Agent SDK surface verification

Static verification of every SDK assumption [DESIGN.md](DESIGN.md) makes, against the exact version
pinned in `package.json`.

| | |
|---|---|
| Package | `@anthropic-ai/claude-agent-sdk` |
| Version pinned (exact, no range) | **0.3.233** |
| Bundled CLI (`manifest.json`) | `2.1.233`, commit `f8d5756`, built 2026-08-14 |
| Verified against | `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` (8043 lines), `sdk-tools.d.ts`, `extractFromBunfs.js`, `manifest.json` |
| Method | **Static only** — type declarations and the shipped JS. No session was started; no auth token exists on this machine. |
| Date | 2026-08-16 |

**Reading the shipped runtime.** The engine ships as a per-platform Bun-compiled executable
(`@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe`, 320 MB) whose JavaScript is compiled to
bytecode, so the permission *logic* is not readable as source. String-table scans of the binary
confirm the vocabulary (`dontAsk`, `auto`, `avoid_prompts`, `suppressed_mode`, `suppressed_deny_rule`,
`passthrough` / "DontAsk mode is handled in main permission flow") but cannot prove control flow.
Where behaviour could not be established from declarations, it is marked **unverified** below rather
than asserted — that distinction is the point of this document.

---

## 1. `PermissionMode`

As declared (`sdk.d.ts:2171`):

```ts
export declare type PermissionMode =
  'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto';
```

The union is documented identically in three places (`sdk.d.ts:1759-1763` on `Options.permissionMode`,
`:2169` on the type, `:4705` on the init message).

### 1.1 Behaviour when a tool call matches no allow / deny / ask rule

| Member | No-rule-matched behaviour | Verdict | Note |
|---|---|---|---|
| `default` | **Prompt** (reaches `canUseTool`) | confirmed | "Standard behavior, prompts for dangerous operations" (`sdk.d.ts:2169`). |
| `acceptEdits` | **Auto-approve for file-edit tools**, prompt otherwise | confirmed | "Auto-accept file edit operations" (`:1760`). Scope is edits only; everything else falls through to the prompt path. |
| `bypassPermissions` | **Auto-approve everything** | confirmed | "Bypass all permission checks (requires `allowDangerouslySkipPermissions`)" (`:1761`, `:1774`). Not selectable from roster's schema. |
| `plan` | **No tool execution** (read-only enforcement) | confirmed | "Planning mode, no actual tool execution" (`:2169`); `planModeInstructions` (`:1767-1771`) documents that the CLI wraps the prompt with "the read-only enforcement preamble and the ExitPlanMode protocol footer". |
| `dontAsk` | **Auto-reject, without prompting** | confirmed | "Don't prompt for permissions, deny if not pre-approved" (`:1763`), and see §1.2. |
| `auto` | **Model classifier decides approve/deny, without prompting** | **absent from DESIGN** | "Use a model classifier to approve/deny permission prompts" (`:2169`). See Design contradictions D1. |

### 1.2 `dontAsk` never prompts *and* auto-rejects — the load-bearing check

DESIGN §6.2 flags this as "the one place in §6 where a naming assumption is doing load-bearing work",
and runner DESIGN §15.4 states `canUseTool` is skipped and the call denied. **Confirmed** against this
version, from two independent declarations:

1. `sdk.d.ts:1763` — `'dontAsk'` — "Don't prompt for permissions, **deny if not pre-approved**".
2. `sdk.d.ts:4425-4426`, the doc on `SDKPermissionDeniedMessage` — "Emitted when a tool call is
   **auto-denied without an interactive permission prompt** (e.g. auto-mode classifier, **dontAsk
   mode**, headless-agent auto-deny, or a deny rule). With a permission prompt surface (stdio/SDK
   `canUseTool`), the `'ask'` path surfaces via a `can_use_tool` control_request and this event covers
   the `'deny'` short-circuit."

That second quote is the direct evidence for runner §15.4: in `dontAsk` the call takes the deny
short-circuit and emits `permission_denied` (`decision_reason_type: 'mode'`) instead of raising a
`can_use_tool` request — i.e. `canUseTool` is not consulted. The denial is also recorded
authoritatively in `result.permission_denials`.

### 1.3 DESIGN §6.2's permissiveness ladder

`plan < dontAsk < default < acceptEdits` — **confirmed** as an ordering of "what can happen to a call
that matches no rule":

- `plan` executes no mutating tool at all (strictly least permissive);
- `dontAsk` executes only what is pre-approved and silently denies the rest — no human can widen it
  mid-session, so it is below `default`;
- `default` denies nothing outright: a human is asked and may say yes, so its ceiling is strictly
  above `dontAsk`;
- `acceptEdits` is `default` plus automatic approval of file edits — strictly above it.

Taking the **minimum** on this ladder is therefore sound, and `dontAsk` is *not* the
"never prompt, auto-approve" reading that would have inverted it. The ladder needs one amendment for
the sixth member — see D1.

---

## 2. `systemPrompt` (DESIGN §5)

`sdk.d.ts:2096-2101`:

```ts
systemPrompt?: string | string[] | {
    type: 'preset';
    preset: 'claude_code';
    append?: string;
    excludeDynamicSections?: boolean;
};
```

| Item | Verdict | Note |
|---|---|---|
| `{ type: 'preset', preset: 'claude_code' }` | confirmed | Only `'claude_code'` is a valid preset. |
| `append` | confirmed | DESIGN §5's `append` mode compiles exactly as written. |
| `excludeDynamicSections` | **confirmed** (DESIGN guessed "SDK ≥ 0.2.98") | `:2049-2061` — strips working directory, auto-memory path **and git status**, re-injecting them as the first user message; "Has no effect when `systemPrompt` is a string (custom prompt)". The compiler must therefore not set it in `replace` mode. |
| `string` (full replacement) | confirmed | DESIGN §5's `replace` mode. |
| `string[]` + `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` | **new, DESIGN predates it** | `:2042-2046` — an array form marking the cacheable/static split explicitly. A second, finer-grained lever for the same prompt-cache goal as `excludeDynamicSections`; worth considering in M4 for `replace`-mode agents, which `excludeDynamicSections` cannot help. |

---

## 3. MCP server config (DESIGN §10)

`sdk.d.ts:1070`:

```ts
export declare type McpServerConfig =
  McpStdioServerConfig | McpSSEServerConfig | McpHttpServerConfig | McpSdkServerConfigWithInstance;
```

| Transport | Declaration | Verdict |
|---|---|---|
| stdio (`:1169`) | `{ type?: 'stdio'; command: string; args?: string[]; env?: Record<string,string>; timeout?: number; alwaysLoad?: boolean }` | confirmed — `type` is optional for stdio; roster emits it anyway. |
| sse (`:1152`) | `{ type: 'sse'; url: string; headers?: Record<string,string>; tools?: McpServerToolPolicy[]; timeout?; alwaysLoad? }` | confirmed |
| http (`:1037`) | `{ type: 'http'; url: string; headers?: …; tools?: …; timeout?; alwaysLoad? }` | confirmed |
| `'streamable-http'` | **absent** from every declaration | confirms DESIGN §10: the programmatic option accepts `"http"` only. |
| in-process server (`:1054-1065`) | `McpSdkServerConfigWithInstance = { type: 'sdk'; name: string; instance: McpServer }` | confirmed — DESIGN §13's `options.mcpServers.agentmanager` (orchestrator's per-launch instance) is representable. |

`Options.mcpServers?: Record<string, McpServerConfig>` (`:1734`) — name confirmed.

Not in DESIGN, worth having: `tools?: McpServerToolPolicy[]` (per-server tool policy), `timeout`, and
`alwaysLoad` (forces the server's tools into the prompt and blocks startup until connected). Server
statuses `'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled'` (`:1085`) match DESIGN §10's
list exactly.

**`env` replaces, never merges** — confirmed verbatim at `sdk.d.ts:1462-1468` for `Options.env`: "this
value REPLACES the subprocess environment entirely — it is not merged with `process.env`. Spread
`process.env` yourself if the subprocess still needs inherited variables like `PATH`". DESIGN §10 and
§13's `PATH` regression guard stand.

`${VAR}` expansion being unavailable in the programmatic `mcpServers` option (DESIGN §10) is **not
verifiable statically** — nothing in the declarations mentions interpolation either way. Roster
interpolates in its own code regardless, so the assumption is safe in the direction we depend on.

---

## 4. Plugin config (DESIGN §7.1)

`sdk.d.ts:4456-4469`:

```ts
export declare type SdkPluginConfig = {
    type: 'local';
    path: string;               // absolute or relative to the plugin directory
    skipMcpDiscovery?: boolean;
};
```

`Options.plugins?: SdkPluginConfig[]` (`:1797`) — name confirmed; "Currently only local plugins are
supported", matching DESIGN's `plugins: [{ type: 'local', path: agentDir }]`.

**`skipMcpDiscovery` is new to DESIGN** and is a security-relevant default worth taking: "the engine
loads skills/hooks/agents/commands from this plugin but does NOT read its `.mcp.json` or manifest
`mcpServers`". Roster owns MCP wiring through `integrations` (§10); with `skipMcpDiscovery: true` an
agent folder that acquires a stray `.mcp.json` (hand-edit, `git pull` of a shared roster) cannot mount
a server the compiler never approved. Recommended for M5.

"A nonexistent plugin path is silently skipped" and "`~` is not expanded" (DESIGN §7.1) are **not
verifiable statically**; the M5 init-message assertion DESIGN already requires is the right guard
either way.

---

## 5. Option-name inventory

Every name DESIGN §13's mapping table depends on, as declared on `Options` (`sdk.d.ts:1348`+).

| Option | Line | Declared type | Verdict |
|---|---|---|---|
| `skills` | 2012 | `string[] \| 'all'` | confirmed — `[]` expresses `skills.mode: "none"`. **Omitting is not "off"** (`:1995`: "the CLI's own defaults still apply"), so the compiler must always emit the key. Also `:1991-1993`: setting it "turns skills on; you do not need to add `'Skill'` to `allowedTools` yourself" — DESIGN §7.2's extra `Skill` allow entry is redundant but harmless. |
| `plugins` | 1797 | `SdkPluginConfig[]` | confirmed |
| `settingSources` | 1989 | `SettingSource[]`, `SettingSource = 'user' \| 'project' \| 'local'` (`:7520`) | confirmed. **When omitted, all sources load** (`:1985`) — so roster must emit the key on every launch, never rely on a default. `[]` = SDK isolation mode; `'project'` is required to load `CLAUDE.md`. |
| `fallbackModel` | 1501 | `string` | confirmed, with a **differs**: it is a *comma-separated list* tried in order, not an array (`Settings.fallbackModel` is `string[]`; the option is not). `model.fallback` maps cleanly as a single value. |
| `maxBudgetUsd` | 1709 | `number` | confirmed — "the query will stop if this budget is exceeded, returning an `error_max_budget_usd` result". |
| `maxTurns` | 1704 | `number` | confirmed |
| `model` | 1739 | `string` | confirmed (aliases or full ids). |
| `allowedTools` | 1401 | `string[]` | confirmed as an **auto-approve list**: "List of tool names that are auto-allowed without prompting… To restrict which tools are available, use the `tools` option instead." DESIGN §6.1 stands. |
| `disallowedTools` | 1421 | `string[]` | confirmed: "removed from the model's context and cannot be used, even if they would otherwise be allowed". |
| `tools` | 1457 | `string[] \| { type: 'preset'; preset: 'claude_code' }` | **new — DESIGN predates it.** This *is* a restriction list (`[]` disables all built-in tools). See D2. |
| `canUseTool` | 1406 | `CanUseTool` | confirmed; `PermissionResult` is `{behavior:'allow',…} \| {behavior:'deny', message, interrupt?}` (`:2193`). |
| `settings` | 1954 | `string \| Settings`; `Settings.permissions = { allow?, deny?, ask?, defaultMode?, disableBypassPermissionsMode?, additionalDirectories? }` (`:5327-5352`) | confirmed — DESIGN §6.3's inline-settings route for `ask` rules exists. |
| `managedSettings` | 1978 | `Settings` | **new — see D3.** A policy tier the parent supplies, "filtered restrictive-only: permissive arrays (`permissions.allow`, `additionalDirectories`, …) that would widen an existing admin lock are silently dropped". |
| `mcpServers` | 1734 | `Record<string, McpServerConfig>` | confirmed |
| `cwd` | 1415 | `string` | confirmed |
| `additionalDirectories` | 1358 | `string[]` | confirmed |
| `env` | ~1462 | `Record<string,string>` (replaces) | confirmed |
| `agents` | 1393 | `Record<string, AgentDefinition>` | present but unused by roster (D4 forbids subagents). |
| `permissionMode` | 1765 | `PermissionMode` | confirmed |
| `allowDangerouslySkipPermissions` | 1777 | `boolean` | confirmed — `bypassPermissions` additionally requires this flag, a second lock on a mode roster cannot express. |

### `effort` — top level or subagent-only? (DESIGN §8)

**Both. Top-level `effort` exists**, so DESIGN §8's "passed through where the SDK exposes it
(subagent-level today; top-level where available) and otherwise dropped with a diagnostic" resolves to
the pass-through branch on this version:

- `Options.effort?: EffortLevel` (`sdk.d.ts:1690`), `EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max'` (`:555`) — exactly roster's `model.effort` enum;
- `AgentDefinition.effort?: ('low'|'medium'|'high'|'xhigh'|'max') | number` (`:87`) — the subagent form additionally accepts an integer.

Minor differs: the subagent form is wider (integers) than the top-level one. Roster's schema follows
the top-level enum. The "drop with a diagnostic" path in DESIGN §8 is dead code against 0.3.233 but
should stay as the guard for a future SDK that removes the option.

---

## 6. Design contradictions

Raised as design changes, per M0's acceptance. **None of these were coded around.**

### D1 — `PermissionMode` has a sixth member, `auto`, that DESIGN does not account for

DESIGN §6.1 makes `bypassPermissions` "not selectable from the roster schema at all" and §6.2's ladder
enumerates four modes. The pinned SDK has six: the extra one is `'auto'` — "use a model classifier to
approve/deny permission prompts" — which decides without a human and has no position on a ladder
ordered by *human-gated* permissiveness (it is simultaneously "never prompts" and "may approve
anything the classifier likes"). It is also grouped with the escalating modes by the SDK itself
(`filterEscalatingDefaultMode`, `:656-659`, treats `bypassPermissions`/`auto`/`acceptEdits` alike).

**M1 has made `auto` unrepresentable alongside `bypassPermissions`** — the schema's mode enum is
`plan | dontAsk | default | acceptEdits` and any other value, `auto` included, is a validation error
naming the path. DESIGN §6 and §16 ("Deferred: `bypassPermissions` anywhere in the schema") should be
amended to say the same about `auto`, so the exclusion is a decision on the record rather than an
implementation accident.

### D2 — `Options.tools` exists: restriction no longer has to be expressed only as `deny`

DESIGN §6.1's three "facts a naive design gets wrong" are all still true, but they were written when
the *only* restriction mechanism was `disallowedTools`. 0.3.233 declares `tools?: string[] | { type:
'preset', preset: 'claude_code' }` — the base set of built-in tools, with `[]` meaning "disable all
built-in tools" — and the `allowedTools` doc now explicitly redirects there ("To restrict which tools
are available, use the `tools` option instead").

This does not invalidate §6.1's rule (deny still wins in every mode and still removes tool definitions
by bare name), but "restriction is expressed with `deny`, never by omission from `allow`" is now a
choice rather than the only option, and an allowlist-shaped `tools` would express a roster baseline
more directly than an enumerated deny catalogue. **M4 should not adopt it without a design decision**,
because a `tools` allowlist and the §6.2 deny-union have different composition algebras. Flagged, not
acted on. (DESIGN §12.2's inert drafting call is a concrete casualty — see D5.)

### D3 — `managedSettings` is the natural home for the compiled deny set

`Options.managedSettings?: Settings` (`:1956-1969`) is a policy tier supplied by the spawning parent
and filtered **restrictive-only** — permissive arrays that would widen a lock are dropped by the
engine itself. Roster's compiler currently plans to emit rules through `settings` (§6.3), which is the
"flag settings" tier: highest among *user-controlled* settings, but same-tier as things the target
repo can also influence.

Since `settingSources: ["project"]` deliberately loads the target repo's `.claude/settings.json`
(§7.3), a repo-committed `permissions.allow` is loaded into the session **outside** roster's
composition — the compiler never sees it, so §6.2's "allow is an intersection" is a guarantee about
roster's own three layers, not about the running session. (The SDK does defend the worst case: an
escalating `defaultMode` from a repo-committed tier is dropped, `:656-659`. Allow *rules* are not
described as filtered.) Putting the compiled `deny` — and at minimum `policy.globalDeny` and the
`write: false` mutating-tool floor — into `managedSettings` closes that gap in the tier the engine
treats as policy. **This is a §6/§7.3 design question, not an M1 change.**

### D4 — `Settings.permissions.disableBypassPermissionsMode: 'disable'` exists

A cheap belt-and-braces for §6.1's "`bypassPermissions` is unreachable": the schema cannot express it
and, with this flag set on every launch, neither can a resumed session, a loaded settings file, or a
`setPermissionMode()` call (`ExitReason` even carries a `'bypass_permissions_disabled'` member).
Recommended for M4's compiler; it makes an invariant currently held by roster's schema hold in the
engine too.

### D5 — DESIGN §12.2's inert drafting call does not do what it says

§12.2 configures the draft-from-description query with `allowedTools: []`. Per `sdk.d.ts:1395-1401`,
`allowedTools` is an auto-approve list, **not** a restriction list: `[]` means "auto-approve nothing",
leaving every built-in tool defined and reachable through `permissionMode`/`canUseTool`. Combined with
`permissionMode: 'dontAsk'` the call is *denied* rather than *inert* — the model can still emit tool
calls, burn turns on rejected ones, and the session is not actually tool-free.

The correct inert configuration on this SDK is **`tools: []`** ("Disable all built-in tools"),
optionally keeping `allowedTools: []`, plus the `mcpServers`/`settingSources`/`skills` emptiness §12.2
already specifies. **DESIGN §12.2 should be corrected before M8 implements it.**

---

## 7. Assumptions that remain unverified (static reading cannot settle them)

Carried forward from SDK documentation, listed so they are not mistaken for verified facts. Each has
a runtime guard already required by IMPLEMENTATION.md.

| DESIGN claim | Why unverified | Existing guard |
|---|---|---|
| §6.1 evaluation order: hooks → deny → ask → mode → allow → `canUseTool` | Not stated in any declaration; the engine is bytecode | M4's composition table asserts *outcomes*, not order |
| §5 "omitting `systemPrompt` gives a minimal tool-calling prompt, not the Claude Code one" | No default documented on the option | Roster always sets `systemPrompt` explicitly |
| §7.1 nonexistent plugin path is silently skipped; `~` not expanded | Loader behaviour, not typed | M5 init-message assertion; absolute paths only |
| §10 `acceptEdits` does not auto-approve MCP tools | Declarations say only "auto-accept file edit operations" | M6 validator warning when an integration has no matching `mcp__<server>__*` allow rule |
| §10 `${VAR}` not expanded in programmatic `mcpServers` | Not mentioned either way | Roster interpolates in its own code |

---

## 8. Implementation notes for M4 (no design impact)

- **Name collision**: the SDK exports its own `AgentDefinition` type (`sdk.d.ts:38`) — a *subagent*
  definition, unrelated to roster's `AgentDefinition`. The option compiler is the one file that will
  see both; import the SDK's under an alias (`import type { AgentDefinition as SdkSubagentDefinition }`).
- M1 has **no import of this package** — the dependency is pinned so M4 can compile against it, and
  the roster schema module deliberately does not touch it.
- **Runtime dependencies** the pin brings in: `zod ^4.0.0` (deduped with foundation's `zod@4.4.3` —
  an SDK bump that moved to zod 5 would move the whole codebase, so it is worth checking on every
  version bump), `@modelcontextprotocol/sdk ^1.29.0`, `@anthropic-ai/sdk >=0.93.0`, plus one
  optional per-platform binary package.
- Native binary size: the platform package is ~320 MB extracted (`claude.exe`), and `npm install`
  pulls one platform package per host. Worth knowing before the installer is sized (foundation §4).
- `npm install` in this repo needs `--ignore-scripts` on Node 25: npm runs `node-gyp rebuild` for
  `better-sqlite3` (it has a `binding.gyp` and no install script) even though the package ships
  prebuilt binaries. Unrelated to the SDK, recorded because it blocks a clean worktree install.
