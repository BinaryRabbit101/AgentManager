# Work orders — agent editor UX + connector library (2026-08-19, second batch)

## Why this exists

Owner feedback after real use (2026-08-19, verbatim themes):

1. **"Options should be drop downs."** The agent editor renders `model.primary`, `model.fallback`
   and `model.effort` as free-text inputs even though the server holds closed or semi-closed sets
   (`MODEL_ALIASES`, `EFFORT_LEVELS` — the latter a hard Zod enum, so a fat-fingered effort is a
   400 the user cannot predict). → WO1.
2. **"Knowing what to write for allow, deny, ask is nearly impossible."** The permissions fieldset
   is three raw textareas, one rule per line, no examples, no validation. Meanwhile
   `PERMISSION_RULE_CATALOGUE` (`src/modules/roster/draft.ts:174-200`) already holds 20 curated
   `{ rule, description }` pairs — fed to Claude during drafting, never shown to the human. → WO2.
3. **"Role addenda — haven't found a need for this or I don't know how or when to use it."** All
   five textareas always render, with no explanation of when an addendum is ever read (only when
   the orchestrator seats the agent in a collaboration role). Keep the feature, fix the
   presentation and the teaching. → folded into WO1.
4. **"New connections should be created on a Connectors page and then assigned to agents — this is
   currently very manually entered and work has a lot of connectors."** Today `integrations` is
   per-agent only; two agents needing the same server each hand-enter the full config, and the only
   entry point is nested inside the agent editor. → WO3 (library + refs, backend) and WO4 (page +
   assignment UI).

## The work orders

| # | Doc | Element(s) | Depends on |
|---|-----|-----------|------------|
| WO1 | `WO1-editor-pickers.md` | ui | — |
| WO2 | `WO2-permission-builder.md` | roster, ui | WO1 (same file, sequenced to avoid conflicts) |
| WO3 | `WO3-connector-library.md` | roster | — |
| WO4 | `WO4-connectors-page.md` | ui, roster (routes only) | WO3 |

Waves: WO1 ∥ WO3 first (disjoint files: WO1 is web-only, WO3 is server-only), then WO2 ∥ WO4.
WO2 and WO4 both touch `web/src/agents/` — WO2 owns `AgentEditor.tsx`/`editorModel.ts`, WO4 owns
`IntegrationsPanel.tsx`/`integrationsModel.ts` and must not edit `AgentEditor.tsx` beyond what its
doc explicitly allows.

## Rules for every implementing agent

- Conform to `docs/architecture.md` D1–D6. Nothing here forks an edition (D6) or adds a second
  frontend (D3).
- Each WO names the element DESIGN.md sections it amends. **Update the design doc in the same
  change as the code** — a WO is an instruction to amend the spec, not to diverge from it.
- Tests are part of the deliverable. Run the scoped vitest projects, not the full suite.
- Secrets posture is untouchable: no HTTP route accepts or returns a secret **value** anywhere in
  this batch (foundation §3.5, roster §10).
- Keep to the WO's scope. If a WO conflicts with something you find in the code, stop and report
  rather than improvising.
