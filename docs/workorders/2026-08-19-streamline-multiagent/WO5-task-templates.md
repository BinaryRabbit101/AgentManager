# WO5 — Task templates: agents that do a *kind* of work, attachable in one pick

**Elements:** roster (storage, capabilities), orchestrator (creation prefill), ui (template
picker). **Amends:** roster `DESIGN.md` (new section: task templates); orchestrator `DESIGN.md`
§2 (creation); ui DESIGN's Start-work section. **Depends on WO4** (the start flow this plugs
into).

## The ask (owner's words)

> "We also should be able to attach agents that design specifically for example updating todo
> ticket replies, drafting emails, etc."

Today an assignment is described from scratch every time. Recurring, non-code work — answer the
open todo tickets, draft replies to a mailbox, triage issues — should be one pick: a **task
template** that carries the task's shape, so any capable agent can be attached to it.

## Design

A template is a reusable prefill of the Start-work flow, plus the checks that make it safe:

```jsonc
// library/templates/<slug>/template.json  — file-based, like agents, for the same
// reason agents are: shareable, diffable, seedable (roster DESIGN §2's rationale)
{
  "schemaVersion": 1,
  "id": "todo-ticket-replies",
  "name": "Reply to todo tickets",
  "description": "Read open tickets, draft a reply per ticket, file them for review.",
  "pattern": "solo",                        // or "pair" for reviewed drafting
  "goalTemplate": "Work the open items in {{source}}: draft a reply for each, …",
  "artifactPathTemplate": "docs/assignments/{{slug}}/replies.md",
  "write": true,
  "requiredIntegrations": ["todo-mcp"],     // MCP connector ids the seated agent must carry
  "suggestedRoles": ["implementer"],        // ranking hint only — never a gate (owner
                                            // decision 2026-08-18: capabilities rank, not gate)
  "preGrantTools": ["Bash"]                 // feeds WO4's assignment-scoped pre-grants
}
```

Decisions, consistent with the existing record:

- **Storage: the library, file-based.** A `templates/` sibling of the agent folders, watched and
  indexed the same way (roster owns it). Foundation's storage decision applies; no new database
  concept beyond an index table if the existing library indexing needs one.
- **Templates suggest, never gate.** `requiredIntegrations` produces a **warning chip** in the
  picker when the chosen agent lacks the connector, with a link into the MCP integrations editor
  (commit `db168cc`) to add it — mirroring how seat candidates rank but never filter.
- **Templates are data, not code paths.** Applying one only prefills the creation call WO4
  defines (goal, pattern, artifactPath, preGrants). Orchestrator's creation API gains nothing
  but an optional `templateId` recorded for provenance.
- **Seeding.** Ship two starter templates behind roster's existing seed mechanism (`seed.ts`):
  "Reply to todo tickets" and "Draft email replies", both `solo` by default. Editions do not
  differ (D6).

## Scope of v1

- CRUD: list and read via roster routes (`GET /api/roster/templates`,
  `GET /api/roster/templates/:id`). Create/edit via the library folder (file-first, like agents
  before the editor existed); an editor UI is explicitly **out of scope**.
- Start-work: a template strip at the top of the dialog (blank card first). Picking one prefills
  everything; the user still picks the project and the agent(s), sees the WO4 gate chips, and
  can edit any field.
- Template variables: `{{slug}}` and `{{source}}` only; `{{source}}` renders as one extra input
  in the dialog when present in the template. No general templating engine.

## Acceptance tests

- Roster: templates in the library folder appear in the index and the list route; a malformed
  template is reported like a malformed agent (same diagnostics path), never crashes the load.
- Roster: the integrations check answers "agent X lacks connector Y" as data for the UI.
- Orchestrator: creation with `templateId` records it; the assignment behaves identically to a
  hand-filled one.
- Web: picking a template prefills goal/pattern/artifact; a missing-connector warning renders
  with the editor link; blank card keeps today's flow exactly.
- Seed: a fresh library gets both starter templates once, and reseeding does not duplicate them.
