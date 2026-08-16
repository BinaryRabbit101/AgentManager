# Projects

The project registry — the things agents get pointed at.

## Responsibilities

- Schema and storage for projects: name, local path, repo URL, notes, per-project defaults (default agents, permission overrides, environment).
- Project discovery/registration (point at a folder, optionally clone from a repo URL).
- Tracking which agents are or have been active on a project, and session history per project.

## Depends on

Nothing at schema level; consumed by runner, orchestrator, and UI.

## Open questions for design

- Session history: how much transcript/state is retained per project, and where?
- Do projects carry work-item lists (bug reports, feature requests) that the orchestrator assigns from, or is assignment always prompt-driven?
- Multiple agents on one project simultaneously: shared working tree vs. per-agent worktrees?
