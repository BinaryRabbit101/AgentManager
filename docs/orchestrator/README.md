# Orchestrator

App-level coordination between roster agents (architecture D4) — AgentManager's equivalent of munder-difflin's "Michael." The largest v1 scope item.

## Responsibilities

- Inter-agent messaging: mailboxes, message schema, delivery.
- Work routing: an overseer agent (e.g. a Fable-powered roster member) receives goals, decomposes them, and assigns tasks to worker agents; the orchestrator carries those assignments.
- Collaboration patterns: multiple agents on one project working a shared goal, not just parallel solo tasks. First-class v1 pattern: an **adversarial pair** — e.g. an architect drafts a plan or doc and a skeptic critiques it, iterating until converged or a round limit hits, with the transcript of their exchange preserved for the user. The design should define patterns as reusable shapes (pair, review loop, overseer + workers) rather than hard-coding one.
- Assignments: the unit of orchestrated work is agent(s) × project × **scope** (a portion of the project — a subsystem, path set, or goal). Multiple assignments with different shapes run concurrently on one project: a solo agent designing one piece while a pair works another. Assignment schema, scoping, and conflict awareness between concurrent assignments belong here.
- **Every session belongs to an assignment** — a plain drag-and-drop solo launch is just the trivial assignment (one agent, whole-project scope, no pattern). One schema means budgets, scope, question attribution, and the UI treat solo and collaborative work uniformly instead of as two systems.
- User question aggregation: when agents in a collaboration need user input, the orchestrator consolidates it into one question card — **which agent(s) are asking**, each agent's recommended answer with a confidence weight, and where they agree vs. disagree — rather than two competing raw prompts.
- Token budgets: collaboration loops multiply spend, so patterns must be token-mindful by construction — per-assignment token budgets and round caps, cheaper models for critique/secondary roles where sensible, and a halt-and-ask when a budget is exceeded. Consumes runner's per-session accounting.
- Status aggregation: knowing what every agent is doing, surfacing it to the UI.
- Guardrails: circuit breakers for runaway agents, human approval gates for critical operations.

## Depends on

roster, projects, runner. Consumed heavily by ui.

## Open questions for design

- Is routing decided by an LLM overseer agent, deterministic rules, or both (overseer proposes, rules enforce)?
- Message transport: atomic files (munder-difflin's hive style) vs. in-process queue with persistence?
- How does a worker report completion, and how does the overseer verify it?
- What exactly triggers a circuit breaker or approval gate in v1?
- How is the user notified when they're away — an approval gate is worthless if nobody sees it for six hours. What's the notification channel (push to phone, tailnet browser notification, email?), and does it live here, in remote, or in ui?
- Minimum viable v1 slice of this element (it is the biggest — design should stage it). Candidate: the adversarial pair on a docs/planning task — it exercises messaging, turn-taking, and convergence without needing full work decomposition, and planning output is low-risk compared to two agents editing code concurrently.
- Convergence control for agent-vs-agent loops: who decides "done" — a round cap, the overseer, or the user? Two LLMs critiquing each other can loop politely forever.
- How are recommendation weights produced? Self-reported confidence from an LLM is poorly calibrated — options include forced-choice with strength labels, stake-based framing, or simple per-agent stances without numeric confidence. The design should pick something honest rather than precise-looking.
- Is an assignment's scope advisory (stated in the prompt) or enforced (permission rules restricting paths)? Enforcement matters once concurrent assignments touch the same repo.
