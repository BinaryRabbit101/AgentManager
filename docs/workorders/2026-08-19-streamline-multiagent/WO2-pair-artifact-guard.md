# WO2 — No critic turn without an artifact, and honest round display

**Element:** orchestrator (pattern + prompt), ui (round header). **Amends:**
`docs/orchestrator/DESIGN.md` §3.3 (the pair's turn table), §8.1 (`no_progress` family); ui
DESIGN's assignment-header section.

## The defect

In the observed run the drafter (Merritt) reported without ever creating the file at
`scope.artifactPath` — `git status` clean. `pairPattern.plan()`'s drafter-reported branch
(`patterns.ts` ~line 477) checks only `no_progress` (hash unchanged **between two** drafter
turns) and then plans the critic. With zero artifact there is nothing to critique; the critic's
entire turn — a quarter of the default budget's estimate — was spent discovering that, messaging
the drafter (undeliverable until next round), and reporting `revise`. The engine already computes
the evidence: `onSessionEnded` hashes the artifact (`hashArtifact`) and stores `artifactHash`
on the turn row; a missing file yields `null`.

Separately, the assignment header shows `Round 0 of 3` while round 1 is in flight
(`web/src/assignments/AssignmentPage.tsx` ~lines 160–167 print `roundsUsed` raw; it increments
only when the critic reports).

## The fix

### 1. Artifact guard in `pairPattern.plan()`

In the drafter-reported branch, **before** planning the critic: if `last.artifactHash === null`
(pattern config `requireArtifact: true`, the default):

- **First occurrence for that round:** re-plan the **drafter**, same round, `retryOf: last.id`,
  with a new prompt intent `artifact_missing` whose instruction is explicit: *"Your report was
  received but no file exists at `<artifactPath>`. Create that exact file with your draft and
  report again. A report without this file on disk will be sent back."* Reuse the
  `continuation()` helper so the seat resumes its own session.
- **Second consecutive occurrence:** `halt` with a new `HaltReason` `'no_artifact'` (add to the
  closed set, the halt-card copy, and DESIGN §8.1's table). Do not silently fall through to the
  critic.

Count occurrences with a pure helper in `breakers.ts` beside the other counters (re-derived from
turn rows: drafter turns of the round whose `artifactHash` is null and whose status is
`reported`).

### 2. Prompt hardening (`prompt.ts`)

- `draft` intent (~line 250): change to name the path and the consequence: *"Write the artifact
  file at `<artifactPath>` — create it if it does not exist. Your report is accepted only if that
  file exists on disk when you finish."*
- `revise` intent: same file-on-disk sentence appended.

### 3. Honest round header (web)

`AssignmentPage.tsx` + `conversation.ts` `roundPips`: when any turn is `planned`/`running`,
display `Round min(roundsUsed + 1, roundCap) of roundCap` and mark that pip as "in progress"
(distinct style from done); when idle/closed keep the raw count. Mirror in `AssignmentsPage.tsx`
and `UsageView.tsx` where the same raw value prints.

## Acceptance tests

- `patterns.test.ts`: drafter reported, `artifactHash: null` → drafter re-planned with
  `artifact_missing` intent and `retryOf`; second null in the same round → halt `no_artifact`;
  non-null hash → critic planned exactly as today.
- `prompt.test.ts`: `draft` and `revise` texts name the path and the file-on-disk condition;
  `artifact_missing` intent renders.
- Web tests: with a running round-1 turn and `roundsUsed: 0`, the header reads "Round 1 of 3"
  and pip 1 is in-progress; after the critic reports, `roundsUsed: 1` idle reads "Round 1 of 3"
  done.
