# WO6 — Convergence goes somewhere: ask-the-user prompting, seat honesty, plan→build handoff

**Elements:** orchestrator (prompt), ui (Start-work + assignment view). **Amends:** orchestrator
`DESIGN.md` (prompt composition section, completion card), ui `DESIGN.md` §6 (Start-work) and
§10 (assignment view). **Run after WO5** (the handoff's natural target includes the `review`
pattern; shares `web/src/startwork/`).

Same incident as WO5. Three compounding faults this WO fixes — each independently shippable:

## 1. Agents never ask the user anything — because nothing tells them to

`request_user_decision` is mounted for every seat (`toolset.ts:80-92`) but the composed prompt
mentions it only reactively, when soliciting a stance on an already-open card
(`prompt.ts:283-297`). Fix: one fixed paragraph in every composed prompt, beside the tooling
guardrail (`prompt.ts:85-90`) so it survives every degradation path, to the effect of:

> *"When the goal is ambiguous, or you face a consequential choice the goal does not settle
> (scope, approach, destructive action, external side effect), call `request_user_decision`
> rather than guessing — a wrong guess wastes the whole assignment, a question costs one card.
> Ask at most when it matters; you have a budget of 3 per session."*

Keep the budget number sourced from config (`maxDecisionsPerSession`, `config.ts:202`) rather
than hard-coded prose drift. Present for **every** pattern and seat, solo included.

## 2. Start-work tells the truth about seats

- With 3+ agents and "team" selected, the dialog states plainly, before submit: only the lead
  holds a seat; the other N agents are **suggestions** the lead may seat in child assignments —
  the same fact `suggestedWorkersLine` buries in goal prose (`model.ts:209-228`), surfaced as UI
  copy where the human decides.
- Stop sending `scope.artifactPath` when the chosen pattern declares
  `requires.artifactPath === false` — today `StartWork.tsx:683` sends the prefilled
  `DRAFT.md` path even for overseer, steering a team lead toward a markdown deliverable the
  pattern deliberately does not want (`patterns.ts:688-692`).

## 3. A converged plan can be handed to a build

When a **pair** converges, the result is an accepted document and the assignment closes; nothing
offers to act on it. Fix, deliberately UI-level (no engine auto-chaining — the human stays in the
loop):

- The assignment view (and the completion card, if it renders actions) for a `converged` pair
  whose `scope.artifactPath` is set gains **"Start work from this artifact…"** — it opens the
  ordinary Start-work flow (the existing `StartWorkIntent` store) prefilled with the same
  project, a goal template referencing the artifact (*"Implement the accepted plan at
  `<artifactPath>` (assignment <id>)"*), and no preselected agents. Choosing two agents +
  `review` (WO5) is then the natural build step; solo works too.
- No new server state: it is a navigation affordance over data the projection already carries
  (`phase: 'converged'`, `scope.artifactPath`). If the completion card cannot carry an action
  without server changes, ship it on the assignment view only and say so in the report.

## Acceptance tests

- server (scoped `src/modules/orchestrator`): prompt snapshot/tests — the ask-the-user paragraph
  present for every pattern including solo, with the configured decision budget interpolated.
- web (scoped `web/src/startwork`, `web/src/assignments`): team selection with 3 agents renders
  the only-the-lead-is-seated notice; overseer submit body carries no `artifactPath`; pair
  submit still carries it; a converged pair assignment with an artifactPath renders the
  start-from-artifact action and clicking it opens Start-work with the prefilled goal naming
  the path; a converged assignment without an artifactPath renders no such action.
