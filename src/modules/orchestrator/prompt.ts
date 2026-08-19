/**
 * Prompt composition — DESIGN §3.2's seven sections, IMPLEMENTATION M5-4.
 *
 * ```
 * 1. Goal and scope     assignment.goal, scope description, artifact path, write/read posture
 * 2. Your seat         "You are the skeptic in an adversarial pair. Round 2 of 3."
 * 3. The handoff        the counterpart's last report headline + output excerpt (bounded)
 * 4. Unread mail        up to mailbox.inlineMax messages, oldest first, then "N older — call read_mailbox"
 * 5. Open decisions     any open question card for this assignment + how to state a stance (§6.4)
 * 6. Termination rules  rounds remaining, budget remaining, what convergence means here
 * 7. Required close     "Before you finish, call mcp__agentmanager__report_status with your verdict."
 * ```
 *
 * "Sections 3–5 are the only dynamic parts; templates live in code and are not
 * user-editable in v1."
 *
 * Section 2 carries one extra fixed line on a multi-seat pattern: `MAILBOX_TEMPO`,
 * which tells the seat when the mail it sends actually arrives (§5.1). See the
 * constant for why it is there rather than in section 4.
 *
 * ## The byte cap is enforced by dropping, not by slicing
 *
 * `orchestrator.prompt.maxBytes` (16 KB) is a hard ceiling, and the sections are
 * not equally disposable: sections 1, 2, 6 and 7 are what makes the turn
 * *correct* — the goal, the seat, the termination rules and the instruction to
 * report — while 3, 4 and 5 are context. So an over-long prompt loses the
 * excerpt, then the mail bodies, then the decisions, each replaced by an honest
 * one-line marker, and only a pathological goal reaches the final slice. Silently
 * truncating mid-sentence at 16 KB would cut the *required close* off the end,
 * which is the one line the convergence rule depends on.
 */
import type { ChildState, PromptSpec } from './patterns.js';
import type { InlinedMail } from './messages.js';
import type { AssignmentScope } from './types.js';

/** The `mcp__agentmanager__*` names the prompt tells a seat to call (§4.3). */
export const REPORT_STATUS_TOOL = 'mcp__agentmanager__report_status';
export const READ_MAILBOX_TOOL = 'mcp__agentmanager__read_mailbox';
export const REQUEST_DECISION_TOOL = 'mcp__agentmanager__request_user_decision';
/** The two an overseer launch also mounts (§4.1's table, §3.5's decompose turn). */
export const CREATE_ASSIGNMENT_TOOL = 'mcp__agentmanager__create_assignment';
export const LIST_ROSTER_TOOL = 'mcp__agentmanager__list_roster';

/**
 * The mailbox's tempo, said out loud to every seat that shares an assignment.
 *
 * §5.1's delivery table is a fact about the driver, not about the agent's
 * intent: mail is inlined **at the recipient's next launch**, and the
 * sequential driver runs one seat at a time, so a reply inside the sending
 * turn is not slow — it is impossible. An agent that has not been told this
 * spends its turn waiting for one (observed 2026-08-19: a critic messaged the
 * drafter, waited, then reported failure on that basis), which costs a whole
 * turn and reads to the user as a broken product.
 *
 * It sits beside the mailbox inlining so the sentence and the mechanism it
 * describes stay together, and it is **one constant** so pair and overseer say
 * exactly the same thing. It is *not* in the solo preamble: a lone seat has
 * nobody to message and the sentence would be noise.
 */
export const MAILBOX_TEMPO =
  'Messages you send are delivered when the recipient’s next turn starts — never mid-turn. ' +
  'Do not wait for a reply in this turn: put everything the recipient needs into the message, ' +
  'finish your own work, and report.';

export interface PromptBudgets {
  readonly maxBytes: number;
  readonly excerptBytes: number;
}

export interface OpenDecision {
  readonly questionId: string;
  readonly prompt: string;
  readonly options: readonly { readonly id: string; readonly label: string }[];
}

