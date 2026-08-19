# WO7 — Token economy: pay seat prices, not flagship prices

**Elements:** orchestrator (pattern config, projection), roster (compile defaults), ui (Start-work
cost line, Usage breakdown). **Amends:** orchestrator `DESIGN.md` §3 (pattern config), §7
(budgets/projection), §12 (config table); roster `DESIGN.md` §8 (model) and §11 (defaults); ui
DESIGN's Usage section. **Independent of WO4–WO6** (touches different surfaces; merge-order free).

## The premise

Assignment cost is `sessions × turns-per-session × price-per-token`, and today only the first
factor is managed. Every seat runs its agent's full model; a session may loop up to
`maxTurns: 60` (overseer lead: **200**) before any assignment-level breaker is consulted —
breakers evaluate *between* turns only; and the default pair budget (400k) is sized for the worst
case, so the worst case is what a silent run can spend.

## The fix

### 1. Per-seat model and effort overrides (orchestrator + roster)

`pattern_config_json` gains optional `seatOverrides: { [seatKey]: { model?, effort? } }`,
validated warn-not-block exactly like roster §8 (an unrecognised model is a diagnostic, not a
refusal). The engine passes the override through the launch input; roster's `compileSession`
prefers it over `definition.model.primary` for that session only — the agent's identity is
unchanged, one turn ran cheaper. Config ships **no default overrides** (behaviour identical
until a user or template sets one); WO5 templates may carry them (e.g. critic on a small model).

### 2. Tighter pattern-turn defaults (roster)

For sessions launched *by the engine* (origin: pattern turn), default `maxTurns` drops from 60
to **25**, overseer lead from 200 to **80** — a seat-turn is one draft or one critique, not an
open-ended solo. Per-agent `defaults.maxTurns` still wins. Solo/user-launched sessions keep 60.
Config knobs beside the existing ones; DESIGN records the rationale.

### 3. Right-size the default pair budget (orchestrator)

`budgets.defaultPairTokens` 400_000 → **150_000**. The budget card (§7.3 raise/stop) is the
escape hatch and already works; the default should price the *normal* case. Update the
projection copy so the card suggests the raise amount.

### 4. Seat-priced projection and visible cost (orchestrator + ui)

The creation projection (`validate.ts` §9-9) prices each seat by its effective model tier
(flat multipliers in config, e.g. small ×0.2, mid ×1, flagship ×5 — crude and labelled as such,
like `turnEstimateTokens`). Start-work shows the projected number before launch. The Usage view
adds a per-seat/per-model breakdown and, per round, **tokens spent vs. artifact hash changed** —
the waste detector that would have flagged the 2026-08-19 incident in one glance.

## Acceptance tests

- Orchestrator: seatOverrides validate (unknown seat = error, unknown model = warning);
  launch input carries the override; projection multiplies by tier.
- Roster: compile prefers the seat override for that session only; pattern-turn maxTurns
  defaults apply only to engine-origin sessions.
- UI: Start-work renders the projected cost; Usage renders the per-seat breakdown and the
  per-round tokens/artifact-delta column.
- Config: new knobs in defaults.json + schema, DESIGN §12 table updated.
