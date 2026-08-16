# Runner M0 — Claude Agent SDK surface verification

Static verification of every SDK behaviour [DESIGN.md](DESIGN.md) depends on, against the exact
version pinned in `package.json`. Companion to [roster/SDK-NOTES.md](../roster/SDK-NOTES.md), which
settled the *option-compilation* surface against the same build; this document does not re-derive
anything roster settled and goes deeper on the runner-specific surface: streaming input, the message
stream, the permission callback, usage, resume, and the process.

| | |
|---|---|
| Package | `@anthropic-ai/claude-agent-sdk` |
| Version pinned (exact, no range) | **0.3.233** — verified still exact in `package.json` (`"@anthropic-ai/claude-agent-sdk": "0.3.233"`), and `node_modules` resolves to 0.3.233 |
| Bundled CLI (`manifest.json`) | `2.1.233`, commit `f8d5756`, built 2026-08-14 |
| Verified against | `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` (8043 lines), `sdk-tools.d.ts` (3896 lines), **`sdk.mjs` (the shipped, readable Node wrapper)**, `manifest.json` |
| Method | **Static only.** No session was started — this environment has no `CLAUDE_CODE_OAUTH_TOKEN` and no interactive auth is possible. |
| Date | 2026-08-16 |

**What can and cannot be read.** The *engine* is a per-platform Bun-compiled executable
(`claude.exe`, 320 MB) whose JavaScript is bytecode: permission evaluation, tool dispatch, and
session-file writing are **not** readable. But the **SDK wrapper `sdk.mjs` is ordinary readable
JavaScript**, and it owns more of runner's critical surface than the roster spike needed: the
`query()` entry point, the input-stream pump, the control-request dispatcher that invokes
`canUseTool` and hooks, the subprocess spawn and its argv/env, and the error surfaces. Findings
sourced from `sdk.mjs` are marked **(wrapper source)** and are as solid as the declarations;
findings that would require the engine are marked **unverified statically** and appear in
[§11 Live verification pending](#11-live-verification-pending).

**Verdict vocabulary**

| Verdict | Meaning |
|---|---|
| **confirmed** | The declaration or wrapper source says exactly what DESIGN says. |
| **differs** | Present, but not with the shape/semantics DESIGN assumes. Design impact stated. |
| **absent** | Not in this version at all. |
| **unverified** | Cannot be settled from declarations or wrapper source; needs a live session. Listed in §11. |

---

## 1. The `[A]` assumptions from DESIGN §0

DESIGN §0 lists six assumptions to confirm in M0. All six, plus §9.4's inline restatement of A1.

| # | Assumption | Verdict | Evidence |
|---|---|---|---|
| **A1** | Does a plain `resume` preserve the SDK session id or mint a new one? | **confirmed by inference — verify live** | `Options.forkSession` (`sdk.d.ts:1522-1526`): "When true, resumed sessions will **fork to a new session ID** rather than **continuing the previous session**. Use with `resume`." The contrast only makes sense if `forkSession` absent/false continues under the *same* id. Runner leaves `forkSession` unset, so the id should be preserved. Related hard constraint: `sessionId` "Cannot be used with `continue` or `resume` unless `forkSession` is also set" (`:1830-1835`) — see gap **G3**. |
| **A2** | The exact message sequence after `interrupt()` | **unverified** | Not declared. Corroborating declarations: `SDKAssistantMessage.aborted?: true` — "truncated by an interrupt/abort before the stream completed: `stop_reason` was never received and the content may end mid-word" (`:3037-3040`); `TerminalReason` carries `'aborted_streaming'` and `'aborted_tools'` (`:7803`), which surface as `result.terminal_reason`. The `result` **subtype** an interrupted turn produces is not stated anywhere. **New and load-bearing** — see §4.2 on `still_queued`. |
| **A3** | Can `canUseTool` and `hooks` coexist without shadowing? | **confirmed at the transport layer; engine ordering unverified** | `sdk.mjs` `processControlRequest` dispatches `can_use_tool` and `hook_callback` as two independent control-request subtypes on one channel — neither can suppress the other in the wrapper. Engine-side ordering is directly evidenced once: `SDKPermissionDeniedMessage` (`:4426`) says "Denials that resolve **before `canUseTool` runs** — **PreToolUse hook denies**, and deny-rule overrides of hook allow/ask decisions — are not covered here", i.e. **PreToolUse runs before `canUseTool`**. Consistent with DESIGN §0's stated order. |
| **A4** | Does `accountInfo()` expose any plan-window information? | **differs** | `AccountInfo` (`:23-33`) is `{ email?, organization?, **subscriptionType?**, tokenSource?, apiKeySource?, apiProvider? }` — the **plan tier**, but **no window utilization**. Window data exists, on a *different* method (`Query.usage_EXPERIMENTAL_…`, §7.3). Both facts contradict DESIGN §7.4/D7 and D3 — see **contradiction C3**. |
| **A5** | Semantics of `resumeSessionAt` / `resumeDropsTurn` | **confirmed — fully documented** | `:1836-1894`. `resumeSessionAt` = "only resume messages up to and including the message with this UUID", accepts **any chain-entry UUID**. `resumeDropsTurn` = the prompt UUID of the turn the truncating resume intends to discard; the CLI validates the discarded range and **refuses** with an `error_during_execution` result whose message starts with `Resume rejected by --resume-drops-turn:`. **Consumers MUST map a refusal to a rewind-recovery path and MUST NOT retry — the refusal is deterministic.** General rule: "fork at the KEPT turn's last chain entry, whatever it is". **Print/headless lane only** — which is exactly the lane the SDK uses. Runner does not use either in v1; recorded because §9.4's mid-tool-call recovery is where they would land. |
| **A6** | Does a session killed mid-tool-call resume cleanly? | **unverified** | Engine behaviour. Strong corroborating guidance in the `resumeDropsTurn` doc (`:1888-1892`): "interrupted turns that completed one or more tools before Esc: the completed (non-error) `tool_result` in the tail is **kept-turn payload**… the marker / cancel-batch entries after it are skippable". This says the tail of an interrupted turn *is* persisted, which supports §9.3's structural detection (a `tool_use` with no matching `tool_result`), but says nothing about whether the model recovers coherently. |

---

## 2. `query()` and streaming-input mode (DESIGN §4)

### 2.1 The entry point

```ts
export declare function query(_params: {
    prompt: string | AsyncIterable<SDKUserMessage>;
    options?: Options;
}): Query;                                                     // sdk.d.ts:2666-2669
```

**confirmed.** `Query extends AsyncGenerator<SDKMessage, void>` (`:2358`).

### 2.2 One-shot vs streaming, as the wrapper actually implements it

(wrapper source) `query()` is:

```js
function query({prompt, options}) {
  const {queryInstance, transport, abortController} = setup(options, { isSingleUserTurn: typeof prompt === "string" });
  if (typeof prompt === "string")  transport.write(JSON.stringify({type:"user", session_id:"", message:{role:"user",content:[{type:"text",text:prompt}]}, parent_tool_use_id:null}) + "\n");
  else                             queryInstance.streamInput(prompt).catch((e) => abortController.abort(e));
  return queryInstance;
}
```

Three consequences, all of them things DESIGN leans on:

1. **`isSingleUserTurn` is decided purely by `typeof prompt === 'string'`.** In the message reader,
   `if (e.type === "result") { … if (this.isSingleUserTurn) transport.endInput(); }` — a one-shot
   query closes the child's stdin on the **first** result; a streaming query does not. That is the
   whole mechanism behind "one `result` per turn" and behind interrupt/steer being streaming-only:
   once stdin is ended, `transport.write()` throws
   `Cannot write to terminated process` / drops the write, so **no control request can be sent**.
   DESIGN §4.1's "streaming input, always" is **confirmed** as necessary, not merely preferable.
2. **A throwing input iterable aborts the whole query.** The `.catch((e) => abortController.abort(e))`
   is the mechanism behind DESIGN §4.2's "it never throws" rule — an internal error in `InputQueue`
   does not surface as itself, it surfaces as an abort. **confirmed**, and the rule stands.
3. **The iterable is consumed lazily.** `streamInput` is a plain `for await (… of stream)` pull loop
   that writes one message per iteration:

   ```js
   async streamInput(e) {
     let t = 0;
     for await (const n of e) { t++; if (this.abortController?.signal.aborted) break; await this.transport.write(JSON.stringify(n) + "\n"); }
     if (t > 0 && this.hasBidirectionalNeeds()) await this.waitForFirstResult();
     this.transport.endInput();
   }
   ```

   **confirmed lazy** — it is not drained into a buffer. DESIGN §4.2's fallback ("`streamInput` is the
   fallback if M0 finds the iterable is consumed eagerly") is **not needed**; `Query.streamInput()`
   is in fact the *same* method `query()` calls internally. Two further facts runner's `InputQueue`
   must honour:
   - **Closing the queue closes the child's stdin** (`endInput()` after the loop ends). That is the
     documented, correct way to wind a session down, and it is one-way.
   - When any bidirectional feature is in use — `hasBidirectionalNeeds()` is true if **`canUseTool`**,
     `hooks`, SDK MCP servers, `onElicitation`, `onUserDialog`, or an auth-token callback is set,
     which is *always* true for runner — the pump **waits for the first `result` before ending
     input**. So a queue that is closed mid-turn does not truncate that turn.

### 2.3 `SDKUserMessage` — the shape runner must push

`sdk.d.ts:4865-4909`. Required: `type: 'user'`, `message: MessageParam` (the Anthropic SDK param —
so text and base64 image content blocks both work, **confirming** DESIGN §4.2's attachment claim by
construction), `parent_tool_use_id: string | null`. Optional and relevant:

| Field | Note |
|---|---|
| `session_id?`, `uuid?` | **Optional on input** — the one-shot path writes `session_id: ""`, so runner need not know the id before `init`. |
| `priority?: 'now' \| 'next' \| 'later'` | **absent from DESIGN.** A queued-steer ordering lever §4.3 could use later; not needed for v1. |
| `shouldQuery?: boolean` | "When false, the message is appended to the transcript **without triggering an assistant turn**. It will be merged into the next user message that does query." **absent from DESIGN**, and a genuinely useful primitive for §5.4's answer injection if the design ever wants to record an answer without spending a turn. |
| `isSynthetic?`, `timestamp?`, `tool_use_result?` | Present on inbound messages; not needed on outbound. |

`SDKUserMessageReplay` (`:4911-4949`) is a **separate union member** with `isReplay: true` and
**required** `uuid`/`session_id`: on a `resume`, the replayed history arrives as `type: 'user'`
messages carrying `isReplay`. **The transcript writer and the event mapper must filter on
`isReplay`** or a resumed session will re-emit its whole prior conversation as new `user` lines.
DESIGN §8.1 and §10 do not mention this — gap **G1**.

---

## 3. The message stream (DESIGN §2.4, §8.1, §10)

### 3.1 `SDKMessage` is a 38-member open union

`sdk.d.ts:4273`. Runner's reader loop maps a handful and must pass the rest through — DESIGN §7.4's
"the reader loop tolerates unknown message types by construction" is **confirmed** by the wrapper
(the read loop's terminal branch is an unconditional `enqueue(e)`), and is *necessary*: this version
already ships `task_*`, `hook_*`, `status`, `memory_recall`, `prompt_suggestion`, `informational`,
`mirror_error`, `conversation_reset`, `auth_status`, `worker_shutting_down`, `files_persisted`,
`session_state_changed`, `active_goal`, `autocompact_state`, and more.

Every member carries **`session_id: string`** and **`uuid: UUID`** (except `SDKUserMessage`, where
both are optional — inbound only). **Session id is on every message, not only on `init`** — DESIGN
§3.1 step 10 reads it from `system/init`, which is correct and also the earliest point.

### 3.2 The members runner's transcript writer and event mapper need

| DESIGN transcript type / event | SDK member | Verdict | Fields runner needs |
|---|---|---|---|
| `system` header (§8.1) | `SDKSystemMessage` `{type:'system', subtype:'init'}` (`:4690-4738`) | **confirmed, and richer** | `session_id`, `tools`, `mcp_servers[{name,status}]`, `plugins[{name,path,version?}]`, `skills`, `model`, `permissionMode`, `cwd`, `slash_commands`, `output_style`, `agents?`, `betas?`, **`claude_code_version`** (gives §8.1's "SDK + CLI version" for free), **`apiKeySource: ApiKeySource`** (`'user'\|'project'\|'org'\|'temporary'\|'oauth'`, `:124`) — a direct read-out of *which* auth won, worth putting in the header for §3.4's `ANTHROPIC_API_KEY` guard, and **`capabilities?: string[]`** (see §4.2). |
| `assistant` (§8.1), `session.message` | `SDKAssistantMessage` (`:3021-3070`) | **confirmed** | `message: BetaMessage` (id, content, usage), `parent_tool_use_id`, `uuid`, `session_id`. Also `error?: SDKAssistantMessageError`, `aborted?: true`, `supersedes?: UUID[]`, `subagent_type?`, `timestamp?`. |
| `user` (§8.1) | `SDKUserMessage` / `SDKUserMessageReplay` | **confirmed**, see G1 | |
| `tool_use` / `tool_result` (§8.1), `session.tool.*` | — | **differs (absent as message types)** | There is **no** `tool_use`/`tool_result` message type. Tool calls are content blocks inside `SDKAssistantMessage.message.content`; results arrive as `SDKUserMessage` whose `message.content` holds `tool_result` blocks, with the structured twin on **`SDKUserMessage.tool_use_result`** (`:4870-4873`: "the tool's full Output object, not the string content sent to the model"). DESIGN §8.1's line vocabulary is fine as a *transcript* vocabulary; the mapping is runner's, not the SDK's. Gap **G2**. |
| `usage` (§8.1), `session.usage` | `SDKResultMessage` | **confirmed** — see §6 | |
| partial text, `session.delta` | `SDKPartialAssistantMessage` `{type:'stream_event'}` (`:4410-4417`) | **confirmed** | `event: BetaRawMessageStreamEvent`, gated by `includePartialMessages` (`:1653-1657`). |
| `session.diagnostic` (MCP) | `Query.mcpServerStatus(): Promise<McpServerStatus[]>` (`:2502`) | **confirmed** | status union `'connected'\|'failed'\|'needs-auth'\|'pending'\|'disabled'` — matches DESIGN §10 exactly. Also `serverInfo?`, error message when failed. |
| — | `SDKPermissionDeniedMessage` `{type:'system', subtype:'permission_denied'}` (`:4425-4451`) | **absent from DESIGN** | `tool_name`, `tool_use_id`, `decision_reason_type?` (`'classifier'\|'asyncAgent'\|'mode'\|'rule'`), `decision_reason?`, `message`. This is a **live** denial signal, hours ahead of `result.permission_denials`. The doc is explicit that it is "**best-effort advisory**… `result.permission_denials` is the authoritative record", which is what DESIGN §2.4 already reads — so this is an optional UI improvement, not a correction. |
| — | `SDKSessionStateChangedMessage` (`:4648-4657`) | **absent from DESIGN** | `state: 'idle' \| 'running' \| 'requires_action'`, documented as "**authoritative turn-over signal**". A cleaner "the turn is over" edge than inferring it from `result`; note the wrapper deliberately does *not* clear its error-result memo on this subtype, i.e. it can arrive *after* a `result` — which is direct wrapper-source corroboration for DESIGN §2.4's "trailing system events arrive after `result`". |
| — | `SDKCompactBoundaryMessage` (`:3114-3150`) | matches §16's deferred item | `compact_metadata.{trigger, pre_tokens, post_tokens?, duration_ms?}`. Recording it is all v1 does. |
| — | `SDKRateLimitEvent` (`:4494-4527`) | **differs** — see §7 and **C3** | |

### 3.3 One `result` per turn (DESIGN §2.4)

**confirmed in mechanism** (wrapper source, §2.2 above): only `isSingleUserTurn` triggers
`endInput()` on a result, so a streaming session's generator keeps yielding after the first
`result`. The reader loop of DESIGN §2.4 — iterate to generator completion, do not stop at the first
result — is correct and necessary. The exact set of messages that follow a `result` is engine
behaviour (**unverified**, §11).

---

## 4. Query control surface (DESIGN §4.3, §6, §9.1)

### 4.1 Method inventory

All **confirmed** on `Query` (`sdk.d.ts:2358-2664`), all documented "only supported when streaming
input/output is used":

`interrupt()` `:2372` · `setPermissionMode()` `:2379` (DESIGN deliberately does not call it) ·
`setModel()` `:2406` · `streamInput()` `:2636` · `close()` `:2663` · `mcpServerStatus()` `:2502` ·
`supportedModels()` `:2490` · `supportedCommands()` `:2484` · `accountInfo()` `:2556` ·
`getContextUsage()` `:2509` · `initializationResult()` `:2461` · `setMcpServers()` `:2629` ·
`stopTask()` `:2641` · `backgroundTasks()` `:2654`.

Two that are **absent from DESIGN** and worth knowing:

- **`reinitialize()`** (`:2478`) — "the CLI's response carries any `can_use_tool` …control requests
  the loop is still blocked on, and the SDK redelivers them to `canUseTool`… callbacks should be
  **idempotent per `request_id`**". Not needed for a subprocess transport, but it makes explicit
  that a `canUseTool` invocation can be **redelivered**. Runner's adapter should key its pending-map
  on `requestId` and be idempotent — cheap now, and it is the difference between one question card
  and two.
- **`usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()`** (`:2523`) — §7.3, **C3**.

### 4.2 `interrupt()` returns a receipt, and queued messages may survive it

```ts
interrupt(): Promise<SDKControlInterruptResponse | undefined>;   // :2372
```

"On CLIs advertising the **`interrupt_receipt_v1`** capability (`system/init` `capabilities`) the
resolved value is the interrupt receipt — **`still_queued` uuids of async user messages that WILL
still run unless cancelled first**. Older CLIs resolve to `undefined`." A second capability,
`interrupt_cancel_queued_v1`, makes the interrupt honour `cancel_queued: true` (`:4730`).

**This is new to DESIGN and it bears directly on §4.3.** `steer({interrupt: true})` is specified as
"call `interrupt()`, wait for the turn to wind down, then push". If a *previous* non-interrupting
steer is still queued, it may survive the interrupt and run **after** the interrupting one — the
opposite of "stop that, do this instead". Runner must read `system/init.capabilities`, keep the
receipt, and surface/clear `still_queued`. Same applies to §5.4's park and §9.1's shutdown, where a
queued steer surviving an interrupt would run against a session the user believes is stopped.
Gap **G4**.

### 4.3 Cancellation and `close()`

- `Options.abortController?: AbortController` (`:1350-1353`) — **confirmed**. (wrapper source) the
  transport registers `abortHandler = () => this.close()` on the signal and closes immediately if
  the signal is already aborted; `write()` on an aborted controller throws.
- `close()` (`:2655-2663`) "forcefully ends the query… including pending requests, MCP transports,
  and the CLI subprocess. After calling `close()`, no further messages will be received."
- **`AbortError`** is an exported class (`:17`) — runner can `instanceof` it rather than matching
  message text.

DESIGN §9.1's pause sequence (`interrupt()` → drain → `close()`, then `AbortController.abort()` for
the stragglers) maps onto these exactly. **confirmed.**

---

## 5. The permission callback and the question bridge (DESIGN §5)

### 5.1 `CanUseTool` — confirmed, and much wider than DESIGN states

```ts
export declare type CanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  options: { signal: AbortSignal; suggestions?: PermissionUpdate[]; blockedPath?: string;
             decisionReason?: string; title?: string; displayName?: string; description?: string;
             toolUseID: string; agentID?: string; requestId: string;
             matchedAskRule?: { source: string; toolName: string; ruleContent?: string } }
) => Promise<PermissionResult | null>;                                    // sdk.d.ts:206-266
```

DESIGN §0's `(toolName, input, {signal, suggestions})` is **confirmed** — a callback declaring fewer
properties still assigns — and the extra fields are exactly what a good question card wants:

- **`title`** — "Full permission prompt sentence rendered by the bridge (e.g. *Claude wants to read
  foo.txt*). **Use this as the primary prompt text when present** instead of reconstructing from
  toolName+input." DESIGN §5.2's `prompt` should be `title ?? <constructed>`, and `displayName` /
  `description` fill the card's label and subtitle. This removes runner's need to render tool inputs
  itself — worth adopting in M7.
- **`matchedAskRule`** — set when a user-configured `permissions.ask` rule forced the prompt. This is
  precisely DESIGN §5.1's second question source, **identifiable rather than inferred**: runner can
  label a card "your `ask` rule required this" versus "no rule decided this", without matching any
  pattern itself (so §5.1's "runner matches no rule patterns" is preserved).
- **`toolUseID` / `requestId`** — the pending-call keys (§4.1: be idempotent per `requestId`).

**`PermissionResult`** (`:2193-2205`) — **confirmed**:
`{behavior:'allow', updatedInput?, updatedPermissions?, toolUseID?, decisionClassification?}` |
`{behavior:'deny', message, interrupt?, toolUseID?, decisionClassification?}`. DESIGN §5.3's shapes
compile as written; `updatedInput` is *optional* in the type (DESIGN's "older CLI builds reject one
that omits it" is **unverified** — keep echoing it, it costs nothing). New: `decisionClassification`
(`'user_temporary' | 'user_permanent' | 'user_reject'`, `:2153`) is telemetry the SDK asks hosts that
prompt users to set — runner should set `user_temporary` on allow and `user_reject` on deny, since it
is exactly the "Allow once / Deny" card DESIGN §5.1 specifies.

**Returning `null` is fail-closed and must never happen.** `:200-204`: "Return `null` ONLY after the
consumer has already sent the control_response out-of-band… **an accidental null means no
control_response is sent and the tool stays blocked indefinitely — permission prompts have no park
deadline.**" DESIGN does not mention this. Gap **G5**: the adapter must be a total function whose
every path returns an allow or a deny, and `runner.question.holdMs` is the *only* thing standing
between a bug and a wedged subprocess.

### 5.2 "`canUseTool` may stay pending indefinitely" — confirmed

(wrapper source) `handleControlRequest` `await`s the callback with **no timeout** and only cancels on
an explicit `control_cancel_request` (which aborts the `signal` handed to the callback). Combined
with `:203-204` above, DESIGN §5.3's central premise — the SDK holds execution paused while
`canUseTool` is pending — is **confirmed**. The two-stage hold-then-park of §5.4 is a runner policy
on top of an unbounded SDK primitive, which is the right way round.

### 5.3 When `canUseTool` is **skipped** — the SDK says so itself

(wrapper source) `query()` runs a shadow check at construction and emits a Node process warning:

```js
function shadowReason(mode, allowedTools) {
  if (mode === "bypassPermissions")
    return "canUseTool will not be invoked: permissionMode 'bypassPermissions' auto-approves every tool call (except explicit deny rules) before the callback is consulted. To gate every tool call, use a PreToolUse hook instead.";
  const bare = allowedTools.filter(r => r.length > 0 && !r.includes("("));
  if (bare.length === 0) return;
  return `canUseTool will not be invoked for: ${bare.join(", ")}. Bare allowedTools entries auto-approve the whole tool before the callback is consulted. To gate every tool call, use a PreToolUse hook; or remove the bare names from allowedTools so they fall through to canUseTool. Allow rules from settings files can also shadow the callback but are not visible here.`;
}
// emitted as process.emitWarning(reason, { code: "CLAUDE_SDK_CAN_USE_TOOL_SHADOWED" })
```

Three findings, one of them a contradiction:

1. **Bare `allowedTools` entries short-circuit `canUseTool`.** This *confirms* DESIGN §5.1's core
   reasoning ("anything that reaches `canUseTool` has already failed to be auto-approved") from the
   SDK's own mouth. Rules **with** a specifier (`Bash(git status:*)`) are not treated as shadowing.
2. **It contradicts the `AskUserQuestion` always-fires claim** — see **C2**.
3. **The warning will fire on every AgentManager session.** Roster's compiler emits the effective
   allow set as `allowedTools` (roster §6.1/§13) and runner sets `canUseTool` on every session, so
   `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` is emitted at every `query()`. Runner should install a
   `process.on('warning')` filter for that code and log it once at `debug` with the session id — not
   let Node print it to stderr per launch. Gap **G6**.

`dontAsk` (DESIGN §5.6, roster reconciliation #20): **confirmed at documentation level, unchanged
from roster's finding** — `:1763` "Don't prompt for permissions, deny if not pre-approved" and
`:4426` "auto-denied without an interactive permission prompt (e.g. auto-mode classifier, **dontAsk
mode**…). With a permission prompt surface (stdio/SDK `canUseTool`), the `'ask'` path surfaces via a
`can_use_tool` control_request and **this event covers the `'deny'` short-circuit**." Note the shadow
check above deliberately covers only *approve*-side shadowing, so its silence on `dontAsk` is not
counter-evidence. **Reconciliation #20 is confirmed, not reopened.** Engine control flow remains
bytecode → the live check stays in §11.

### 5.4 `AskUserQuestion` — the answer round-trip is confirmed; "always fires" is not

The tool does **not** appear anywhere in `sdk.mjs` — it lives entirely in the engine. What the
declarations give:

- **`AskUserQuestionInput`** (`sdk-tools.d.ts:855-2431`) — `questions: [{question, header,
  options:[{label, description, preview?}] (2-4), multiSelect}]` (1-4 questions), **plus
  `answers?: { [k: string]: string }` documented as "User answers collected by the permission
  component"**, plus `annotations?`, `metadata?`.

  **This confirms DESIGN §5.3's delivery mechanism**: resolve with
  `{behavior:'allow', updatedInput:{ questions: input.questions, answers: { "<question text>": "<label>" } }}`.
  The `answers` key is a declared, documented member of the tool's own input schema, keyed by
  question text exactly as DESIGN says.
- **`AskUserQuestionOutput`** (`sdk-tools.d.ts:3451-3637`) — `answers: {[k:string]: string}`
  documented as "question text -> answer string; **multi-select answers are comma-separated**", plus
  `response?: string` ("Freeform text the user typed instead of selecting a structured option") and
  `afkTimeoutMs?`.

  **differs from DESIGN §5.3 in one detail**: DESIGN says "multi-select passes an **array** of
  labels". The declared value type is `string`, and the output doc says multi-select is a
  **comma-separated string**. §5.3's multi-select sentence must be corrected to
  `labels.join(', ')`. (Free text going "in the same `answers` slot" is right for the *input* side —
  the input schema has no `response` field.)
- **"It always reaches `canUseTool`, even with a matching allow rule"** — **unverified, and
  contradicted for the `allowedTools` route** (§5.3, **C2**).
- **"It is unavailable inside subagents"** — **unverified**; nothing states it. Immaterial while
  roster forbids subagents, and `canUseTool`'s `agentID` field would identify one anyway.

### 5.5 Hooks and `defer` (DESIGN §5.4, §16)

- `Options.hooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>>` (`:1547`) — **confirmed**;
  `HookEvent` has 31 members (`:837`) including `PreToolUse`, `PermissionRequest`, `PermissionDenied`.
- **`HookPermissionDecision = 'allow' | 'deny' | 'ask' | 'defer'`** (`:843`), reachable via
  `PreToolUseHookSpecificOutput.permissionDecision` (`:2334-2340`). **`defer` is confirmed present.**
- Its *semantics* are **unverified** — no prose anywhere. Three declarations corroborate DESIGN's
  reading ("ends the query with the tool call still pending"): `SDKResultSuccess.deferred_tool_use?:
  SDKDeferredToolUse` (`:4593`, shape `{id, name, input}` at `:4102`) and `TerminalReason` members
  `'tool_deferred'` and `'tool_deferred_unavailable'` (`:7803`). So the *result* of a defer is
  observable and typed; whether a subsequent `resume` re-issues the pending call without re-deciding
  is not. §16's deferred item stays deferred, now with a concrete live test to run.
- `Options.includeHookEvents` (`:1652`) surfaces `hook_started`/`hook_progress`/`hook_response`
  messages — useful for the M0 coexistence check without instrumenting the hook itself.

---

## 6. Usage, cost, and budgets (DESIGN §7)

### 6.1 `result` fields — every field DESIGN §7 and §2.2 name is present

`SDKResultSuccess` (`:4561-4600`) and `SDKResultError` (`:4529-4557`). **confirmed**, all of:
`session_id`, `usage`, `modelUsage`, `total_cost_usd`, `num_turns`, `stop_reason: string | null`,
`permission_denials: SDKPermissionDenial[]` (`{tool_name, tool_use_id, tool_input}`, `:4419`),
`duration_ms`, `duration_api_ms`, `is_error`, `uuid`.

Subtypes are **exactly** DESIGN's five: `'success'` plus `'error_during_execution' |
'error_max_turns' | 'error_max_budget_usd' | 'error_max_structured_output_retries'` (`:4531`).
§2.2's mapping table is complete against this version.

Success-only: `result: string` (the final assistant text — a free, exact source for §8.3's
`lastAssistantText`), `structured_output?`, `deferred_tool_use?`.
Error-only: **`errors: string[]`**. Both: **`terminal_reason?: TerminalReason`** (`:7803`, 19
members including `'blocking_limit'`, `'rapid_refill_breaker'`, `'prompt_too_long'`, `'api_error'`,
`'max_turns'`, `'budget_exhausted'`, `'hook_stopped'`, `'aborted_streaming'`, `'aborted_tools'`) —
**absent from DESIGN** and a far better classifier than the error-text matching §6.4 specifies.
`'blocking_limit'` and `'rapid_refill_breaker'` are plainly the rate-limit terminals. Gap **G7**:
§6.4's rate-limit classification should read `terminal_reason` first and fall back to text.

`ModelUsage` (`:1267-1284`): `{inputTokens, outputTokens, cacheReadInputTokens,
cacheCreationInputTokens, webSearchRequests, costUSD, contextWindow, maxOutputTokens,
canonicalModel?, provider?}` — maps 1:1 onto `session_usage`'s four token columns plus `cost_usd`.

### 6.2 `usage` vs `modelUsage` — DESIGN's two-source design is right, its arithmetic is not

Verbatim from `:4542` / `:4584`:

> **`usage`** — "**MAIN AGENT LOOP ONLY** — excludes Task subagent, sidechain, and auxiliary model
> calls, and is **per-turn** in streaming-input sessions. Prefer `modelUsage` for token/cost
> accounting."

and `:4546` / `:4588`:

> **`modelUsage`** — "Per-model totals for every model call made through the query pipeline during
> **this `query()` call** — main loop, Task subagents, sidechains, and internal calls such as
> compaction and Workflow agents. **Cumulative across turns in streaming-input sessions: each result
> carries the running total so far, so read the latest result rather than summing across results.**
> …**crash/startup-error results may carry zeroed usage, resumed sessions start fresh**, and a
> mid-session `/clear` resets the running total. The correct field for token/cost accounting; treat
> it as an estimate, not a billing statement."

`total_cost_usd` carries the **same** cumulative-per-`query()`-call lifecycle (`:4538` / `:4580`).

**confirmed**: `modelUsage` is the superset and the right accounting field (DESIGN §7.1's choice is
correct, and its stated reason — independence from a permission decision — is now backed by
"sidechains and internal calls such as compaction" too).

**differs, with real consequences**: DESIGN §7.1 and §2.4 treat these as *per-turn* values.
`modelUsage` and `total_cost_usd` are **cumulative per `query()` call and reset when a session is
resumed**. See **contradiction C1**.

### 6.3 Live per-message deltas

- "One API assistant turn may produce several assistant messages **sharing a `message.id`**, each
  with its own timestamp" (`:3050-3053`) — **confirmed**, and it is exactly the hazard §7.1's
  `(session_id, message_id)` unique index defends against.
- "identical usage" on those duplicates — **unverified**.
- "per-step `output_tokens` is a placeholder count taken at `message_start`" — **unverified**;
  nothing in the declarations says it. It is consistent with `usage` being flagged "prefer
  `modelUsage`", and DESIGN already treats live deltas as approximate, so nothing rests on it —
  but it is a static guess, and it is in §11.

### 6.4 `maxTurns` / `maxBudgetUsd`

- `maxTurns?: number` (`:1700-1704`) — "Maximum number of conversation turns before the query stops.
  **A turn consists of a user message and assistant response.**" **confirmed.**
- `maxBudgetUsd?: number` (`:1705-1709`) — "the query will stop if this budget is exceeded,
  returning an `error_max_budget_usd` result". **confirmed**; §7.2's independent-guard framing holds.
  Note it is measured in the same estimated dollars as `total_cost_usd`, and that total is
  **per-`query()`-call** — so a paused-and-resumed session gets a **fresh** `maxBudgetUsd` allowance
  per run. That is a real per-assignment leak if a session is parked and resumed repeatedly; the
  per-assignment token budget of §7.2 is the guard that actually holds, which is a point in its
  favour and worth stating in §7.2. Gap **G8**.
- **`taskBudget?: { total: number }`** (`:1710-1719`, `@alpha`) — **absent from DESIGN**: "the model
  is made aware of its remaining token budget so it can pace tool use and wrap up before the limit".
  A softer, model-visible sibling to §7.2's hard halt. Not for v1; recorded because §7.2's
  budget-halt experience ("the agent is stopped mid-thought") is exactly what it improves.

---

## 7. Plan windows and rate limits (DESIGN §7.4, D7)

### 7.1 `rate_limit_event` is fully declared and typed

```ts
export declare type SDKRateLimitEvent = { type: 'rate_limit_event'; rate_limit_info: SDKRateLimitInfo; uuid; session_id };  // :4494-4505
export declare type SDKRateLimitInfo = {
  status: 'allowed' | 'allowed_warning' | 'rejected';
  resetsAt?: number;                       // epoch
  rateLimitType?: 'five_hour' | 'seven_day' | 'seven_day_opus' | 'seven_day_sonnet' | 'seven_day_overage_included' | 'overage';
  utilization?: number;
  overageStatus?: …; overageResetsAt?: number; overageDisabledReason?: …;
  isUsingOverage?: boolean; overageInUse?: boolean; surpassedThreshold?: number;
  errorCode?: 'credits_required'; canUserPurchaseCredits?: boolean; hasChargeableSavedPaymentMethod?: boolean;
};                                                                                                        // :4507-4527
```

It is a **declared member of the `SDKMessage` union** (`:4273`) with a documented shape.
**differs** from DESIGN §7.4's "undocumented… absent from the docs and its shape is not stable".
Whether it is ever *emitted* is still runtime behaviour (**unverified**), so §7.4's defensive
consumption is still right — but it is not an undocumented field, and `status: 'rejected'` plus
`resetsAt` is a first-class cool-down input rather than a best-effort scrape.

### 7.2 Plan-window utilization **is** programmatically available

`Query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(): Promise<SDKControlGetUsageResponse>`
(`:2510-2523`) — "the structured data behind the `/usage` command: session cost and token usage
totals **plus claude.ai plan rate-limit utilization windows (5-hour, 7-day, per-model) when
available**." The response (`:3438-3646`) carries:

- `subscription_type: string | null` — `'pro' | 'max' | 'team' | 'enterprise'`, null for API-key/3P;
- `rate_limits_available: boolean` and `rate_limits: { five_hour?, seven_day?, seven_day_opus?,
  seven_day_sonnet?, seven_day_oauth_apps?, model_scoped?[], extra_usage? } | null`, each window
  `{ utilization: number | null /* 0-100 */, resets_at: string | null /* ISO */ }`;
- `session: { total_cost_usd, total_api_duration_ms, total_duration_ms, total_lines_added,
  total_lines_removed, model_usage }`;
- `behaviors: { day, week }` — request/session counts and per-skill/agent/plugin/MCP attribution
  "from a scan of local transcripts on this machine… **Approximate, excludes other devices and
  claude.ai**".

The method name is a shout: "EXPERIMENTAL: this API is unstable and may change or be removed in any
release without notice — do not rely on it yet. **The method name will change when the API is
stabilized.**" See **contradiction C3** for what this does and does not change in DESIGN.

---

## 8. Resume and session persistence (DESIGN §9)

| DESIGN claim | Verdict | Evidence |
|---|---|---|
| SDK session state is JSONL under `$CLAUDE_CONFIG_DIR/projects/<encoded-cwd>/<session-id>.jsonl` | **confirmed** | `persistSession` (`:1605-1612`): "When false, disables session persistence to disk. Sessions **will not be saved to `~/.claude/projects/`** and cannot be resumed later." Subagent path spelled out at `:1005`: `~/.claude/projects/<dir>/<sessionId>/subagents/agent-<agentId>.jsonl`. (wrapper source) the resume-materialisation path reads `CLAUDE_CONFIG_DIR` from `options.env` first, then `process.env`, then `~/.claude` — so foundation §2.3's pinned `CLAUDE_CONFIG_DIR` is honoured **provided runner passes it in `options.env`**, which roster's compiler does. |
| Lookup is keyed by working directory | **confirmed** | `listSessions` (`:937-956`): "When `dir` is provided, returns sessions for that project directory **and its git worktrees**." §9.3's "a session whose `cwd` is gone cannot be resumed" stands; the worktree clause is a small mercy for projects' worktree workspaces. |
| `resume: <sessionId>` replays it | **confirmed** | `:1826-1829`. (wrapper source) becomes `--resume=<id>` on the child argv. |
| Sessions persist the conversation, not the working tree | **confirmed by absence** | Nothing persists filesystem state. `enableFileCheckpointing` + `Query.rewindFiles()` (`:1510`, `:2565`) exist as an **opt-in** that would, and DESIGN does not use them. Recorded: if §9.3's "half-applied edit" ever needs a real answer, this is it. |
| A new session id may be minted on resume | **A1 — confirmed by inference, verify live** | §1. |

Also **absent from DESIGN**, all exported helpers that beat reading the JSONL directly:
`listSessions()` `:956`, `getSessionInfo()` `:731` → `SDKSessionInfo` (`:4605`: `sessionId`,
`summary`, `lastModified`, `fileSize?`, `firstPrompt?`, `gitBranch?`, `cwd?`, `createdAt?`),
`deleteSession()` `:532`, `renameSession()` `:2677`, `forkSession()` `:702`. `getSessionInfo` is a
cheap resumability pre-check for §9.4's "is this still resumable?" affordance — it answers
"does the SDK still have this session, under this cwd?" without runner parsing anything.

---

## 9. Process, environment, and error surfaces (DESIGN §3.2, §3.4, §6.1)

### 9.1 Child process

(wrapper source) Each `query()` spawns one child (`node`/`bun` + the platform `claude` binary, or the
native binary directly) with `{command, args, cwd, env, signal}`. **confirmed**: one subprocess per
`query()`, hence per session.

- **`env` replaces the child environment entirely** (`:1461-1477`) — **confirmed**, same as roster's
  finding. The wrapper additionally, unconditionally: sets `CLAUDE_CODE_ENTRYPOINT=sdk-ts` if unset,
  and **`delete env.NODE_OPTIONS`**. Worth knowing for foundation's process-env spread.
- **~1 GiB RSS per session** (DESIGN §6.1) — **unverified**; no such statement exists anywhere in
  the package. The 320 MB binary is a floor for the mapped image, not a measurement. §6.1's cap of 2
  is justified independently by the shared rate-limit window (D2), so nothing collapses — but the
  number should be measured at M3 rather than cited as verified. Gap **G9**.
- **No top-level session timeout** — **confirmed by absence**: `Options` has no timeout field; the
  only one in the package is `startup({initializeTimeoutMs})` (`:7651`). §12's
  `wallClockMaxMinutes` is genuinely runner's to own.
- `startup()` (`:7645-7658`) — "Pre-warms the CLI subprocess so the first `query()` resolves
  immediately", returns a `WarmQuery`. **confirmed present**; §16's deferred optimisation is real.

### 9.2 stderr and diagnostics

- `Options.stderr?: (data: string) => void` (`:2026-2030`) — **confirmed**; also `debug?: boolean`
  and `debugFile?: string` (`:2013-2025`) as an alternative to piping debug through the callback.
- (wrapper source) **The transport keeps a redacted `stderrTail` regardless of the callback** and
  appends it to process-exit errors: `Claude Code process exited with code ${code}. stderr: ${tail}`
  and `Claude Code process terminated by signal ${sig}. stderr: ${tail}`. So DESIGN §3.2's
  "`failed` / `start_timeout`, with the captured `stderr` tail" is available even if the callback is
  never installed. **confirmed.**

### 9.3 What a failure actually looks like coming out of the generator

(wrapper source), in order of precedence:

1. Spawn failure → `Failed to spawn Claude Code process: <msg>` (errorClass `spawn_failed`), or a
   `ReferenceError` with a "native CLI binary not found" message when the platform package is missing.
2. Non-zero exit / signal → the messages in §9.2 (errorClass `process_exited_nonzero` /
   `process_killed_by_signal`).
3. **But if an error `result` was the last message seen, the thrown error is replaced** with
   ``Claude Code returned an error result: ${text}`` (errorClass `error_result`), where `text` is
   `result.errors.join('; ')` for an error subtype. This is the precise mechanism behind DESIGN
   §4.1's "a single-shot `query()` yields the error result and then **throws**": the throw comes from
   the child exiting after stdin was closed, not from the result itself. **confirmed in mechanism.**
4. Aborted via `AbortController` → telemetry message `Claude Code process aborted by user`
   (errorClass `aborted`) — **confirmed**, and this is the misleading message DESIGN §4.2 warns about
   when the input iterable throws.
5. Deferred-spawn initialisation timeout → `Subprocess initialization did not complete within ${t}ms —
   check authentication and network connectivity`.

### 9.4 Auth failure (DESIGN §3.4)

**unverified** which of the above a missing/expired `CLAUDE_CODE_OAUTH_TOKEN` produces — that is the
engine's decision. What is **confirmed** to exist as an auth-failure vocabulary:

- `SDKAssistantMessageError` (`:3072`) includes **`'authentication_failed'`** and
  `'oauth_org_not_allowed'`, `'billing_error'`, **`'rate_limit'`**, `'overloaded'`, `'invalid_request'`,
  `'model_not_found'`, `'server_error'`, `'max_output_tokens'` — surfaced on
  `SDKAssistantMessage.error` and on `StopFailureHookInput.error`. **`'rate_limit'` here is a second,
  structured rate-limit signal** that §6.4 does not use (see G7).
- `SDKAuthStatusMessage` `{type:'auth_status', isAuthenticating, output: string[], error?}` (`:3074`).
- `SDKSystemMessage.apiKeySource: ApiKeySource` (`'user'|'project'|'org'|'temporary'|'oauth'`) —
  a positive read-out of which credential won, per session.

DESIGN §3.2's catch-all (no `init` within `runner.startTimeoutMs` → `failed` / `start_timeout` with
the stderr tail) covers every one of these shapes, so the design is safe either way; the live check
in §11 is about giving the user a *good message* rather than about correctness.

**One correction to §3.4's guard.** The SDK groups credential variables as a class:
`["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "AWS_BEARER_TOKEN_BEDROCK",
"ANTHROPIC_FOUNDRY_API_KEY", "ANTHROPIC_FOUNDRY_AUTH_TOKEN", "ANTHROPIC_AWS_API_KEY"]` (wrapper
source), alongside a base-URL class headed by `ANTHROPIC_BASE_URL`. §3.4 strips only
`ANTHROPIC_API_KEY` under `auth.mode: 'subscription'`; `ANTHROPIC_AUTH_TOKEN` inherited from the base
process environment would override the subscription just as silently. Gap **G10**: widen the strip
to the credential class (excluding `CLAUDE_CODE_OAUTH_TOKEN`), and warn on `ANTHROPIC_BASE_URL`.
Which of them actually wins is engine precedence and unverified — stripping is safe regardless.

---

## 10. Design contradictions and gaps

**Raised as design changes, per M0's acceptance. None of these were coded around.**

### C1 — `modelUsage` and `total_cost_usd` are cumulative per `query()` call and **reset on resume**

DESIGN §7.1 reconciles by writing "one adjustment row per model carrying the difference between
[`result.modelUsage`] and what has already been recorded **for this session**", so that "after each
result the `session_usage` rollup is *exactly* `modelUsage`". That is correct **within one `query()`
call** and wrong across DESIGN §9.4's first resume path, which reuses the **same session row** with a
new `query()`:

> "Cumulative across turns in streaming-input sessions… **resumed sessions start fresh**" (`:4546`).

After a pause/resume the new query's `modelUsage` restarts at zero. The §7.1 delta then goes
**negative**, and the rollup — specified as "exactly `modelUsage`" — would **shrink to the resumed
run's usage**, silently deleting the pre-pause spend from `session_usage` and, worse, from
`assignments.tokens_used` (incremented in the same transaction, §7.2), which is what the budget halt
reads. A parked-and-resumed session would gain budget back every time it parks.

The same lifecycle applies to `total_cost_usd`, so §7.3's `session_usage.cost_usd` must be
`Σ over runs (latest total_cost_usd of that run)`, never a sum across results and never the last
result's value alone.

**Required change (§7.1, §7.3, §2.4, and the `usage_events` schema of §3.5).** The reconciliation
baseline must be **per `query()` call ("run")**, not per session row:

- add a run discriminator (`run_seq` on `sessions`, or a `run_id` column on `usage_events`) and make
  the dedupe index `(session_id, run_id, message_id)`;
- reconcile as `delta = modelUsage_now − modelUsage_recorded_for_this_run`, and assert the delta is
  never negative (a negative delta means the run boundary was missed — that assertion is the whole
  point);
- §2.4's "Record turn-level usage" must read **`result.usage`** (which *is* per-turn) for a
  turn-grain figure, or a per-run difference of `modelUsage` — not `modelUsage` as a turn delta.

Also worth pinning while §7.1 is open: "crash/startup-error results may carry **zeroed** usage" —
reconciliation must skip an all-zero `modelUsage` rather than treat it as a correction to zero.

### C2 — "`AskUserQuestion` always reaches `canUseTool`, even with a matching allow rule" is contradicted

DESIGN §0 and §5.1 both state this as **[V]**, and the entire question bridge's primary source
depends on it. The SDK itself says the opposite for the `allowedTools` route (§5.3, wrapper source):

> "`canUseTool` will not be invoked for: `<names>`. **Bare `allowedTools` entries auto-approve the
> whole tool before the callback is consulted.** …Allow rules from settings files can also shadow the
> callback but are not visible here."

No exception for `AskUserQuestion` is stated, and the tool name appears nowhere in the wrapper. Since
roster's compiler emits the effective allow set as `allowedTools` (roster §6.1, §13), an agent whose
baseline allows `AskUserQuestion` by bare name would have its question bridge **silently disabled for
its own questions** — the exact failure mode the README names, arriving through a permission grant
that looks generous.

**Required change (§5.1, §5.6, and roster reconciliation).**

1. Downgrade §0's row and §5.1's first source from **[V]** to "reaches `canUseTool` **unless
   auto-approved first**", which is the same rule as every other tool — pleasingly, this makes §5.1's
   own reasoning uniform rather than special-cased.
2. Extend §5.6's launch-time detection: as well as `dontAsk`, runner must detect **bare
   `AskUserQuestion` in the compiled `allowedTools`** and emit the same non-fatal
   `session.diagnostic` with `questionBridge: 'degraded'`. It is a read of the compiled options, not
   a recomputation, so §1's boundary holds.
3. Raise to roster: `AskUserQuestion` should **never** be emitted as a bare `allowedTools` entry —
   it belongs in the `ask` bucket (which does reach the callback, and now arrives tagged with
   `matchedAskRule`, §5.1) or nowhere.

### C3 — Plan-window and plan-tier data **are** programmatically available

DESIGN §7.4 states as **[V]**: "there is no documented header, result subtype, or API for it", and
D3 states "there is no documented programmatic source for the subscription's plan tier or window
sizes". Both are false against 0.3.233 (§7.2, §4.1, §1/A4):

- `Query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()` returns five-hour, seven-day,
  per-model **utilization percentages and reset timestamps**, plus `subscription_type`;
- `AccountInfo.subscriptionType` gives the plan tier from `accountInfo()`;
- `rate_limit_event` is a **declared and documented** union member, not an undocumented one.

**What does not change**: D7's *conclusions* are still right, and for better reasons than the ones
stated. The method is named
`usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET` and its own doc says the **name will
change** when it stabilises — so a scheduler that depended on it would break on an SDK bump, which
is exactly what D7 refuses to accept. And the numbers still describe *the owner's whole plan*, not
AgentManager's share, so the UI still must not present them as headroom this app can spend.

**Required change (§7.4, D3, D7).** Correct the stated facts; keep the policy. Concretely:

- §7.4's table gains a fourth row: **plan-window utilization**, source `sdk-experimental`, honesty
  label `cli-reported`, "best-effort, unstable API, may vanish on an SDK bump";
- `GET /api/runner/usage` may carry a `plan` block (`five_hour`/`seven_day` utilization + `resetsAt`
  + `subscriptionType`) behind a config flag defaulting **off**, read once per session start rather
  than polled, and **no scheduling logic may read it** — the §6.4 cool-down stays driven by observed
  errors, unchanged;
- §7.4's `rate_limit_event` row drops "undocumented" and gains the typed shape, so the permissive
  parser is a version-drift guard rather than a shape guess;
- D3's "not tier-derived because there is no documented source" must be re-argued as "not
  tier-derived **because the tier does not tell us what share of the window is ours**" — which is
  the real reason and survives the SDK exposing the tier.

### Gaps — things DESIGN does not say that this version makes it necessary to say

| # | Gap | Where |
|---|---|---|
| **G1** | `SDKUserMessageReplay` (`isReplay: true`) arrives on every `resume` carrying the whole prior conversation. The transcript writer and `session.message` mapper must filter it, or a resumed session duplicates its history. | §8.1, §10, §9.4 |
| **G2** | There are no `tool_use` / `tool_result` **message types** — they are content blocks, with the structured twin on `SDKUserMessage.tool_use_result`. §8.1's line vocabulary needs an explicit "derived by runner from content blocks" note. | §8.1 |
| **G3** | `sessionId` and `resume`/`continue` are **mutually exclusive** unless `forkSession` is set (`:1830-1835`); `continue` and `resume` are mutually exclusive (`:1409-1411`). §3.3's whitelist lists `resume` / `sessionId` together — the launch chain must set at most one. | §3.3, §9.4 |
| **G4** | `interrupt()` returns a receipt whose `still_queued` lists async user messages that **survive the interrupt** (capability `interrupt_receipt_v1`; `interrupt_cancel_queued_v1` allows cancelling them). A queued steer can outlive the interrupt that was meant to supersede it, and outlive a park or a shutdown. Runner must read `init.capabilities` and handle the receipt. | §4.3, §5.4, §9.1 |
| **G5** | `canUseTool` returning `null`/`undefined` is **fail-closed with no deadline** — the tool blocks forever. The adapter must be total; state the invariant and test it. | §5.1, §5.3 |
| **G6** | Every session will emit a Node `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` process warning (roster emits bare `allowedTools` names, runner sets `canUseTool`). Filter it into `core.log` at `debug` instead of letting it print per launch. | §3.4, §5.1 |
| **G7** | `result.terminal_reason` (19 typed members incl. `'blocking_limit'`, `'rapid_refill_breaker'`) and `SDKAssistantMessage.error === 'rate_limit'` are structured rate-limit signals. §6.4's classification should read them before falling back to error text. | §6.4, §2.3 |
| **G8** | `maxBudgetUsd` is per-`query()`-call, so each resume grants a fresh dollar allowance. §7.2 should say so — it is an argument for the per-assignment token budget, not against it. | §7.2 |
| **G9** | "~1 GiB RSS per session" is cited as **[V]** and appears nowhere in the SDK. Measure at M3 or restate §6.1's cap as justified by the shared rate-limit window alone. | §6.1, §2.1, D3 |
| **G10** | §3.4 strips only `ANTHROPIC_API_KEY`; the SDK treats `ANTHROPIC_AUTH_TOKEN`, `AWS_BEARER_TOKEN_BEDROCK`, `ANTHROPIC_FOUNDRY_*`, `ANTHROPIC_AWS_API_KEY` as the same credential class, and `ANTHROPIC_BASE_URL` redirects the endpoint. Widen the strip and warn on the base URL. | §3.4 |

---

## 11. Live verification pending

**Nothing in §1–§9 marked *confirmed* depends on an item in this list.** Everything here is either
engine behaviour (bytecode) or a runtime observation, and every item is encoded as a ready-to-run
test in `src/modules/runner/__spike__/sdk.spike.test.ts`, which skips itself unless
`CLAUDE_CODE_OAUTH_TOKEN` is present. Column "blocks" names the milestone that must not ship without
the answer.

| # | Must be confirmed live | Blocks | Why it cannot be settled statically |
|---|---|---|---|
| L1 | A plain `resume` (no `forkSession`) keeps the same `session_id` in `init` and in every `result`. | M3 / M9 (§9.4) | Inferred from the `forkSession` doc only. If it mints a new id, §9.4's "same row" path must update `sdk_session_id` and both ids go in `session.resumed`. |
| L2 | The message sequence after `interrupt()`: which messages arrive, whether the truncated assistant message carries `aborted: true`, and **what `result.subtype` / `terminal_reason` the interrupted turn produces**. | M6 (§4.3), M9 (§9.1) | Not declared. §2.2 must map the subtype to `interrupted`, not `failed`. |
| L3 | `init.capabilities` on this CLI: is `interrupt_receipt_v1` / `interrupt_cancel_queued_v1` advertised, and does a queued steer actually survive an `interrupt()`? | M6 (G4) | Capability set is per-CLI-build and only visible at runtime. |
| L4 | `canUseTool` fires for a non-auto-approved tool; a call held **60 s** resolves correctly and execution really was paused; an `allow` echoing `updatedInput` is accepted. | M3 / M7 (§5.3) | Wrapper shows no timeout; the engine's behaviour is unobserved. |
| L5 | `AskUserQuestion` reaches `canUseTool`, and the `{questions, answers}` `updatedInput` round-trips — **the model's next content is written as though it received the answer**. Multi-select as a comma-separated string. | M7 (§5.3, C2) | The tool is entirely engine-side; the `answers` key is declared but its round-trip is not. |
| L6 | With `AskUserQuestion` bare in `allowedTools`, `canUseTool` is **not** called for it (C2), and the `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` warning fires. | M7 (C2) | The exception, if any, is engine-side. This test decides whether C2 is a correction or a false alarm. |
| L7 | `permissionMode: 'dontAsk'` skips `canUseTool` and denies, emitting `permission_denied` with `decision_reason_type: 'mode'` and recording it in `result.permission_denials`. | M7 (§5.6, roster #20) | Documentation-level only in both spikes. |
| L8 | `hooks` (`PreToolUse`) and `canUseTool` on one session: both fire, hook first, neither suppressed; and a hook returning `permissionDecision: 'defer'` ends the query with `deferred_tool_use` set and `terminal_reason: 'tool_deferred'`. | M7 (A3), §16 | Ordering and defer semantics are engine-side. |
| L9 | Exactly one `result` per turn in streaming mode, and which messages arrive **after** it (`session_state_changed: 'idle'`, others) before the generator completes. | M3 (§2.4) | Engine emission order. |
| L10 | `modelUsage` / `total_cost_usd` are cumulative across turns within one `query()`, and **restart at zero** after a `resume` — the empirical basis for C1's fix. | M4 (C1) | Documented but must be seen before the schema change is trusted. |
| L11 | Parallel tool calls emit several assistant messages sharing `message.id` with **identical** usage, and per-step `output_tokens` is a placeholder. | M4 (§7.1) | Only the shared-id half is declared. |
| L12 | Auth failure: with no token, does `query()` throw, or emit an error `result`, or an `auth_status` / `assistant.error: 'authentication_failed'` — and what reaches `stderr`? | M3 (§3.2, §3.4) | Engine-side. Determines whether the user gets "point at `Setup-Auth.ps1`" or a generic timeout. |
| L13 | Whether `rate_limit_event` is ever observed on a subscription session, and whether `usage_EXPERIMENTAL_…()` returns non-null `rate_limits` under `CLAUDE_CODE_OAUTH_TOKEN`. | M11 (§7.4, C3) | Emission is server-driven. |
| L14 | Session JSONL really lands under the `CLAUDE_CONFIG_DIR` runner passes in `options.env` (foundation §2.3's path), not under `~/.claude`. | M3 / M9 (§9.3) | Wrapper reads it for resume; the **writer** is the engine. If this fails, resume after a core restart fails with it. |
| L15 | A session killed mid-tool-call: does `resume` work, and does the SDK transcript show the dangling `tool_use`? | M9 (A6, §9.3) | Engine + timing. |
| L16 | Peak RSS of one `claude` child across a real session (G9). | M5 (§6.1) | Not a declaration. |

---

## 12. Implementation notes (no design impact)

- **The committed CI check** required by M0's acceptance is
  `src/modules/runner/__spike__/sdk.spike.test.ts`. Its first `describe` block always runs and fails
  `npm run ci` if any SDK option, `Query` method, message-type discriminant, `result` subtype, or
  `PermissionResult` shape runner depends on is absent from the pinned `sdk.d.ts`, and if
  `package.json`'s SDK dependency stops being the exact string these notes were verified against.
  The second block is `describe.skipIf(no token)` and encodes §11 verbatim. *Deviation from M0's
  third acceptance bullet, which asks for the spike under `scripts/spikes/`: it lives under
  `src/modules/runner/__spike__/` instead so the surface check runs in CI on every commit. It is a
  leaf — nothing in `src/` imports it — and `tsconfig.build.json` excludes `src/**/*.test.ts`, so it
  is never built into `dist/`.*
- **Type-name collisions to alias when runner starts importing**: the SDK exports `Query`,
  `Options`, `PermissionResult`, and `AgentDefinition` — the last already flagged by roster. Runner
  additionally collides on `Options` (foundation's config shapes) and on `ExitReason` (`:632`, the
  SDK's is `'clear'|'resume'|'logout'|'prompt_input_exit'|'other'|'bypass_permissions_disabled'` and
  has nothing to do with §2.3's `exit_reason` vocabulary). Import the SDK's under aliases.
- **`Options.toolConfig.askUserQuestion.previewFormat`** (`:1512-1521`) exists; the question card's
  `preview` field (`sdk-tools.d.ts`) can therefore carry HTML. Not needed for v1, relevant to UI later.
- `betas?: SdkBeta[]` (`:1533`), `outputFormat?: OutputFormat` with
  `JsonSchemaOutputFormat` (`:932`), `sandbox?: SandboxSettings` (`:1936`), `toolAliases?` (`:1447`),
  and `sessionStore?: SessionStore` (`:1624`, `@alpha`) are all present — the §16 deferred items are
  deferrals of real features, not of hopes.
- **`npm install` in a fresh worktree needs `--ignore-scripts`** on Node 25 (`better-sqlite3` runs
  `node-gyp rebuild` despite shipping prebuilt binaries). Unchanged from roster's note; repeated
  because it blocks a clean runner worktree too.