export interface ComposePromptInput {
  readonly spec: PromptSpec;
  readonly patternId: string;
  readonly goal: string | null;
  readonly scope: AssignmentScope | null;
  readonly artifactPath: string | null;
  readonly write: boolean;
  readonly role: string;
  readonly roundCap: number | null;
  readonly tokenBudget: number | null;
  readonly tokensUsed: number;
  readonly mail: InlinedMail;
  /** §6.4's stance solicitation; empty when there is nothing open or it is off. */
  readonly decisions: readonly OpenDecision[];
  readonly budgets: PromptBudgets;
}

export interface ComposedPrompt {
  readonly text: string;
  /** Which of §3.2's sections survived the cap — asserted, not assumed. */
  readonly sections: readonly number[];
  readonly bytes: number;
  /** True when anything was dropped to fit `maxBytes`. */
  readonly truncated: boolean;
}

/** §3.2's composition. Deterministic: the same input always yields the same text. */
export function composePrompt(input: ComposePromptInput): ComposedPrompt {
  const full = build(input, { excerpt: true, mailBodies: true, decisions: true });
  if (byteLength(full.text) <= input.budgets.maxBytes) {
    return { ...full, bytes: byteLength(full.text), truncated: false };
  }

  // Degrade in the order §3.2's own numbering implies: context before contract.
  for (const degradation of [
    { excerpt: false, mailBodies: true, decisions: true },
    { excerpt: false, mailBodies: false, decisions: true },
    { excerpt: false, mailBodies: false, decisions: false },
  ]) {
    const attempt = build(input, degradation);
    if (byteLength(attempt.text) <= input.budgets.maxBytes) {
      return { ...attempt, bytes: byteLength(attempt.text), truncated: true };
    }
  }

  // Only a goal or a blocking list larger than the whole budget gets here.
  const bare = build(input, { excerpt: false, mailBodies: false, decisions: false });
  const text = sliceUtf8(bare.text, input.budgets.maxBytes);
  return { text, sections: bare.sections, bytes: byteLength(text), truncated: true };
}

interface Degradation {
  readonly excerpt: boolean;
  readonly mailBodies: boolean;
  readonly decisions: boolean;
}

