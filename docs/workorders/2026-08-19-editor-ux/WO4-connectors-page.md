# WO4 — The Connectors page: create once, assign to agents

**Elements:** ui (new page + nav + IntegrationsPanel attach flow); roster only as consumed via
WO3's routes. **Amends:** ui `DESIGN.md` §2.1 (route table — fourteen becomes fifteen), §2.2
(nav), §7.3.1 (the attach-from-library flow), new §8.x or standalone section for the page itself.
**Depends on WO3** (the API it renders).

**File ownership (conflict discipline):** this WO owns `web/src/agents/IntegrationsPanel.tsx`,
`integrationsModel.ts`, `web/src/App.tsx`, `web/src/app/AppFrame.tsx`, the new
`web/src/connectors/` folder, and `web/src/startwork/model.ts` chip retarget. It must **not**
edit `web/src/agents/AgentEditor.tsx` or `editorModel.ts` (WO2 owns them this wave) — the panel
already receives its data and callbacks; fetch the connector list inside the panel/page with the
app's normal query client.

## The page — `/connectors`

- Route in `App.tsx`, destination entry in `AppFrame.tsx DESTINATIONS` (label **Connectors**,
  a plug-ish sprite icon added to `web/src/icons/Sprite.tsx`), shell/route tests updated
  (`web/src/app/shell.test.tsx`, `web/test/routes.tsx`).
- **List**: one card per library connector — label (or id), transport, `mcp__<id>__*` prefix,
  credential badges (the existing `{ secretRef, resolved }` badge idiom incl. the
  `agentmanager secrets set <ref> --stdin` instruction), and **"used by"** as the referencing
  agents' names linking to `/agents/:id`. Empty state teaches: what a connector is, that agents
  can also carry one-off inline servers in their own editor.
- **Create / edit**: reuse the field idiom of `IntegrationCard` (name→id, transport select,
  command/args or URL, OAuth checkbox, credential rows with the secret toggle) against
  `POST/PATCH /api/roster/connectors`. The `.mcp.json` **paste-import moves up a level**: on this
  page it creates library connectors (same `mcpImport.ts` parsing and preview; the panel's
  per-agent import stays for one-offs).
- **Assign to agents…** on each card: a multi-select of roster agents (checked = already
  references it); confirming PATCHes each toggled agent's `integrations` — adding
  `{ connector: "<id>" }` under the connector id as key, or removing that entry. Use the ordinary
  agent `PATCH`; refuse (with an inline message, not a crash) when an agent already has a
  *different* server under that name.
- **Delete** surfaces WO3's 409 by listing the blocking agents as links.

## The agent editor's panel (`IntegrationsPanel.tsx`)

- **"Attach from library"**: a `<select>` of library connectors not yet attached; choosing one
  appends a **reference row** — compact card showing label, transport, prefix, credential badges,
  and "Managed on the Connectors page" linking there. A reference row has **Detach** and
  **Convert to inline copy** (materialises the config into the form for per-agent divergence);
  it is not otherwise editable here.
- `integrationsModel.ts`: `IntegrationForm` gains a ref variant (`{ kind: 'ref', name,
  connector }` or equivalent); `integrationsBody` emits `{ connector }` for it;
  `integrationsOf` parses the stored ref shape back. `integrationProblems` checks a ref's name
  the same as any server name and flags a dangling connector id (list fetched, not guessed).
- The `missing-connector` chip state from WO3 renders on Start-work with action → `/connectors`;
  also retarget the existing `missing-secret` chip action from `/settings` (which has no secrets
  UI) to `/connectors`, where the CLI instruction is actually shown.

## Docs

Beyond the sections named above, state the ownership rule in §7.3.1's amendment: the library
defines, the agent references; inline stays for one-offs; export inlines (WO3 §5) so nothing
here changes `.agentpack` behaviour from the UI's point of view.

## Acceptance tests (`--project web`, scoped to `web/src/connectors` + `web/src/agents` +
`web/src/app`)

- Route renders, nav entry present, shell/route invariants updated and green.
- List renders connectors with credential badges and used-by links from a mocked API.
- Create posts a valid body; a credential-shaped literal is warned in-field (same
  `integrationProblems` rules).
- Assign dialog: toggling an agent on posts a `PATCH` containing `{ connector: id }` under the
  id key; toggling off removes it; the name-collision refusal renders.
- Panel: attach-from-library appends a ref row that serialises to `{ connector }`; detach
  removes it; convert-to-inline replaces it with an editable card holding the fetched config.
- Chips: `missing-connector` labels and links to `/connectors`; `missing-secret` now links to
  `/connectors`.
