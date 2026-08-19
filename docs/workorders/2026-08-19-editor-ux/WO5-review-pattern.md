# WO5 — Ship the review pattern: a team that implements, not only agrees

**Elements:** orchestrator (pattern, validate, config, prompts), ui (Start-work offering).
**Amends:** orchestrator `DESIGN.md` — the "Review loop … deliberately not shipped in v1"
paragraph (~L728-733) becomes the shipped spec; config table; ui `DESIGN.md` §6 (teamwork
options). **Run after WO2/WO4 are merged** (shares `web/src/startwork/`).

## The incident (owner report, 2026-08-19)

A four-agent run (architect, skeptic, implementer, reviewer) ended after round two having
produced one document saying "the seats agreed" — nothing implemented, no questions asked. Root
cause analysis (from code, not conjecture): `PATTERNS = [solo, pair, overseer]`
(`patterns.ts:888`) — no pattern has more than two seats, `overseer` has **one** (the lead,
`write: false`, `patterns.ts:638-640`); the UI's "team" seats only the lead and demotes the other
agents to a goal-text suggestion (`StartWork.tsx:659-673`, `model.ts:209-228`); the pair's
terminal condition is literally "critic accepts the artifact document" (`patterns.ts:583-589`)
and neither pair prompt contains the word "implement" (`prompt.ts:356-405`). The run *succeeded*
at the only thing any pattern is built to produce: an agreed document.

## The fix: `review` — implementer ↔ reviewer over real changes

Build the pattern DESIGN.md already sketches, following `PAIR_PATTERN` as the structural
template (`patterns.ts`):

- **Seats:** `implementer` (write: **true**) and `reviewer` (write: false). Two members
  required — and add the member-count validation `pair` is missing while you are here: both
  `pair` and `review` refuse a third member with a named reason (today extra pair members are
  silently inert rows — `validate.ts:200-317` caps only overseer). Role fit stays a warning,
  never a gate (owner decision 2026-08-18: capabilities are hints).
- **Rounds:** implementer turn → reviewer turn = one round; reviewer is the round-closing seat.
  Reviewer reports the existing verdict shape (`accept` / `revise` + blocking list);
  `revise` plans the implementer again with the blocking list in the handoff; converged =
  `accept` + empty blocking. `roundCap` default 3, max 6 — mirror `patterns.pair` config keys
  under `patterns.review` (`config.ts:178-179` idiom).
- **The deliverable is the working tree, not a document.** `requires.artifactPath: false`;
  `scope.artifactPath` optional (a doc-plus-code run may still declare one). The implementer's
  intent sentences must say the work is making the change in the workspace (code, tests) and
  that a turn that changes nothing will be challenged; the reviewer's must say to review the
  actual changes (diff/files), not to negotiate prose. Analogue of WO2's artifact guard: if the
  implementer reports with a clean working tree (the engine already hashes artifacts — use the
  cheapest honest signal available, e.g. workspace `git status` via the existing turn-summary
  plumbing if present; if no such signal exists cheaply, re-plan once with an
  `implementation_missing` intent mirroring `artifact_missing` at `patterns.ts:527-550`, driven
  by the reviewer's blocking report instead of a hash).
- **Prompts:** follow `prompt.ts`'s existing seat-intent structure (`prompt.ts:356-405`) —
  add implementer/reviewer intent sentences; the convergence sentence names the reviewer's
  accept. Keep every existing prompt invariant (tooling guardrail, report_status close).
- **Start-work:** `teamworkOptions` (`web/src/startwork/model.ts:44-48`) offers
  `count===2 → ['pair','review','independent']`, with one-line copy distinguishing them: pair
  drafts and critiques *a document*; review *implements and reviews the change*. Seat mapping
  follows the pattern's declared seats (first agent implements, second reviews, swappable like
  pair's seats today).

## Out of scope (say so in the DESIGN amendment)

A 4-seat plan-then-build pattern (architect+skeptic → implementer+reviewer) stays deferred;
WO6's handoff covers the composition instead (a converged pair can hand its artifact to a review
assignment). Engine changes beyond registering the pattern should not be needed — if you find
one that is, stop and report.

## Acceptance tests

- server (`--project server`, scoped to `src/modules/orchestrator`): pattern registry includes
  `review`; validate refuses 1 and 3 members for pair and review; a full simulated run
  (implement → revise → implement → accept) converges with rounds_used 2; role-mismatch is a
  warning not a refusal; config defaults respected; prompt snapshots contain the implementer
  "make the change in the workspace" sentence and the reviewer diff-review sentence.
- web (`--project web`, scoped to `web/src/startwork`): two agents offer pair, review,
  independent; choosing review posts `pattern: 'review'` with two seated members and no
  artifactPath by default.