function build(
  input: ComposePromptInput,
  degrade: Degradation,
): {
  text: string;
  sections: readonly number[];
} {
  const parts: string[] = [];
  const sections: number[] = [];

  // --- 1. Goal and scope ---------------------------------------------------
  const scopeLines = [
    `Project scope: ${describeScope(input.scope)}`,
    input.artifactPath === null ? undefined : `Artifact: ${input.artifactPath}`,
    input.write
      ? 'Posture: you may create and edit files, but only inside the scope paths above.'
      : 'Posture: read-only. Nothing you do may modify a file in this workspace.',
  ].filter((line): line is string => line !== undefined);
  parts.push(
    section('1. Goal and scope', [
      `Goal: ${input.goal ?? '(none recorded — work from the instruction below.)'}`,
      ...scopeLines,
    ]),
  );
  sections.push(1);

  // --- 2. Your seat --------------------------------------------------------
  // The tempo rides with the seat rather than with section 4 because section 4
  // only exists when there *is* unread mail, and the seat that most needs the
  // rule is the one with an empty mailbox about to write into someone else's.
  // Section 2 also survives every degradation below, which the rule must.
  parts.push(
    section('2. Your seat', [
      seatSentence(input),
      intentSentence(input),
      ...(isMultiSeat(input.patternId) ? [MAILBOX_TEMPO] : []),
    ]),
  );
  sections.push(2);

  // --- 3. The handoff -----------------------------------------------------
  const handoff = input.spec.handoff;
  const children = input.spec.children ?? [];
  if (handoff !== undefined || children.length > 0) {
    const lines: string[] = [];
    if (children.length > 0) {
      // §3.5's completion verification, in the one place it can be enforced: the
      // lead is given the child's *claim* and the path the claim is about, and
      // is told in the same breath that the claim is not the evidence.
      lines.push(
        `${String(children.length)} child assignment(s) you created have finished. A report is ` +
          'a claim; the artifact is the evidence. Open each file below and read it before you ' +
          'accept anything.',
      );
      for (const child of children) lines.push(...childLines(child));
    }
    if (handoff !== undefined) {
      lines.push(
        `The ${handoff.seat} seat (${handoff.agentId}) reported: ${handoff.headline ?? '(no structured headline — it did not call report_status.)'}`,
      );
      if (handoff.excerpt !== null && handoff.excerpt.trim() !== '') {
        lines.push(
          degrade.excerpt
            ? `Its last message, excerpted:\n${indent(sliceUtf8(handoff.excerpt, input.budgets.excerptBytes))}`
            : '(Its message was too long to inline; open the session transcript for the full text.)',
        );
      }
    }
    const blocking = input.spec.blocking ?? [];
    if (blocking.length > 0) {
      lines.push('Blocking issues it raised, verbatim:');
      for (const issue of blocking) lines.push(`  - [${issue.severity}] ${issue.summary}`);
    }
    parts.push(section('3. The handoff', lines));
    sections.push(3);
  }

  // --- 4. Unread mail ------------------------------------------------------
  if (input.mail.messages.length > 0 || input.mail.remaining > 0) {
    const lines: string[] = [];
    for (const message of input.mail.messages) {
      const from = message.fromAgentId ?? 'AgentManager';
      lines.push(
        degrade.mailBodies
          ? `- ${from} (${message.kind}): ${message.body ?? ''}`
          : `- ${from} (${message.kind}): (body withheld to fit this prompt — call ${READ_MAILBOX_TOOL}.)`,
      );
    }
    if (input.mail.remaining > 0) {
      lines.push(`${String(input.mail.remaining)} older — call ${READ_MAILBOX_TOOL}.`);
    }
    parts.push(section('4. Unread mail', lines));
    sections.push(4);
  }

  // --- 5. Open decisions ---------------------------------------------------
  if (input.spec.answer !== undefined) {
    parts.push(
      section('5. Open decisions', [
        `The user answered "${input.spec.answer.question}": ${input.spec.answer.text}`,
        'Treat that answer as settled and continue from it.',
      ]),
    );
    sections.push(5);
  } else if (input.decisions.length > 0 && degrade.decisions) {
    // §6.4's stance solicitation: no extra turn, no extra session, no polling.
    const lines: string[] = [];
    for (const decision of input.decisions) {
      lines.push(`Open question: ${decision.prompt}`);
      for (const option of decision.options) lines.push(`  - ${option.id}: ${option.label}`);
    }
    lines.push(
      `If you have a view, state your stance by calling ${REQUEST_DECISION_TOOL} with the same ` +
        'question text and options plus your own recommendation, whose "strength" must be one of ' +
        'blocking, strong, lean or defer. Declining to state a stance is allowed; recommending ' +
        'without a strength is not.',
    );
    parts.push(section('5. Open decisions', lines));
    sections.push(5);
  }

  // --- 6. Termination rules ------------------------------------------------
  parts.push(section('6. Termination rules', terminationLines(input)));
  sections.push(6);

  // --- 7. Required close ---------------------------------------------------
  parts.push(section('7. Required close', [requiredCloseLine(input)]));
  sections.push(7);

  return { text: parts.join('\n\n'), sections };
}

/**
 * Patterns where another agent has a mailbox worth writing to (§3.1).
 *
 * `overseer` counts even though its workers sit in child assignments: the lead
 * shares its own assignment with nobody, but §4.3 still mounts `send_to_agent`
 * for it, and a lead that stalls waiting for a child to answer is the same lost
 * turn.
 */
function isMultiSeat(patternId: string): boolean {
  return patternId === 'pair' || patternId === 'overseer';
}

