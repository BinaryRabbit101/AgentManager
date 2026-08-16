# Orchestrator M0 — Claude Agent SDK surface verification

Static verification of every SDK behaviour [DESIGN.md](DESIGN.md) depends on, against the exact
version pinned in `package.json`. Companion to [roster/SDK-NOTES.md](../roster/SDK-NOTES.md) (the
option-compilation surface) and [runner/SDK-NOTES.md](../runner/SDK-NOTES.md) (streaming input, the
message stream, `canUseTool`, usage, resume). **Nothing those two settled is re-derived here** —
`dontAsk`, `allowedTools` shadowing `canUseTool` (runner C2), the usage/`modelUsage` reset (runner
C1), plan-window visibility (runner C3) and the `AskUserQuestion` answer shapes are cited, not
re-checked. This document goes deep on the surface only orchestrator touches: `createSdkMcpServer` /
`tool()`, in-process MCP server lifecycle and naming, the tool-call timeout that bounds §4.4's hold,
MCP permission-rule syntax, scope-rule enforcement, and what the SDK does and does not offer for
coordination between sessions.

| | |
|---|---|
| Package | `@anthropic-ai/claude-agent-sdk` |
| Version pinned (exact, no range) | **0.3.233** — verified still exact in `package.json` (`"@anthropic-ai/claude-agent-sdk": "0.3.233"`); `node_modules` resolves to 0.3.233. Not changed by this milestone. |
| Bundled CLI (`manifest.json`) | `2.1.233`, commit `f8d5756`, built 2026-08-14 |
| Bundled MCP SDK | `@modelcontextprotocol/sdk` 1.30.0 (deduped); `zod` 4.4.3 — `AnyZodRawShape` accepts Zod 3 **and** Zod 4 raw shapes (`sdk.d.ts:122`, `:4237`) |
| Verified against | `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` (8043 lines), `sdk-tools.d.ts`, **`sdk.mjs` (the shipped, readable Node wrapper — 0.3.233 bundles the MCP SDK's `Server`/`Protocol` source into it, so the tool-dispatch path is readable too)**, `manifest.json` |
| Method | **Static, plus an offline protocol run.** No *session* was started — this environment has no `CLAUDE_CODE_OAUTH_TOKEN` and no interactive auth is possible. But `createSdkMcpServer` returns a real in-process MCP server that needs neither, so the server was built and driven over a loopback transport (`initialize` → `tools/list` → `tools/call`). Findings from that run are marked **(observed offline)** and are facts, not readings. |
| Date | 2026-08-16 |

**What can and cannot be read.** The *engine* is a per-platform Bun-compiled executable
(`claude.exe`, ~320 MB) whose JavaScript is bytecode: tool-name construction, prompt assembly, tool
search / deferred loading, permission evaluation and the MCP tool-call timeout default are **not**
readable. The **SDK wrapper `sdk.mjs` is ordinary readable JavaScript** and — a step beyond what the
runner spike needed — it also contains the bundled `@modelcontextprotocol/sdk` `Server` and
`Protocol` classes, so `createSdkMcpServer`, `tool()`, transport connection, request dispatch, input
validation and error wrapping are all readable source. Findings from it are marked **(wrapper
source)**; findings from the loopback run are marked **(observed offline)**. Findings that would
require the engine are marked **unverified** and appear in
[§10 Live verification pending](#10-live-verification-pending).

**Verdict vocabulary** (same as the sibling spikes)

| Verdict | Meaning |
|---|---|
| **confirmed** | The declaration or wrapper source says exactly what DESIGN says. |
| **differs** | Present, but not with the shape/semantics DESIGN assumes. Design impact stated. |
| **absent** | Not in this version at all. |
| **unverified** | Cannot be settled from declarations or wrapper source; needs a live session. Listed in §10. |

---

## 1. The `[A]` assumptions from DESIGN §0

M0's checklist item 4 asks for exactly these five. All five, with the observed answer.

| # | Assumption | Verdict | Evidence |
|---|---|---|---|
| **[A1]** | `createSdkMcpServer({name, version, tools})` returns an in-process server object accepted as a value in `options.mcpServers`, and tools surface as `mcp__<mcpServers key>__<toolName>`. | **confirmed** (naming: by documentation + wrapper; final construction is engine-side, **L1**) | `export declare function createSdkMcpServer(_options: CreateSdkMcpServerOptions): McpSdkServerConfigWithInstance` (`sdk.d.ts:484`); the return value is literally `{ type: 'sdk', name, instance }` (wrapper source). `McpSdkServerConfigWithInstance` is a member of `McpServerConfig` (`:1063-1070`) and `Options.mcpServers?: Record<string, McpServerConfig>` (`:1734`) — documented "**Keys are server names**" (`:1722`). The wire format is documented at `:3763`: "Fully-qualified MCP tool name, e.g. `mcp__server__tool_name`… server names are normalized: non-`[a-zA-Z0-9_-]` becomes `_`". `agentmanager` needs no normalisation. **Which** name wins is settled in the wrapper: `setup()` splits `mcpServers` by type — non-`sdk` configs go to the child argv, `sdk` ones into a `Map` keyed by the **record key** — and `initialize()` sends `sdkMcpServers: Array.from(sdkMcpTransports.keys())`, i.e. the **record key**, to the CLI. The `createSdkMcpServer({name})` value only reaches the CLI as MCP `serverInfo.name`. DESIGN's belt-and-braces (set both to `agentmanager`) is therefore right and costs nothing. |
| **[A2]** | `tool(name, description, zodShape, handler)`'s handler receives `(args, extra)` and `extra` carries **no** identity of the calling session. | **confirmed — observed offline** | `export declare function tool<Schema extends AnyZodRawShape>(_name, _description, _inputSchema: Schema, _handler: (args: InferShape<Schema>, extra: unknown) => Promise<CallToolResult>, _extras?: {annotations?, searchHint?, alwaysLoad?})` (`sdk.d.ts:7834-7838`) — the positional signature DESIGN assumes, plus a fifth optional argument DESIGN does not know about (see C3). The handler is passed straight to `McpServer.registerTool(name, {…}, handler)` and invoked as `handler(validatedArgs, extra)` (wrapper source, `executeToolHandler`). **(observed offline)** a real `tools/call` reaches the handler with the validated args and an `extra` whose keys are exactly: `signal` (a live `AbortSignal`), `sessionId`, `_meta`, `sendNotification`, `sendRequest`, `authInfo`, `requestId`, `requestInfo`, `taskId`, `taskStore`, `taskRequestedTtl`, `closeSSEStream`, `closeStandaloneSSEStream`. `sessionId`, `_meta`, `authInfo` and `requestInfo` are all **`undefined`** on this transport — `sessionId` is `transport.sessionId` and the SDK's in-process transport class declares none. `requestId` is the JSON-RPC id (a number). **Nothing in `extra` names a Claude session, agent or assignment**, so §4.2's per-launch closure is not merely the cleanest design — it is the *only* source of identity. Two fields are worth using: `extra.signal` (G5) and `extra.requestId` (idempotency). |
| **[A3]** | An MCP tool handler may stay pending for minutes without the CLI cancelling the call. | **confirmed with a named bound — observed offline at the server layer; verify the engine default live (L3)** | **(observed offline)** a `tools/call` whose handler never settles produces no response and no cancellation from the MCP server layer. The wrapper imposes **no** timeout either: `handleMcpControlRequest` parks a promise in `pendingMcpResponses` and resolves it only when the server writes a response back; the MCP `Protocol` layer applies a timeout only to requests **it** initiates, not to inbound ones (wrapper source). The bound is engine-side and documented on the function itself: "**Tool calls are bounded by the MCP tool-call timeout — the `MCP_TOOL_TIMEOUT` env var (ms), effectively unbounded by default**" (`sdk.d.ts:481-483`). `MCP_TOOL_TIMEOUT` is declared as an int with `min: 1` and no wrapper-side default. **differs in one respect DESIGN should record**: the per-server `timeout` escape hatch exists on stdio/sse/http configs (`:1032`, `:1043`, `:1158`, `:1175` — "Hard wall-clock limit per call; progress notifications do not extend it") but **`McpSdkServerConfigWithInstance` has no `timeout` field** (`:1054-1065`). So the only lever for an in-process server is the process-wide env var — see **G1**. |
| **[A4]** | A tool result flagged as an error is delivered to the model as readable text. | **confirmed at the protocol layer, observed offline; model delivery is engine-side (L4)** | `CallToolResult` (from `@modelcontextprotocol/sdk`) is `{ content: ContentBlock[]; structuredContent?; isError?: boolean; _meta? }`. **(observed offline)** every failure mode inside `tools/call` lands on the *same* shape: a handler returning `{content:[…], isError:true}` passes through; a handler that **throws** is caught and converted to `{content:[{type:'text',text:message}], isError:true}`; a zod validation failure becomes `isError:true` with `Input validation error: Invalid arguments for tool <name>: …`; an unknown tool name becomes `isError:true` with `Tool <name> not found`. The CallTool handler's `catch` re-raises exactly one code (`UrlElicitationRequired`), so **no shape a tool can produce escalates to a JSON-RPC error the model never sees** (wrapper source + observed). Output validation is skipped for `isError` results (`if (result.isError) return`), so a structured refusal cannot fail a schema check. §4.2's named refusals are therefore safe either way — returned or thrown — though returning them keeps the message under our control. |
| **[A5]** | `options.mcpServers` accepts a record mixing in-process instances with roster's stdio/http configs. | **confirmed** | `McpServerConfig` is the four-member union including `McpSdkServerConfigWithInstance` (`:1070`), and the record is heterogeneous by type. (wrapper source) `setup()` partitions it explicitly: `for (const [key, cfg] of Object.entries(mcpServers)) if (cfg.type === 'sdk' && cfg.instance) sdkMap.set(key, cfg.instance); else childConfigs[key] = cfg;` — the child gets the process-based servers, the parent keeps the instances, and both sets are announced. `Query.setMcpServers()` (`:2608-2629`) does the same at runtime and is documented "Supports both process-based servers (stdio, sse, http) and SDK servers (in-process)". One caveat for roster: `strictMcpConfig` (`:2032-2038`) says "only use MCP servers passed via the `mcpServers` option" but maps to the CLI `--strict-mcp-config` flag, and sdk-type servers never appear in that flag's payload — **G4**. |

**Net: no `[A]` assumption is refuted.** [A1], [A2], [A4] and [A5] are confirmed; [A3] is confirmed
with a named, configurable bound rather than the "hard timeout" DESIGN expected to discover. None of
the five changes the design's shape. Three *other* findings do, and they are §8's contradictions.

---

## 2. `createSdkMcpServer` and `tool()`, in full

### 2.1 The declarations

```ts
export declare function createSdkMcpServer(_options: CreateSdkMcpServerOptions): McpSdkServerConfigWithInstance;   // :484

declare type CreateSdkMcpServerOptions = {                                                                        // :486-505
    name: string;
    version?: string;
    instructions?: string;      // "surfaced to the model as an MCP instructions block"
    tools?: Array<SdkMcpToolDefinition<any>>;
    alwaysLoad?: boolean;       // see C3
};

export declare type SdkMcpToolDefinition<Schema extends AnyZodRawShape = AnyZodRawShape> = {                       // :4239-4246
    name: string; description: string; inputSchema: Schema;
    annotations?: ToolAnnotations; _meta?: Record<string, unknown>;
    handler: (args: InferShape<Schema>, extra: unknown) => Promise<CallToolResult>;
};

export declare type McpSdkServerConfigWithInstance = { type: 'sdk'; name: string; instance: McpServer };           // :1054-1065
```

Everything DESIGN §4.1/§4.3 needs is there. Three things it does not know about:

- **`instructions`** — server-level prose "returned from `initialize` and surfaced to the model as an
  MCP instructions block" (`:489-494`). This is a prompt-cheap place to state the coordination
  contract once ("these tools act on the assignment this session was launched under; you cannot name
  another") instead of repeating it in every tool description and in §3.2's prompt template.
  Recommended for M4; no design change.
- **`annotations?: ToolAnnotations`** on each tool — `readOnly` / `destructive` / `openWorld` hints
  that surface in `McpServerStatus.tools[].annotations` (`:1108-1116`). `list_roster` and
  `read_mailbox` are read-only; `create_assignment` is not. Cosmetic, but it is what a tool listing
  in the UI would read.
- **`_extras.searchHint`** on `tool()` — a hint used when the tool sits behind tool search (C3).

### 2.2 What the wrapper actually builds

(wrapper source) `createSdkMcpServer` constructs a bundled `McpServer` with
`{ capabilities: { tools: options.tools ? {} : undefined }, instructions }`, iterates `tools` calling
`server.registerTool(name, { description, inputSchema, annotations, _meta }, handler)`, and returns
`{ type: 'sdk', name, instance: server }`. Two consequences:

1. **The zod raw shape is registered directly** — no JSON-Schema conversion happens at construction;
   it happens on `tools/list`, via a zod→JSON-Schema conversion with
   `{ strictUnions: true, pipeStrategy: 'input' }` (wrapper source). So a shape zod can express but
   JSON Schema cannot fails at *listing* time, not at build time. Keep §4.3's schemas to plain
   objects, enums, arrays and optionals — which they are.
2. **`tool()` accepts no `outputSchema`.** `SdkMcpToolDefinition` has no such field and `_extras` is
   `{annotations?, searchHint?, alwaysLoad?}` only. See **G3**.

**(observed offline)** what the server actually answers, for a server built as
`createSdkMcpServer({ name: 'agentmanager', instructions: '…', alwaysLoad: true, tools: [report_status] })`:

```jsonc
// initialize →
{ "protocolVersion": "2025-06-18",
  "capabilities": { "tools": { "listChanged": true } },
  "serverInfo": { "name": "agentmanager", "version": "1.0.0" },   // version defaults to "1.0.0"
  "instructions": "…" }                                           // surfaced to the model, G9
// tools/list →
{ "tools": [ { "name": "report_status", "description": "…",
               "inputSchema": { "$schema": "http://json-schema.org/draft-07/schema#",
                                "type": "object", "properties": { "note": { "type": "string" } } },
               "execution": { "taskSupport": "forbidden" },
               "_meta": { "anthropic/alwaysLoad": true } } ] }     // C3's flag, per tool
```

So `createSdkMcpServer({name})` is what reaches the model as MCP `serverInfo.name`, the record key is
what reaches the CLI as the server identifier (§1/[A1]), `instructions` is real, and C3's
`alwaysLoad` is verifiably stamped on every tool.

### 2.3 Request dispatch and error surfaces

(wrapper source) The bundled `Server._onrequest` builds `extra` (§1/[A2]) and calls the handler
through `executeToolHandler` → `handler(args, extra)`. Around it:

| Situation | What the model gets |
|---|---|
| Handler returns `{content, isError:false\|undefined}` | Normal tool result. Output validation runs only if an `outputSchema` was registered — it never is here. |
| Handler returns `{content:[{type:'text',…}], isError:true}` | Error-flagged tool result — DESIGN §4.2's structured refusal. Output validation is skipped. |
| Handler **throws** | Caught and converted to `{content:[{type:'text',text:message}], isError:true}`. A bug in a tool degrades to a readable error rather than killing the turn. |
| Args fail the zod shape | Same shape: `isError:true`, text `Input validation error: Invalid arguments for tool <name>: …`. |
| Tool name unknown or disabled | Same shape: `isError:true`, text `Tool <name> not found`. |
| Handler never settles | Nothing until `MCP_TOOL_TIMEOUT` (§1/[A3], G1) — confirmed pending indefinitely at the server layer (observed offline). |

All five settled rows were **observed offline**, not merely read. The one code the `catch` re-raises
is `UrlElicitationRequired`, which orchestrator's tools cannot produce.

`extra.signal` is aborted when the peer sends `notifications/cancelled` for that request (wrapper
source, `_requestHandlerAbortControllers`). Whether the engine sends one on timeout is **unverified**
(L3) — G5 says the handler must await on it regardless.

---

## 3. Mounting and lifecycle

### 3.1 One instance per launch is mandatory, not merely tidy

DESIGN §4.1 builds a `createSdkMcpServer` instance per launch so it can close over the
`LaunchIdentity`. The SDK makes that a hard requirement independently:

- (wrapper source) `Protocol.connect()` opens with
  `if (this._transport) throw Error("Already connected to a transport. Call close() before connecting
  to a new transport, or use a separate Protocol instance per connection.")`.
- `Query.connectSdkMcpServer(key, instance)` calls `instance.connect(transport)` and **swallows the
  rejection into a log line** (`.catch(err => … '[Query.connectSdkMcpServer] Failed to connect MCP
  server …', {level:'error'})`) — it does not reject the query.
- `initialize()` reads `Array.from(sdkMcpTransports.keys())` synchronously in the `Query`
  constructor, **before** that async catch can run, so the CLI is told the server exists either way.

So a memoised instance reused across two concurrent sessions produces a session that *believes* it
has the `agentmanager` server and whose tools never answer — a silent failure, not a crash. The throw
is **observed offline** (a second `connect()` on the same instance rejects with that exact message);
that the wrapper swallows it into a working-looking session is read from the wrapper and is L15. See
**G2**.

### 3.2 Lifecycle within a session

| Moment | Behaviour | Verdict |
|---|---|---|
| Launch | `query()` partitions `mcpServers`; sdk instances are connected in the `Query` constructor before `initialize()` | **confirmed** (wrapper source) |
| Transport | In-process; every JSON-RPC frame rides the same stdio control channel as `canUseTool` and hooks, as a `control_request` of subtype `mcp_message` carrying `server_name` | **confirmed** (wrapper source; `SDKControlMcpMessageRequest` is in the control-request union, `:3983`) |
| Health | `Query.mcpServerStatus(): Promise<McpServerStatus[]>` (`:2502`) — `status`, `serverInfo`, `error`, `scope`, and **`tools[]` with names and annotations** (`:1077-1118`) | **confirmed** — the cheapest live assertion that the six tools mounted; runner's `session.diagnostic` already consumes this call |
| Mid-session change | `Query.setMcpServers(record)` (`:2629`) replaces the dynamic set and returns `{added, removed, errors}` | **confirmed, and deliberately unused** — DESIGN mounts once per launch, which is right: the identity a tool closes over is fixed at launch |
| Teardown | `Query.close()` "cleans up all resources including pending requests, **MCP transports**, and the CLI subprocess" (`:2655-2663`); `disconnectSdkMcpServer` closes the transport and drops the instance | **confirmed** — nothing for orchestrator to do on stop beyond what runner already does |
| Bidirectional lane | `hasBidirectionalNeeds()` is true when any sdk MCP server is present (wrapper source) | **confirmed** — mounting the toolset alone forces the streaming-input lane runner already uses |

### 3.3 Who mounts it (DESIGN §4.1, R1)

Nothing in the SDK constrains *which* element writes `options.mcpServers.agentmanager`; the value is
a plain record entry. R1's resolution (roster's `compileSession` mounts it, runner's option whitelist
stays closed) is unaffected by anything in this version. **confirmed as representable**, and roster
SDK-NOTES §3 already recorded the same line.

---

## 4. Permission rules over the six tools

Orchestrator does not compile rules — roster does (§4.1) — but the *shape* roster must emit is what
DESIGN's overseer/worker split rests on, and it is checkable here. (wrapper source) the rule grammar
is validated by a readable function:

| Rule form | Accepted? | Note |
|---|---|---|
| `mcp__agentmanager` | ✔ | Server-level: every tool from the server. |
| `mcp__agentmanager__*` | ✔ **including in `allow`** | The validator's wildcard ban explicitly exempts this: "globs are permitted only in the tool position after a literal `mcp__<server>__` prefix. Deny and ask rules accept wildcards anywhere." |
| `mcp__agentmanager__report_status` | ✔ | Exact per-tool grants — so R1b's four-tool worker grant is expressible in rules as well as by registration. |
| `mcp__agentmanager__get_*` | ✔ | Prefix globs in the tool position. |
| `mcp__agentmanager__send_to_agent(...)` | ✖ | "MCP rules do not support patterns in parentheses" — a hard validation error. This is the mechanical reason §4.2's "permission rules match tool *names*; they cannot express *only your own assignment*" is true, not merely inconvenient. **confirmed.** |
| `mcp__*` in `allow` | ✖ | A wildcard in the *server* position is rejected in allow rules. |

Two consequences worth writing down:

1. **DESIGN §4.2's central claim is now evidenced from the SDK itself**, not argued. Worker scoping
   cannot be a rule; it has to be a check inside the handler.
2. **A worker's server must register only its four tools.** A tool that is *registered* but not
   *allowed* does not vanish — it falls through to `canUseTool`, i.e. to runner's bridge, i.e. to a
   **user-facing question card** asking whether a worker may call `list_roster`. Registration is the
   control; the rules are the second lock. (Live confirmation is L7/L8.)

Also relevant, from runner §5.3 and not re-derived: a **bare** `allowedTools` entry auto-approves
before `canUseTool` is consulted, and `mcp__agentmanager__*` counts as bare (the wrapper's shadow
check is the syntactic test `!entry.includes('(')`). That is the *desired* behaviour here — a
coordination call must not raise a permission card — but it means every AgentManager session's
`CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` warning will name the six tools. Runner's G6 filter already
covers it.

---

## 5. Scope rules (DESIGN §2.5) — the file-permission finding

DESIGN §2.5 emits `Edit(./docs/**)`, `Write(./docs/**)`, `NotebookEdit(./docs/**)` as
`AssignmentContext.scopeRules`. The SDK's own rule validator (wrapper source) says two of the three
are inert:

```js
const canonical = toolName === 'Write' || toolName === 'NotebookEdit' || toolName === 'MultiEdit' ? 'Edit'
                : toolName === 'Glob' ? 'Read' : undefined;
if (canonical !== undefined && !ruleContent.includes(':*'))
  return { valid: true, warning:
    `${rule} is not matched by file permission checks — only ${canonical}(path) rules are. ` +
    `Use ${canonical}(${ruleContent}) instead (${canonical} rules cover all file-editing tools).` };
```

`Edit`, `Write` and `NotebookEdit` are all in the SDK's `filePatternTools` list, so all three *parse*
and all three are accepted (`valid: true`). They are simply not consulted: **one `Edit(path)` rule
covers every file-editing tool**, and `Read(path)` likewise covers every file-reading tool. See
**C1**.

Two adjacent facts from the same validator, both relevant to §2.5:

- A rule whose content is exactly `*` (or empty) **collapses to the bare tool name** — `Edit(*)`
  parses to `Edit`. Under runner §5.3 a bare entry in `allowedTools` auto-approves without reaching
  `canUseTool`. A whole-project scope must therefore emit **no** scope rule, never `Edit(*)`.
- Tool names are canonicalised through an alias table before matching, and it includes
  **`Task → Agent`** (wrapper source). D4's ban on the SDK subagent path is a rule on `Agent`; a rule
  written as `Task` still lands, but the canonical name is `Agent`. **G8.**

---

## 6. What orchestrator inherits (cross-references, not re-verified)

| Claim DESIGN leans on | Where it was settled | Status for orchestrator |
|---|---|---|
| `dontAsk` never prompts and auto-denies | roster §1.2 | Consumed unchanged. |
| A bare `allowedTools` entry shadows `canUseTool` | runner §5.3, C2 | Consumed — and it has an orchestrator-side consequence, **C2** below. |
| `canUseTool` may stay pending indefinitely; returning `null` wedges the call | runner §5.2, G5 | Consumed. §4.4's hold is a policy on top of an unbounded primitive, exactly as runner's park is. |
| `AskUserQuestion` input carries `answers` keyed by question text; multi-select is a **comma-separated string**, not an array | runner §5.4 | Consumed. §6.1's `question` kind raised through runner's bridge is unaffected; `request_user_decision` has its own shape and is unaffected. |
| `modelUsage` / `total_cost_usd` are cumulative per `query()` call and **reset on resume** | runner C1 | Consumed. §7.1 already delegates all budget arithmetic to runner; §3.2's `continueFrom` (a new `query()` per turn) is exactly the boundary runner's C1 fix must handle, so the per-assignment token budget is the figure that stays correct across a pattern's six sessions. Worth stating in §7.1 that this is *why* the assignment budget is the honest one. |
| Plan-window utilization exists but is experimental | runner C3 | Not used by orchestrator. |
| `env` **replaces** the child environment entirely | roster §3, runner §9.1 | Load-bearing for **G1**: `MCP_TOOL_TIMEOUT` can only reach the child through roster's `options.env`. |
| Session JSONL location; `getTranscriptTail` | runner §8, R3 | §3.2's third output channel is a runner call, not an SDK call. Unaffected. |
| `steer()` could push into a live session | runner §4.3 | §5.1 declines it on accounting grounds and nothing here changes that. `SDKUserMessage.shouldQuery: false` ("appended to the transcript **without triggering an assistant turn**", runner §2.3) is the primitive that would eventually make §18's deferred item tractable, and is worth naming there. |

---

## 7. Coordination between sessions — what the SDK ships, and why the design still builds its own

DESIGN §5 builds mailboxes on foundation's `messages` table and asserts (§5.1) that "agents are not
processes, they are turns" and that **nothing is pushed into a live session**. That is a statement
about orchestrator's transport. This build of the CLI has a *separate* peer/teammate surface worth
recording, because it is the one place the assertion could be quietly falsified by settings
orchestrator does not own:

| Surface | Declaration | Relevance |
|---|---|---|
| `Settings.crossSessionInbound?: 'accept' \| 'hold' \| 'refuse'` | `:7487-7489` — "Inbound cross-session peer messages (**SendMessage from your other sessions**): 'accept' delivers them, 'hold' parks them…, 'refuse' opts this session out. An explicit value always wins. **Unset (mode parity): a message auto-delivers** when the sending session's permission-mode class matches yours…" | A session can receive messages from another session, mid-turn, with no orchestrator involvement. Roster loads `settingSources: ['project','user']`, so a user- or repo-level setting can reach it. **G6.** |
| `Settings.teammateMode?: 'auto'\|'tmux'\|'iterm2'\|'in-process'`, `isolatePeerMachines?`, `remoteControlAtStartup?` | `:7471-7481` | The CLI can spawn and address peer sessions. Not reachable through `Options`, but reachable through settings. |
| Tool aliases `ListPeers → ListAgents`, `Brief → SendUserMessage` (wrapper source) | — | Peer-messaging tool names the rule engine already knows about. They are **absent from `sdk-tools.d.ts`'s `ToolInputSchemas`** union, which suggests they are not offered in the SDK lane — **unverified** (L9). |
| `TeammateIdle` / `TaskCreated` / `TaskCompleted` hooks carrying `teammate_name` | `:7767-7798` | Confirms the concept is live in this build. |
| `PushNotification` tool (`sdk-tools.d.ts:2921`, `{message, status:'proactive'}`) plus `agentPushNotifEnabled` / `inputNeededNotifEnabled` settings (`:7495-7501`) | — | An agent-initiated mobile push that bypasses §10's `Notifier`, its `minLevel` gate and its `maxPerHour` cap. **G7.** |
| `Options.onElicitation` / `ElicitationRequest` | `:582-601`, `:1568` | The MCP-standard "server asks the consumer for user input" path. **Correctly unused**: our server runs *in* the consumer process, so `request_user_decision` can await `QuestionBridge` directly instead of round-tripping through the CLI. Recorded so the choice reads as a decision rather than an oversight. |
| `Options.agents` / `AgentDefinition` / `AgentMcpServerSpec` | `:1393`, `:38-100`, `:120` | D4's rejected alternative. Note `AgentMcpServerSpec = string \| Record<string, McpServerConfigForProcessTransport>` — the latter **excludes** instance-carrying configs, so a subagent could only reference the in-process server *by name*. Immaterial while roster bans subagents; recorded because it is the concrete reason "hand the subagent the toolset" was never available. |
| `Stop` hook with `decision: 'block'` (`:7665-7690`, `SyncHookJSONOutput.decision`; `TerminalReason` members `'stop_hook_prevented'` / `'hook_stopped'`) | — | A real mechanism to enforce "you must call `report_status` before finishing" — an alternative to the `unstructured` breaker (§8.1). Not adopted: it would put turn-completion policy in a second place alongside the pattern engine, while the breaker is deterministic and restart-safe. Recorded as an available lever if unreported turns turn out to be common — the same trigger §18 already names for structured output. |

**Conclusion: nothing in the SDK provides the coordination orchestrator needs.** There is no
cross-session mailbox with delivery state, no assignment concept, no scoping, and the peer surface
that does exist is settings-driven, CLI-oriented and un-auditable from our side. §5's decision to
build on `messages` rows stands, and §5.1's "nothing is pushed" needs one guard (G6) to stay true.

---

## 8. Design contradictions

**Raised as design changes, per M0's acceptance. None of these were coded around.**

### C1 — `Write(path)` and `NotebookEdit(path)` scope rules are inert; only `Edit(path)` is consulted

DESIGN §2.5 states the write scope as three rules — `Edit(./docs/**)`, `Write(./docs/**)`,
`NotebookEdit(./docs/**)` — and R2's resolution has roster intersect them into `allow` and add the
complement to `deny`. Per §5 above, the SDK's own validator says `Write(...)`, `NotebookEdit(...)`
and `MultiEdit(...)` path rules "are not matched by file permission checks — only `Edit(path)` rules
are", and that "`Edit` rules cover all file-editing tools".

The v1 slice is not broken today, because `Edit(./docs/**)` is in the list and does the whole job.
But the stated mechanism is wrong in a way that fails dangerously:

- The **complement deny** is the half that matters. A deny of the form `Write(<everything else>)` is
  inert, so the write boundary outside the scope rests entirely on the `Edit(...)` complement. If a
  future change reorders or splits that list, the scope silently stops being a boundary — and §2.5
  calls it "enforced", which is the one property a reader must be able to trust.
- It invites the mirror-image error on reads: `Glob(path)` is inert too, and `Read(path)` covers all
  file-reading tools. §2.5 doesn't scope reads, so nothing is wrong today, but the same table would
  produce an inert rule the moment someone tried.

**Required change (§2.5, and R2's note to roster §6.2).** State the rule and emit one tool:

1. `scopeRules.allow` carries **`Edit(<path>)` only**, with a one-line comment saying that `Edit`
   rules cover `Write`, `NotebookEdit` and `MultiEdit` — so enumerating them is not defence in depth,
   it is noise that reads like defence in depth.
2. The complement in `scopeRules.deny` is likewise `Edit(<complement>)`, plus whatever bare
   mutating-tool denies roster's `write === false` floor already unions in (those are bare names, not
   path rules, and are unaffected).
3. Never emit `Edit(*)` for a whole-project scope: rule content of `*` collapses to the bare tool
   name and, in `allowedTools`, auto-approves ahead of `canUseTool`. A whole-project scope emits no
   scope rule at all.
4. Roster's compiler should surface the SDK's own warning text when it sees a `Write(...)` /
   `NotebookEdit(...)` / `MultiEdit(...)` / `Glob(...)` path rule from any layer — a free
   misconfiguration detector, and roster is the only place that sees every rule.

### C2 — §4.4's advice to prefer the built-in `AskUserQuestion` is conditional

DESIGN §4.4 closes with: "An agent that wants the strictly better inline behaviour should use the
built-in `AskUserQuestion`, which goes through runner's bridge and keeps the tool call pending; the
prompt templates say so."

Runner's C2 established that a **bare `allowedTools` entry auto-approves a tool before `canUseTool`
is consulted**, with no stated exception for `AskUserQuestion`, and roster's compiler emits the
effective allow set as `allowedTools`. So for any agent whose baseline allows `AskUserQuestion` by
bare name, the built-in tool does **not** reach runner's bridge: it is auto-approved, and whatever
the engine produces for an unanswered question is what the model sees. The prompt template would then
be steering agents into the one path that silently does not work, and the pair's *Open decisions*
flow (§6.4) would lose its stances.

**Required change (§4.4, and one line in §3.2's prompt-composition rules).**

- Restate the sentence conditionally: the built-in tool is preferable **when runner reports the
  question bridge as healthy for that session**. Runner already emits a `session.diagnostic` with
  `questionBridge: 'degraded'` when it detects the shadowing (runner C2, change 2). Orchestrator
  subscribes to that diagnostic and, when degraded, composes the prompt **without** the "prefer
  `AskUserQuestion`" sentence, leaving `request_user_decision` as the only advertised path. That is a
  branch on an existing signal, not a new mechanism.
- Record the corollary, which §4.4 does not currently make and which is a genuine argument in
  `request_user_decision`'s favour: it **cannot** be shadowed by a permission grant, because being
  allowed is precisely what lets it run at all.

### C3 — the six tools may be deferred behind tool search and never reach the prompt

DESIGN §0/[A1] assumes the tools "surface to the model as `mcp__<key>__<toolName>`", and §3.2's
prompt template ends with a *required close*: "call `mcp__agentmanager__report_status` with your
verdict." §3.3 then makes a turn with no report an `unstructured` breaker input.

This version defers MCP tools by default. Verbatim from the per-server `alwaysLoad` doc (`:1048`,
identical at `:1163` and `:1179`): "When true, all tools from this server are **always included in
the prompt and never deferred behind tool search**… **Default: tools are deferred when tool search is
enabled**." The context-usage message even carries a row labelled "MCP tools (deferred)" (`:3220`).
Whether tool search is enabled is a CLI/engine decision with no `Options` switch — nothing roster or
runner can observe or set.

If the six tools are deferred, an agent instructed to call `report_status` must first *find* it. The
failure mode is not an error: it is a turn that ends without a report, which the engine records as
`unstructured`, retries once with a stricter instruction (§3.3), and then halts `no_report` — a
guardrail firing on a wiring problem, which is the most expensive possible way to learn this.

**Required change (§0 [A1], §4.1).** Build the server with **`alwaysLoad: true`**:

```ts
createSdkMcpServer({ name: 'agentmanager', version, instructions, alwaysLoad: true, tools });
```

`CreateSdkMcpServerOptions.alwaysLoad` (`:497-504`) applies `_meta['anthropic/alwaysLoad']` to every
tool, and a per-tool `tool(…, { alwaysLoad })` is OR'd with it. Unlike the stdio/http `alwaysLoad`,
the in-process form carries **no** startup-blocking side effect (that clause appears only on the
transport-based configs, which must connect over a socket first), so the cost is prompt tokens for
six tool definitions and nothing else — the correct trade for the one toolset the whole collaboration
protocol runs through. §4.1 should state it, and M4's acceptance should assert that the six names
appear in `system/init.tools` (L6).

---

## 9. Gaps — things DESIGN does not say that this version makes it necessary to say

| # | Gap | Where |
|---|---|---|
| **G1** | **`MCP_TOOL_TIMEOUT` is the only bound on §4.4's hold, and it is process-wide.** `McpSdkServerConfigWithInstance` has no `timeout` field, unlike stdio/sse/http (`:1032` etc.), so the per-server override is unavailable; the env var is documented as "effectively unbounded by default" (`:481-483`). Two things follow: (a) §12 should record that the lever, if a bound is ever wanted, is `MCP_TOOL_TIMEOUT` in `options.env` — which **roster** owns (env replaces the child environment entirely) and which applies to *every* MCP server in the session including roster's stdio integrations, so it cannot be tuned for `request_user_decision` alone; (b) §4.4's 15-minute hold must be validated at startup as strictly less than any configured `MCP_TOOL_TIMEOUT`, and the park-and-continue path is what makes an inherited shorter bound survivable. | §4.4, §12 |
| **G2** | **A `createSdkMcpServer` instance is single-use.** `Protocol.connect()` throws on a second transport, `Query.connectSdkMcpServer` swallows that rejection into a log line, and `initialize()` has already announced the server name to the CLI — so a reused instance yields a session that believes it has the toolset and gets no answers. §4.1's "per launch" should be stated as an invariant with this as the reason, and M4 needs a test that two concurrent sessions get two instances (distinct object identity, both `connected` in `mcpServerStatus()`). | §4.1, M4 |
| **G3** | **§4.3's "all responses are JSON content blocks" has no MCP equivalent.** `CallToolResult.content` blocks are `text` / `image` / `audio` / `resource` / `resource_link` — there is no JSON block. `structuredContent` exists but is only validated against an `outputSchema`, and `tool()` accepts none. So each tool returns a **single `text` block containing `JSON.stringify(payload)`**, optionally with `structuredContent` alongside. Say so, because "JSON content block" will otherwise be implemented as a block type that does not exist. | §4.3 |
| **G4** | **`strictMcpConfig` and sdk-type servers.** `Options.strictMcpConfig` (`:2032-2038`) reads as exactly what roster wants ("only use MCP servers passed via the `mcpServers` option") but maps to the CLI `--strict-mcp-config` flag, and the wrapper never puts sdk-type servers into that flag's payload — they travel on the control channel instead. Whether the flag drops them is **unverified** (L10). Roster must not adopt `strictMcpConfig: true` before that test runs. | §4.1, roster |
| **G5** | **Use `extra.signal` and `extra.requestId`.** `extra` carries an `AbortSignal` aborted on `notifications/cancelled`, and the JSON-RPC `requestId`. §4.4's hold must race the signal — otherwise a cancelled call leaves a `QuestionBridge` entry and a `questions` row with nobody waiting — and handlers should be idempotent per `requestId`, the same discipline runner adopted for `canUseTool` redelivery. | §4.4, §4.2 |
| **G6** | **`crossSessionInbound` can push messages into a live session.** `Settings.crossSessionInbound` (`:7487-7489`) delivers `SendMessage` from other sessions, and **unset means auto-deliver on permission-mode parity**. Roster loads `settingSources: ['project','user']`, so this is reachable without orchestrator's knowledge, and §5.1's "not pushed into a live session — a decision, not an omission" would become false in a way round accounting cannot see. Raise to roster: pin `crossSessionInbound: 'refuse'` in the compiled settings tier, and add the peer-messaging tool names to `policy.globalDeny`. | §5.1, roster |
| **G7** | **A built-in `PushNotification` tool exists** (`sdk-tools.d.ts:2921`) alongside `agentPushNotifEnabled` / `inputNeededNotifEnabled` settings (`:7495-7501`). An agent could push to the owner's phone outside §10's `Notifier`, its `minLevel` gate, its one-per-question rule and its `maxPerHour` cap — and in the work edition, where §10 defaults `notify.enabled: false` as a *policy* decision, that would be a policy hole. Raise to roster: `PushNotification` belongs in `policy.globalDeny`, and both settings default to `false`. | §10, roster |
| **G8** | **Tool-name aliasing: `Task → Agent`** (wrapper source). §14's D4 conformance rests on "roster's ban on the SDK subagent tool"; the canonical name after alias resolution is `Agent`. Also relevant: MCP server-level specs (`mcp__server`, `mcp__server__*`, `mcp__*`) in `AgentDefinition.disallowedTools` remove every tool from a server (`:48`) — the shape roster would need if subagents were ever permitted. | §14, roster |
| **G9** | **`instructions` and `annotations` are free and unused.** `CreateSdkMcpServerOptions.instructions` is surfaced to the model as an MCP instructions block — the natural home for the one-paragraph coordination contract §4.2 currently expresses only through refusal messages. Per-tool `annotations.readOnly` is what `McpServerStatus.tools[]` reports. | §4.1, §4.3 |
| **G10** | **`mcpServerStatus()` is the mount assertion.** It returns per-server `status` plus `tools[]`, so "the six tools mounted under `agentmanager`" is one in-process call rather than a transcript scrape. M4's acceptance ("no server is mounted when the module is disabled") should assert on it rather than on the absence of a rule. | M4 |

---

## 10. Live verification pending

**Nothing in §1–§7 marked *confirmed* depends on an item in this list.** Everything here is engine
behaviour (bytecode) or a runtime observation. Every item is encoded as a ready-to-run test in
`src/modules/orchestrator/__spike__/sdk.spike.test.ts`, which skips itself unless
`CLAUDE_CODE_OAUTH_TOKEN` is present — and there is none in this environment. "Blocks" names the
milestone that must not ship without the answer.

| # | Must be confirmed live | Blocks | Why it cannot be settled statically |
|---|---|---|---|
| **L1** | A server mounted at `mcpServers.agentmanager` surfaces its tools as `mcp__agentmanager__<name>` in `system/init.tools`, and the record key wins if `createSdkMcpServer({name})` differs from it. | **M4** (§4.1, A1) | Name construction is engine-side. DESIGN sets both to `agentmanager`, so a failure here is a diagnosis, not an outage. |
| **L2** | Whether the **engine** populates `extra._meta` on a real `tools/call` (it is `undefined` under the loopback run), and that no identity appears there either. | **M4** (§4.2, A2) | The `extra` shape is settled offline; `_meta` is passed through from the CLI's JSON-RPC params, so only the engine decides its contents. A surprise here would be an *opportunity*, not a problem — §4.2 needs nothing from it. |
| **L3** | How long a handler may block before the engine cancels under the default `MCP_TOOL_TIMEOUT`, whether `extra.signal` aborts when it does, and what the model sees afterwards. **If the observed bound is under 15 min, §4.4's hold shortens to fit inside it and the value is recorded before M5.** | **M4** (§4.4, A3, G1) | The default lives in the engine; the wrapper imposes none. This is M0's explicit acceptance clause. |
| **L4** | An `isError: true` result reaches the model as readable text and the turn continues — a refused `send_to_agent` teaches the agent rather than crashing the turn. | **M4** (§4.2, A4) | The protocol shape is settled offline; **delivery to the model** is engine-side and is the half that matters for §4.2's "an agent that learns *why* it was refused stops retrying". |
| **L5** | An in-process instance and a stdio integration coexist in one `mcpServers` record, both `connected` in `mcpServerStatus()`, both callable. | **M4** (A5) | Wrapper partitioning is confirmed; the CLI's merge of the two announcements is not. |
| **L6** | Without `alwaysLoad`, do the six tools appear in the turn-1 prompt, or only behind tool search? With `alwaysLoad: true`, do they always appear? | **M4 / M6** (C3) | Tool search is engine-side with no `Options` switch. This test decides whether C3 is a correction or a precaution. |
| **L7** | A call to a tool covered by a bare `mcp__agentmanager__*` allow rule **skips** `canUseTool` (no question card per coordination call), and the `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` warning names the MCP entries. | **M4** (§4.1) | Follows from runner C2 for built-ins; MCP entries are untested. |
| **L8** | A tool that is *registered* but **not** in the allow set falls through to `canUseTool` (i.e. would raise a user card) — the reason a worker's server must register only four tools. | **M4 / M7** (§4.1) | Engine-side permission flow. |
| **L9** | Whether peer-messaging tools (`SendMessage` / `ListAgents`, aliased from `Brief` / `ListPeers`) are offered at all in an SDK session, and whether `crossSessionInbound` can deliver into one. | **M4** (G6) | They are absent from `ToolInputSchemas` but present in the alias table; only a live tool list settles it. |
| **L10** | `strictMcpConfig: true` does **not** drop the sdk-type server. | **M4**, and roster before it adopts the flag (G4) | The flag is a CLI argv flag; sdk servers travel on the control channel. |
| **L11** | An `Edit(<dir>/**)` allow rule with the complement denied actually confines `Write` and `NotebookEdit` to that directory — C1's premise, and the whole of §2.5's "enforced for writes". | **M1 / M6** (C1, §2.5) | The validator's warning states it; the enforcement is engine-side, and this is the claim the v1 slice's safety rests on. |
| **L12** | `request_user_decision` answered inside the hold returns the answer as the tool result; past the hold it returns the stop instruction, the agent finishes, and the session ends **`done`**, not `paused`. | **M4** (§4.4) | Depends on L3 and on how the model handles a `pending` result. |
| **L13** | A large `read_mailbox` result (10 messages × 8 KB) is delivered intact, or truncated — and if truncated, by what and with what marker. | **M4** (§4.3, §5.1) | `MCP_TRUNCATION_PROMPT_OVERRIDE` exists in the engine's env vocabulary; the limit itself is not declared. |
| **L14** | MCP tool calls and their results appear in the transcript / `session.message` stream in a form §11.2's conversation view can render (tool_use + tool_result content blocks, per runner G2). | **M6** (§11.2) | Depends on how the engine records MCP calls; runner G2 established the shape for built-ins only. |
| **L15** | Two concurrent sessions each get their own instance and both work — the negative case being G2's silent failure when one instance is reused. | **M4** (G2) | The throw is confirmed; that the SDK swallows it into a *working-looking* session needs to be seen once. |

---

## 11. Implementation notes (no design impact)

- **The committed CI check** is `src/modules/orchestrator/__spike__/sdk.spike.test.ts`, following the
  shape runner's M0 established, in three blocks. The **surface** block always runs and fails
  `npm run ci` if `createSdkMcpServer` / `tool` stop being exported, if `CreateSdkMcpServerOptions`,
  `SdkMcpToolDefinition`, `McpSdkServerConfigWithInstance` or the `Query` MCP methods change shape,
  if `McpSdkServerConfigWithInstance` ever *gains* a `timeout` field (G1 would then be obsolete), or
  if `package.json` stops pinning the exact version these notes were verified against. The
  **offline protocol** block also always runs — it builds the real server and drives it over a
  loopback transport, so [A2], [A3]'s server-layer half, [A4] and G2 are regression-tested on every
  commit with no auth. The third block is `describe.skipIf(no token)` and encodes §10 verbatim, with
  `L<n>` tags mapping 1:1 onto that table. The file is a leaf — nothing in `src/` imports it — and
  `tsconfig.build.json` excludes `src/**/*.test.ts`, so it never reaches `dist/`.
  *Deviation from M0's item 4, which asks for "a throwaway SDK probe (not shipped)": it lives under
  `src/modules/orchestrator/__spike__/` so the surface half runs in CI on every commit. The live half
  is throwaway in the sense that matters — it never executes without a token.*
- **M0's items 1–3** (module registration, the `orchestrator.*` config sub-schema,
  `migrations/orchestrator/0001_orchestrator.sql`) are code and are **not** part of this deliverable;
  this document covers item 4 and the "written record of the five assumptions" half of the
  acceptance.
- **Type-name collisions to alias when M4 starts importing.** The SDK exports `Options`, `Query`,
  `PermissionResult` and `AgentDefinition` (already flagged by roster and runner); orchestrator
  additionally collides on **`McpServerConfig`** (roster's integration config type is the natural
  clash) and on **`AgentInfo`** (`:105`, the SDK's subagent descriptor — `list_roster`'s result rows
  are the obvious collision). Import the SDK's under aliases.
- **`tool()`'s fifth argument** (`{annotations?, searchHint?, alwaysLoad?}`) is absent from DESIGN;
  `alwaysLoad` is C3's fix and `searchHint` is its fallback if tool search turns out to be
  unavoidable.
- **`npm install` in a fresh worktree needs `--ignore-scripts`** on Node 25 (`better-sqlite3` runs
  `node-gyp rebuild` despite shipping prebuilt binaries). Unchanged from roster's and runner's notes;
  repeated because it blocks a clean orchestrator worktree too.
- **The pin was verified, not touched.** `package.json` still reads
  `"@anthropic-ai/claude-agent-sdk": "0.3.233"` — exact, no range — and the spike's first test
  asserts it.
