# Roster

Agent definitions — the "cloned people." Each agent is a persistent identity with a persona, specialty, and capabilities, independent of any project or session.

## Responsibilities

- Schema and storage for agent definitions: name, avatar, persona/system prompt, specialty (bug patching, feature implementation, email response, overseer, ...), model choice, allowed tools/permission mode, default skills.
- CRUD for agents; import/export of agent definitions; duplicate-and-edit as a first-class operation.
- Draft-from-description: an API the UI's agent wizard calls that uses Claude to generate a persona, specialty, and suggested permissions from a short description (see ui's drafting wizard).
- Distinguishing worker agents from overseer-capable agents (what extra powers an overseer definition carries).

## Depends on

Nothing — this is the foundational schema. Runner, orchestrator, and UI all consume it.

## Open questions for design

- File-based (one folder per agent, markdown persona + JSON config) vs. database storage? File-based plays well with git-versioning the roster.
- How do roster-level tool permissions compose with per-project permission settings?
- Is the persona a system-prompt append, a full replacement, or a Claude Code output style?
- How are agent-specific skills packaged (per-agent `.claude/skills`-style folders?)?
- How do agents get external integrations — e.g. the email-responder specialty needs mailbox access. Does the roster schema carry per-agent MCP server configs (Gmail/Outlook MCP, etc.), and where do those servers' credentials live (coordinate with foundation's secrets decision)?