function seatSentence(input: ComposePromptInput): string {
  const of = input.roundCap === null ? '' : ` of ${String(input.roundCap)}`;
  if (input.patternId === 'pair') {
    return `You are the ${input.spec.seat} (role: ${input.role}) in an adversarial pair. Round ${String(input.spec.round)}${of}.`;
  }
  if (input.patternId === 'overseer') {
    // §3.5: the lead is told it is a lead, and told what the other seats are —
    // there are none here, and every worker sits in a child assignment.
    return (
      `You are the lead (role: ${input.role}) of an overseer assignment: you decompose this goal ` +
      'into child assignments and verify what they produce. You do not do the work yourself. ' +
      `Round ${String(input.spec.round)}${of}.`
    );
  }
  return `You are the ${input.role} on this assignment.`;
}

/**
 * §3.3's instruction line — the one sentence that says what this turn is *for*.
 *
 * `draft` and `revise` name the path and the condition rather than saying "the
 * artifact named above", because "above" is section 1 and a model that skips it
 * produces a report with no file behind it — the exact failure `no_artifact`
 * exists to catch. Saying it here costs a clause and removes a whole round.
 */
function intentSentence(input: ComposePromptInput): string {
  const spec = input.spec;
  // The engine's own acceptance test, in the words the seat reads. Omitted when
  // there is no path to name: a promise about a file nobody declared is noise.
  const onDisk =
    input.artifactPath === null
      ? ''
      : ' Your report is accepted only if that file exists on disk when you finish.';
  switch (spec.intent) {
    case 'draft':
      return input.artifactPath === null
        ? 'Write the first draft of the artifact named above.'
        : `Write the artifact file at ${input.artifactPath} — create it if it does not exist.${onDisk}`;
    case 'critique':
      return 'Read the artifact and list the issues that block it. Be specific and be hard to please.';
    case 'revise':
      return input.artifactPath === null
        ? 'Revise the artifact to answer every blocking issue below, or explain why an issue is wrong.'
        : `Revise the artifact file at ${input.artifactPath} to answer every blocking issue ` +
            `below, or explain why an issue is wrong.${onDisk}`;
    case 'artifact_missing':
      // Deliberately blunt, and it names the consequence: §4.2's rule that a
      // refusal a model understands is a refusal it does not retry applies just
      // as well to an instruction it is being given a second time.
      return (
        `Your report was received but no file exists at ${input.artifactPath ?? 'the artifact path'}. ` +
        'Create that exact file with your draft and report again. A report without this file on ' +
        'disk will be sent back.'
      );
    case 'retry':
      return `Your previous turn ended without a structured report. Do the work, then you MUST call ${REPORT_STATUS_TOOL} before you finish.`;
    case 'answered':
      return 'You stopped waiting for a user decision. It has arrived — continue from it.';
    case 'decompose':
      return (
        'Break this goal into independent work items and create one child assignment per item ' +
        `with ${CREATE_ASSIGNMENT_TOOL}. Use ${LIST_ROSTER_TOOL} to see who can fill each seat ` +
        'and how loaded they already are. Then end your turn: the children run on their own and ' +
        'you are given another turn when they finish.'
      );
    case 'review':
      return (
        'Verify the finished child assignments below, then decide. Delegate any follow-up work ' +
        `with ${CREATE_ASSIGNMENT_TOOL} in this same turn — a revision you do not delegate is ` +
        'work nobody is doing.'
      );
    case 'work':
      return 'Do the work this assignment describes, inside its scope.';
  }
}

