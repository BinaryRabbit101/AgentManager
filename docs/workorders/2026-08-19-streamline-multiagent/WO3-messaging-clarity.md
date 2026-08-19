# WO3 — Messages must read true, to the user and to the agents

**Element:** ui (labels), orchestrator (prompt preamble). **Amends:** orchestrator
`DESIGN.md` §5 (delivery table prose), §10.2 (conversation labels); ui DESIGN's conversation
section.

## The defect

Two truths about the mailbox were invisible in the observed run:

1. **To the user:** Dana's question to Merritt was labelled **"never seen by the recipient"**
   while the assignment was still running. The data model distinguishes `undelivered` (pending —
   will be inlined at the recipient's next launch) from `undeliverable` (assignment closed, never
   arrived), but `web/src/assignments/conversation.ts` deliberately renders both with the same
   label. While a next turn is still possible the label is simply false, and it made a working
   mechanism look broken.
2. **To the agents:** the sequential driver can never deliver a reply mid-turn (DESIGN §5's
   delivery table), but nothing in the composed prompt says so. Dana messaged Merritt, then
   *waited within the same turn* for a reply that could not come, then reported failure partly on
   that basis. Agents must be told the mailbox's tempo so they write self-sufficient handoffs.

## The fix

### 1. Split the labels (web)

In `web/src/assignments/conversation.ts` (and the types in `web/src/api/types.ts` ~line 604):

- `undelivered` **in an open assignment** → label **"waiting — delivered at ‹recipient›'s next
  turn"** (use the seat/agent name already present on the message row).
- `undeliverable`, and `undelivered` in a closed assignment → keep **"never seen by the
  recipient"**.

The conversation view already knows the assignment's phase/status; no new API surface. Update the
docstrings that currently assert the two must render identically.

### 2. Tell the agents the tempo (orchestrator, `prompt.ts`)

Add one fixed sentence to the pattern preamble for every multi-seat pattern (pair, overseer),
near the mailbox block (§3.2's numbered prompt layout, item 4):

> "Messages you send are delivered when the recipient's next turn starts — never mid-turn. Do not
> wait for a reply in this turn: put everything the recipient needs into the message, finish your
> own work, and report."

Keep it in one place (a constant beside the mailbox inlining) so both patterns share it.

### 3. `send_to_agent` result (verify only)

The tool already answers `recipientWillSeeIt: "at its next turn in this assignment"` (DESIGN
§4 tool table). Verify the toolset really returns it and that the wording matches the preamble;
fix drift if any. No new behaviour.

## Acceptance tests

- Web `conversation` tests: an `undelivered` message in an open assignment renders the waiting
  label with the recipient's name; the same message after close renders "never seen by the
  recipient"; `undeliverable` always renders "never seen".
- `prompt.test.ts`: pair and overseer prompts contain the tempo sentence exactly once; solo
  prompts do not contain it.
- `toolset.test.ts`: `send_to_agent` result includes `recipientWillSeeIt`.