/** One finished child, as §3.5's review turn is given it. */
function childLines(child: ChildState): readonly string[] {
  const outcome = child.closeReason === null ? `${child.phase} (not closed)` : child.closeReason;
  const who = child.members.map((member) => `${member.agentId} as ${member.role}`).join(', ');
  const lines = [
    `- ${child.id} [${child.pattern}] — ${child.goal ?? '(no goal recorded)'}`,
    `    outcome: ${outcome}; worked by ${who === '' ? '(nobody)' : who}; ` +
      `${String(child.tokensUsed)} of ${child.tokenBudget === null ? 'no' : String(child.tokenBudget)} tokens used`,
    `    artifact: ${child.artifactPath ?? '(none declared — judge it on what it reported and on the files it names)'}`,
  ];
  if (child.report !== null) {
    lines.push(`    it reported: ${child.report.state} — ${child.report.headline}`);
    const artifacts = child.report.artifacts.map((artifact) => artifact.path);
    if (artifacts.length > 0)
      lines.push(`    files it claims to have touched: ${artifacts.join(', ')}`);
    const blocking = child.report.verdict?.blocking ?? [];
    for (const issue of blocking)
      lines.push(`    it flagged: [${issue.severity}] ${issue.summary}`);
  } else {
    lines.push(
      '    it reported nothing structured, so there is no claim to check — only the file.',
    );
  }
  return lines;
}

function terminationLines(input: ComposePromptInput): readonly string[] {
  const lines: string[] = [];
  if (input.roundCap !== null) {
    const remaining = Math.max(0, input.roundCap - input.spec.round);
    lines.push(
      `Rounds: this is round ${String(input.spec.round)} of at most ${String(input.roundCap)}; ` +
        `${String(remaining)} remain after it. Neither seat can raise the cap.`,
    );
  } else {
    lines.push('Rounds: this assignment has no round cap.');
  }
  if (input.tokenBudget !== null) {
    lines.push(
      `Budget: ${String(input.tokensUsed)} of ${String(input.tokenBudget)} tokens used. ` +
        'Work that crosses the budget stops and asks the user.',
    );
  }
  if (input.patternId === 'pair') {
    lines.push(
      'Convergence: this assignment finishes when the critic reports decision "accept" with an ' +
        'empty blocking list. An "accept, but these are blocking" report counts as "revise".',
    );
  }
  if (input.patternId === 'overseer') {
    lines.push(
      'Convergence: this assignment finishes when you report decision "accept" with an empty ' +
        'blocking list and no child assignment of yours is still open. An "accept, but these are ' +
        'blocking" report counts as "revise".',
      // §7.2/§9-8, stated to the model because it is the rule its next
      // `create_assignment` call is refused by — and a refusal it understands is
      // a refusal it does not retry (§4.2).
      'Budget: every child budget you set is taken from what is left of this assignment’s own. ' +
        'A child with no budget, or one larger than the remainder, is refused. A child with ' +
        'write: true is created but starts nothing until a human approves it — do not wait on it.',
    );
  }
  return lines;
}

function requiredCloseLine(input: ComposePromptInput): string {
  if (input.patternId === 'overseer') {
    return (
      `Before you finish, call ${REPORT_STATUS_TOOL}. On a review turn the verdict is what the ` +
      'engine reads: decision "accept" only for work you have actually read, and one blocking ' +
      'issue per child you are not accepting, naming the child. The engine reads the structure, ' +
      'not the prose.'
    );
  }
  const verdictSeat = input.patternId === 'pair' && input.spec.seat === 'critic';
  return verdictSeat
    ? `Before you finish, call ${REPORT_STATUS_TOOL} with your verdict — decision "accept" or ` +
        '"revise", and every blocking issue listed. The engine reads the structure, not the prose.'
    : `Before you finish, call ${REPORT_STATUS_TOOL} with your state, a one-line headline and the ` +
        'artifacts you touched.';
}

function describeScope(scope: AssignmentScope | null): string {
  if (scope === null || scope.paths.length === 0) return 'the whole project';
  const described = scope.description === undefined ? '' : ` — ${scope.description}`;
  return `${scope.paths.join(', ')}${described}`;
}

function section(title: string, lines: readonly string[]): string {
  return [`## ${title}`, ...lines].join('\n');
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => `  > ${line}`)
    .join('\n');
}

export function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/** Cuts to `maxBytes` UTF-8 bytes without leaving a partial code point. */
export function sliceUtf8(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= maxBytes) return text;
  const cut = buffer.subarray(0, maxBytes).toString('utf8');
  return cut.endsWith('�') ? cut.slice(0, -1) : cut;
}
