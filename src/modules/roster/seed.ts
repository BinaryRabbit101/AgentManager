/**
 * The starter roster (roster DESIGN §2.1, IMPLEMENTATION M10).
 *
 * > "**All seeding is roster's** — the installer never writes an example agent
 * > (foundation §4.4)."
 *
 * A brand-new library is an empty board, and an empty board is a product that
 * asks the owner to invent four agents before it does anything. These four are
 * the answer: each is a real identity with a real persona and a permission set
 * someone could defend, rather than a lorem-ipsum placeholder — because the
 * first thing an owner does is *read* one to learn what an agent is, and the
 * second is duplicate it.
 *
 * ## Why four, and why these four
 *
 * M10 asks for "three or four seeded agents … a bug-patcher, a feature
 * implementer, an architect/skeptic pair suitable for orchestrator's v1
 * adversarial-pair slice, and an overseer". Four identities cover all of it
 * because the pair's drafting seat *is* the feature implementer: orchestrator's
 * `PAIR_SEATS` declares `drafter` as `roles: ['architect', 'implementer']` and
 * `critic` as `roles: ['skeptic']`, so {@link ADA} carries both drafting roles
 * and {@link SAM} carries the critic's. A fifth agent whose only job was to hold
 * the word "architect" would be a seat, not a person.
 *
 * The pair also needs its two seats filled by *different identities* —
 * orchestrator §3.3: "an adversarial pair where both sides are the same identity
 * is theatre, not review" — which two of these four are.
 *
 * ## The rules seeding obeys
 *
 * 1. **Through the real store and the real schema.** A seed is parsed by
 *    {@link parseAgentDefinition} and written by `RosterStore.write`, exactly
 *    like an agent the owner creates over the API. Nothing here writes JSON to
 *    disk directly, so a seed that would not validate cannot ship.
 * 2. **Never overwrite anything.** A folder that already exists is left
 *    completely alone, and seeding as a whole runs once — `roster.json`'s
 *    `seededAt` records that the decision was taken, so an owner who deletes a
 *    starter agent does not find it back after a restart.
 * 3. **Never into someone else's roster.** A library that already holds agents
 *    arrived by `git clone` or by hand, and dropping four strangers into it
 *    would be the rudest possible first impression. The pass records `seededAt`
 *    and writes nothing.
 * 4. **No secrets, no integrations.** None of the four needs a credential, so a
 *    clean install has nothing to configure before the board works.
 *
 * ## And two task templates (WO5, 2026-08-19)
 *
 * The same pass writes the two starter **task templates** of §2.4 — "Reply to
 * todo tickets" and "Draft email replies" — under the same three rules, with one
 * deliberate difference: the template half runs on its **own** stamp
 * (`roster.json`'s `templatesSeededAt`) rather than on `seededAt`. Templates
 * arrived after agents did, so every library that already exists has taken the
 * agent decision and has no templates at all; hanging the second decision off
 * the first would mean nobody who already uses AgentManager ever receives them.
 * See {@link seedTemplates}.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { isoTimestamp, type Clock } from '../../storage/time.js';

import { readRosterMetadata, writeRosterMetadata } from './bootstrap.js';
import type { Diagnostic } from './contracts.js';
import { parseAgentDefinition } from './parse.js';
import { AGENT_SCHEMA_VERSION, type AgentDefinition } from './schema.js';
import { libraryPaths, writeFileAtomic, type RosterStore, type StoreHooks } from './store.js';
import {
  TASK_TEMPLATE_SCHEMA_VERSION,
  createTemplateStore,
  parseTaskTemplate,
  type TaskTemplate,
  type TemplateStore,
} from './templates.js';

// ---------------------------------------------------------------------------
// The library README (M10)
// ---------------------------------------------------------------------------

/** The file name M10 asks for: "A short `README` inside the library directory". */
export const LIBRARY_README_FILENAME = 'README.md';

/**
 * "…explaining that it is a git repo and safe to hand-edit."
 *
 * Written once, and never rewritten: it is a file in *the owner's* repository
 * (§2.1), and a service that reformatted their README on every boot would be
 * making commits' worth of noise for them.
 */
export const LIBRARY_README = `# Your agent library

This directory is AgentManager's roster: one folder per agent, and **a git
repository in its own right**. Nothing here is a cache or a build artefact —
these files are the definitions, and AgentManager reads them rather than a
database.

## It is safe to hand-edit

    agents/
      priya-bugfix/
        agent.json      the structured definition (schema v1)
        persona.md      the prompt body — plain markdown, no frontmatter
        roles/          optional per-collaboration-role addenda
        skills/         this agent's skills, one folder each
        .claude-plugin/ generated; do not edit
    templates/
      todo-ticket-replies/
        template.json   a reusable Start-work prefill (a "task template")

Edit \`persona.md\` in any editor and AgentManager reloads it within a second,
no restart. Edit \`agent.json\` and the same happens — with one difference: a
definition that fails validation is kept **out** of the roster and shown on the
board as a diagnostic, rather than crashing anything. Fix the file and it comes
back.

The folder name is the agent id, and the id is immutable. To rename an agent,
change \`name\` in \`agent.json\`; to give it a new id, duplicate it.

## Task templates

\`templates/\` holds the shape of a job you start often, so "Reply to todo
tickets" is one pick in **Start work** rather than a paragraph you retype. A
template carries the brief, the pattern, the artifact path and the tool gates to
pre-answer — never a project and never an agent, because those are the two
things you choose every time.

They load, reload and report their mistakes exactly the way agents do, and there
is no editor for them yet: write \`templates/<id>/template.json\`, save it, and
it appears in the dialog.

## It is a git repository

\`git init\` was run here on first start, and **no commit was ever made** —
what goes into the history is your decision. \`git log\`, \`git diff\` and
\`git checkout\` are the version history for your roster, which is the whole
reason the definitions are files.

\`.gitignore\` excludes in-flight temp files and \`.archive/\` (deleted agents;
git history already records them). Everything else is meant to be committed.

## No credentials live here

Integrations carry \`{ "secretRef": "…" }\` references. The values live in
AgentManager's own secret store, never in this directory, never in a commit and
never in an exported \`.agentpack\`.
`;

// ---------------------------------------------------------------------------
// The four
// ---------------------------------------------------------------------------

/** One starter agent: its definition, minus the fields seeding supplies. */
export interface SeedAgent {
  readonly id: string;
  /** Everything except `schemaVersion`, `id` and `meta` — those are stamped by
   *  {@link seedDefinition} so no seed can disagree about its own provenance. */
  readonly definition: Record<string, unknown>;
  readonly persona: string;
}

/**
 * The rules every seed shares.
 *
 * Reading, searching and the read-only git verbs are safe for all four, and
 * `Bash(git push*)` / `Bash(rm *)` / shell redirection are denied for all four:
 * §6.1 makes `deny` the only restriction that binds, and a starter agent that
 * could push is a starter agent that will, once, memorably.
 */
const COMMON_ALLOW = ['Read', 'Glob', 'Grep', 'TodoWrite', 'Bash(git status)', 'Bash(git diff*)'];
const COMMON_DENY = ['Bash(git push*)', 'Bash(rm *)', 'Bash(* > *)', 'Bash(npm install*)'];

/** The bug-patcher — DESIGN §2.1's own example agent, made real. */
export const PRIYA: SeedAgent = {
  id: 'priya-bugfix',
  definition: {
    name: 'Priya',
    avatar: { kind: 'emoji', value: '🐛' },
    specialty: 'bug-patching',
    tagline: 'Reproduces first, then fixes.',
    tags: ['debugging', 'tests'],
    persona: { mode: 'append', file: 'persona.md' },
    model: { primary: 'sonnet' },
    permissions: {
      mode: 'acceptEdits',
      allow: [...COMMON_ALLOW, 'Edit', 'Write', 'Bash(npm run test:*)', 'Bash(npm run lint)'],
      deny: [...COMMON_DENY],
      ask: ['Bash(git commit*)'],
    },
    settingSources: ['project'],
    capabilities: { overseer: false, roles: ['implementer'] },
    defaults: { maxTurns: 60, maxBudgetUsd: 2.5, concurrencyWeight: 1 },
  },
  persona: `You fix bugs, and you fix them in a particular order.

**Reproduce before you diagnose.** Your first move on any report is a failing
test that demonstrates the bug — not a hypothesis, not a fix. If you cannot make
it fail on demand, say so and describe exactly what you tried; a fix for a bug
you never reproduced is a guess wearing a diff.

**Diagnose before you patch.** Find the line that is wrong and be able to say
why it is wrong. "Adding a null check made the error go away" is a symptom
report, not a diagnosis — the null came from somewhere, and that somewhere is
usually the actual defect.

**Patch narrowly.** The change that fixes the bug and nothing else. Refactoring
you noticed on the way is worth mentioning and not worth doing in the same
change: a fix reviewers can read in thirty seconds gets shipped, and one bundled
with tidying gets queued.

**Leave the test behind.** The failing test you wrote at the start is the fix's
proof and its guard against regression. Never delete it, never weaken it to make
it pass, and never assert on the implementation when you can assert on the
behaviour.

When a bug turns out to be one of several caused by the same underlying defect,
say so before fixing them one at a time. When the correct fix is larger than the
report suggests, say that too and describe the smaller one you would ship first.
`,
};

/** The feature implementer, who is also the pair's drafting seat. */
export const ADA: SeedAgent = {
  id: 'ada-architect',
  definition: {
    name: 'Ada',
    avatar: { kind: 'emoji', value: '📐' },
    specialty: 'feature-implementation',
    tagline: 'Designs the shape, then builds it.',
    tags: ['design', 'implementation'],
    persona: { mode: 'append', file: 'persona.md' },
    model: { primary: 'sonnet' },
    permissions: {
      mode: 'acceptEdits',
      allow: [
        ...COMMON_ALLOW,
        'Edit',
        'Write',
        'NotebookEdit',
        'Bash(npm run test:*)',
        'Bash(npm run lint)',
        'Bash(npm run build)',
      ],
      deny: [...COMMON_DENY],
      ask: ['Bash(git commit*)'],
    },
    settingSources: ['project'],
    // Both of orchestrator's drafting-seat roles (`PAIR_SEATS[0].roles`), so
    // this one identity fills the seat whether the pattern asks for an
    // architect or an implementer.
    capabilities: { overseer: false, roles: ['architect', 'implementer'] },
    defaults: { maxTurns: 80, maxBudgetUsd: 4, concurrencyWeight: 1 },
  },
  persona: `You build features, and you decide what shape they are before you
start typing.

**Say the design out loud first.** Two or three sentences on the approach, the
alternative you rejected, and why. It is short on purpose: a design nobody can
read in a minute is a design nobody will argue with, and being argued with early
is the cheapest thing that will happen to your idea all week.

**Fit the codebase you are in.** The conventions already there beat the ones you
would have chosen. Read the neighbouring module before writing a new one, and
prefer extending a pattern that exists to introducing a better one that does
not.

**Build it in reviewable pieces.** Each change should stand alone and leave the
build green. A branch that only works at the end is a branch nobody can help
with in the middle.

**Test the behaviour you promised.** Not the implementation you happened to
choose — that is what makes a test survive its own refactor.

When you are the drafting seat in a review pair, you are the one who has to be
persuaded, not the one who has to win. Take the critique on its merits, say
plainly which points you are accepting and which you are not, and give a reason
for each refusal. "I disagree" is not a reason; "that case cannot arise because
the caller validates it here" is.
`,
};

/** The critic seat, and a code reviewer in its own right. */
export const SAM: SeedAgent = {
  id: 'sam-skeptic',
  definition: {
    name: 'Sam',
    avatar: { kind: 'emoji', value: '🔍' },
    specialty: 'code-review',
    tagline: 'Finds the case you did not think of.',
    tags: ['review', 'risk'],
    persona: { mode: 'append', file: 'persona.md' },
    model: { primary: 'sonnet' },
    permissions: {
      // A reviewer reads and runs the tests; it does not edit. Restriction is
      // `deny`, never omission from `allow` (§6.1) — and the bare names remove
      // the tool definitions outright rather than merely refusing calls.
      mode: 'default',
      allow: [...COMMON_ALLOW, 'Bash(npm run test:*)', 'Bash(npm run lint)'],
      deny: [
        ...COMMON_DENY,
        'Edit',
        'Write',
        'NotebookEdit',
        'Bash(git commit*)',
        'Bash(git add*)',
      ],
    },
    settingSources: ['project'],
    capabilities: { overseer: false, roles: ['skeptic', 'reviewer'] },
    defaults: { maxTurns: 40, maxBudgetUsd: 1.5, concurrencyWeight: 1 },
  },
  persona: `You review work, and your job is to find what is wrong with it
before a user does.

**Attack the artifact, never the author.** Everything you say is about the code
or the plan in front of you. There is no version of this role in which a remark
about the person is doing useful work.

**Lead with the blocking problems.** Say what would break, under what
conditions, and how you would show it. A finding that cannot be demonstrated is
a suspicion, and it should be labelled as one rather than dressed up as a
defect.

**Rank what you find.** Blocking, worth fixing, and taste — and be honest about
which is which. A review where everything is urgent is a review that gets
skimmed, and the one real bug in it goes out with the rest.

**Be specific about the fix.** "This is fragile" is a feeling. "This breaks when
the list is empty, because line 40 indexes before checking length" is a finding.
If you do not know the fix, say what you would try first.

**Converge.** You are not here to win an argument, you are here to make the
change safe. When your blocking points have been answered — actually answered,
not merely responded to — say so plainly and accept. Holding out for the last
five percent of taste is how a review pair burns its round budget and ships
nothing.
`,
};

/** The overseer — the only seed carrying `capabilities.overseer`. */
export const MIRA: SeedAgent = {
  id: 'mira-overseer',
  definition: {
    name: 'Mira',
    avatar: { kind: 'emoji', value: '🧭' },
    specialty: 'overseer',
    tagline: 'Splits the work and keeps it converging.',
    tags: ['coordination'],
    persona: { mode: 'append', file: 'persona.md' },
    // §11's model floor: the validator warns below `sonnet`, and decomposition
    // is "the task least tolerant of a weak model".
    model: { primary: 'sonnet' },
    permissions: {
      // A coordinator reads to decide and does not edit. The
      // `mcp__agentmanager__*` grant is **not** written here: §11 makes it the
      // compiler's, conditional on the orchestrator module being present, and a
      // rule sitting in a definition for a server that may never be mounted
      // would be a lie about what the agent can do.
      mode: 'default',
      allow: [...COMMON_ALLOW],
      deny: [...COMMON_DENY, 'Edit', 'Write', 'NotebookEdit', 'Bash(git commit*)'],
    },
    settingSources: ['project'],
    capabilities: { overseer: true, roles: ['overseer'] },
    // §11: "A higher default `maxTurns` and `maxBudgetUsd` — coordination is
    // turn-expensive and produces little output per turn."
    defaults: { maxTurns: 120, maxBudgetUsd: 6, concurrencyWeight: 1 },
  },
  persona: `You coordinate other agents. You do not do their work.

**Decompose before you delegate.** Say what the pieces are, which of them can
run at the same time, and what each one has to hand back for the next to start.
A brief that only makes sense to you is a brief that comes back wrong.

**Delegate to the person, not to the title.** You can see who is on the roster,
what they specialise in and which collaboration roles they fill. Match the work
to that, and say why you chose who you chose.

**Read what comes back.** A structured status report is the point of the
channel; a summary that ignores it and repeats the brief is worse than no
summary. When two agents disagree, do not average them — find which one is
answering the question that was asked.

**Converge, and say when you have.** Every assignment ends with a plain verdict:
what was done, what was not, and what a human still has to decide. "Making
progress" is not a status.

**Escalate rather than improvise.** You cannot raise anyone's permissions,
including your own, and you cannot approve your own budget. When the work needs
more than it was given, ask the human — with the number and the reason, not a
hint.
`,
};

/** The starter roster, in board order. */
export const SEED_AGENTS: readonly SeedAgent[] = [PRIYA, ADA, SAM, MIRA];

// ---------------------------------------------------------------------------
// The two starter task templates (WO5)
// ---------------------------------------------------------------------------

/**
 * One starter template, minus the field seeding stamps.
 *
 * The same shape {@link SeedAgent} has, and for the same reason: `schemaVersion`
 * and `id` are supplied by {@link seedTemplateDefinition} so no seed can
 * disagree with itself about its own provenance.
 */
export interface SeedTemplate {
  readonly id: string;
  /** Everything except `schemaVersion` and `id`. */
  readonly template: Record<string, unknown>;
}

/**
 * "Reply to todo tickets" — WO5's first starter.
 *
 * `solo`, because the job is drafting rather than reviewing, and because a pair
 * on a queue of tickets spends its rounds arguing about the first one. It
 * declares **no** `requiredIntegrations`: a ticket queue is a file, a URL or an
 * MCP server depending on whose queue it is, so `{{source}}` asks rather than
 * the template assuming — and a starter that warned about a connector nobody
 * has on a clean install would be a warning that teaches people to ignore
 * warnings.
 */
export const TODO_TICKET_REPLIES: SeedTemplate = {
  id: 'todo-ticket-replies',
  template: {
    name: 'Reply to todo tickets',
    description: 'Read the open tickets, draft a reply to each, and file them all for review.',
    pattern: 'solo',
    goalTemplate: `Work the open items in {{source}}.

For each open ticket, in the order they appear:

1. Read the ticket and whatever it points at — the code, the log, the previous
   reply. Do not answer from the title.
2. Draft a reply addressed to the person who raised it: what you found, what
   happens next, and by when if you can say. Say "I do not know yet" rather
   than guessing; a confident wrong answer costs more than a slow one.
3. If the ticket cannot be answered without a decision only a human can make,
   draft the reply anyway and mark it **needs a decision**, naming the choice.

Collect every draft in the artifact, one section per ticket, with the ticket's
id and title as the heading. Nothing is sent — this is a review queue, and the
human sends.`,
    artifactPathTemplate: 'docs/assignments/{{slug}}/replies.md',
    write: true,
    suggestedRoles: ['implementer'],
    // The two gates a drafting run actually raises (roster `preflight.ts`'s
    // catalogue): the artifact is written once and revised in place.
    preGrantTools: ['Write', 'Edit'],
  },
};

/**
 * "Draft email replies" — WO5's second starter.
 *
 * This one *does* declare a `requiredIntegrations`, and deliberately: an agent
 * with no mailbox connector cannot read a mailbox, so the warning is true on
 * the day it fires. It is still only a warning — the picker offers every agent
 * and the dialog links to the integrations editor (ui §7.3.1) rather than
 * removing the row, which is the whole difference between ranking and gating.
 */
export const EMAIL_REPLY_DRAFTS: SeedTemplate = {
  id: 'email-reply-drafts',
  template: {
    name: 'Draft email replies',
    description: 'Read the unanswered mail, draft a reply to each, and leave them for a human.',
    pattern: 'solo',
    goalTemplate: `Draft replies to the unanswered mail in {{source}}.

For each message that still needs an answer:

1. Read the whole thread, not just the last message. Half of what looks
   unanswered has already been answered further up.
2. Draft a reply in the voice of a colleague, not of a support macro: answer
   the question that was asked, say what you are doing about it, and stop.
3. Flag anything that commits money, time or a person's availability as
   **needs a decision** instead of committing it.

Collect the drafts in the artifact, one section per thread, each with the
sender, the subject and the draft. **Send nothing.** The human reads, edits and
sends.`,
    artifactPathTemplate: 'docs/assignments/{{slug}}/email-drafts.md',
    write: true,
    // The connector id an agent would carry for a mailbox (roster §10's
    // `integrations` key). It ranks and it warns; it never filters.
    requiredIntegrations: ['gmail'],
    suggestedRoles: ['implementer'],
    preGrantTools: ['Write', 'Edit'],
  },
};

/** The starter templates, in the order the dialog's strip renders them. */
export const SEED_TEMPLATES: readonly SeedTemplate[] = [TODO_TICKET_REPLIES, EMAIL_REPLY_DRAFTS];

/**
 * One starter template as a validated {@link TaskTemplate}.
 *
 * Through the same parser a hand-written `template.json` goes through, so a
 * starter with a typo fails this element's own suite rather than an owner's
 * first boot.
 */
export function seedTemplateDefinition(seed: SeedTemplate): TaskTemplate {
  return parseTaskTemplate(
    { ...seed.template, schemaVersion: TASK_TEMPLATE_SCHEMA_VERSION, id: seed.id },
    `seed:${seed.id}`,
  );
}

/**
 * One seed as a validated {@link AgentDefinition}.
 *
 * Goes through the same parser as `POST /agents`, so a seed with a typo fails
 * this element's own test suite rather than an owner's first boot.
 */
export function seedDefinition(seed: SeedAgent, now: Date): AgentDefinition {
  const at = isoTimestamp(now);
  return parseAgentDefinition(
    {
      ...seed.definition,
      schemaVersion: AGENT_SCHEMA_VERSION,
      id: seed.id,
      meta: { createdAt: at, updatedAt: at, origin: 'seed', duplicatedFrom: null },
    },
    `seed:${seed.id}`,
  );
}

// ---------------------------------------------------------------------------
// The pass
// ---------------------------------------------------------------------------

export interface SeedLibraryOptions {
  readonly store: RosterStore;
  readonly clock?: Clock;
  readonly hooks?: StoreHooks;
  /** Overridable so a test can seed a two-agent library without a fixture. */
  readonly agents?: readonly SeedAgent[];
  /** The same seam for the template pass (WO5). */
  readonly templates?: readonly SeedTemplate[];
}

/** What the template half of a seeding run did (WO5). */
export interface SeedTemplatesResult {
  /** Template ids written by this run. Empty on every run after the first. */
  readonly seeded: readonly string[];
  /** Ids whose folder already existed and so were left completely alone. */
  readonly skipped: readonly string[];
  readonly reason: 'seeded' | 'already-seeded';
  /** What `roster.json`'s `templatesSeededAt` should hold afterwards. */
  readonly stampedAt: string;
  readonly diagnostics: readonly Diagnostic[];
}

export interface SeedResult {
  /** Ids written by this run. Empty on every run after the first. */
  readonly seeded: readonly string[];
  /** Ids that were already present and so were left alone. */
  readonly skipped: readonly string[];
  /** True when this run wrote the library README. */
  readonly readmeWritten: boolean;
  /** Why nothing was written, when nothing was. */
  readonly reason: 'seeded' | 'already-seeded' | 'library-not-empty';
  readonly diagnostics: readonly Diagnostic[];
  /** The template pass, which runs on its own stamp (WO5) — see below. */
  readonly templates: SeedTemplatesResult;
}

export interface SeedTemplatesOptions {
  readonly store: TemplateStore;
  /** `roster.json`'s `templatesSeededAt`, or `null` when the pass has not run. */
  readonly seededAt: string | null;
  readonly clock?: Clock;
  readonly templates?: readonly SeedTemplate[];
}

/**
 * Writes the starter task templates, once (WO5).
 *
 * Three rules, two of them borrowed verbatim from the agent pass and one that
 * is deliberately *not*:
 *
 * - **Through the real parser and the real store.** A starter that would not
 *   validate cannot ship, and the folder it lands in is indistinguishable from
 *   one an owner wrote by hand.
 * - **Never overwrite, and never come back.** A folder that exists is left
 *   alone, and `templatesSeededAt` records that the decision was taken — so a
 *   deleted starter template does not reappear on the next boot.
 * - **It does *not* check whether the library is empty.** That guard exists for
 *   agents because dropping four strangers into somebody's cloned roster is the
 *   rudest possible first impression. Templates are new, so every library in
 *   existence has none, and refusing to seed them into a library that happens to
 *   hold agents would mean nobody who already uses AgentManager ever gets them.
 *   A colliding id is still skipped, which is what protects a cloned roster that
 *   brought its own.
 */
export function seedTemplates(options: SeedTemplatesOptions): SeedTemplatesResult {
  const clock: Clock = options.clock ?? ((): Date => new Date());
  const seeds = options.templates ?? SEED_TEMPLATES;
  const diagnostics: Diagnostic[] = [];

  if (options.seededAt !== null) {
    return {
      seeded: [],
      skipped: [],
      reason: 'already-seeded',
      stampedAt: options.seededAt,
      diagnostics,
    };
  }

  const seeded: string[] = [];
  const skipped: string[] = [];
  for (const seed of seeds) {
    if (options.store.hasFolder(seed.id)) {
      skipped.push(seed.id);
      continue;
    }
    try {
      options.store.write(seedTemplateDefinition(seed));
      seeded.push(seed.id);
    } catch (cause) {
      // A starter template that will not write is a diagnostic on a dialog that
      // still works, exactly as a starter agent is — the blank card is the first
      // card in the strip, and it is the whole of today's flow.
      diagnostics.push({
        level: 'warn',
        code: 'roster.seed-failed',
        message:
          `the starter task template "${seed.id}" could not be written ` +
          `(${cause instanceof Error ? cause.message : String(cause)}); Start work will simply ` +
          'open with no templates (DESIGN §2.4, WO5).',
      });
    }
  }

  return { seeded, skipped, reason: 'seeded', stampedAt: isoTimestamp(clock()), diagnostics };
}

/**
 * Writes the starter roster, once, into an empty library.
 *
 * Never throws for a seed that will not write: one starter agent that could not
 * be created is a diagnostic on a board that still works, and the alternative —
 * a service that refuses to start because an example agent failed — is a far
 * worse trade than the one it protects against.
 */
export function seedLibrary(options: SeedLibraryOptions): SeedResult {
  const { store } = options;
  const clock: Clock = options.clock ?? ((): Date => new Date());
  const hooks = options.hooks ?? {};
  const seeds = options.agents ?? SEED_AGENTS;
  const paths = libraryPaths(store.paths.root);
  const diagnostics: Diagnostic[] = [];

  const metadata = readRosterMetadata(paths);

  // The template pass first, and **outside** the agent pass's gates: a library
  // seeded with agents last month has `seededAt` set and no templates at all, so
  // hanging the templates off that stamp would mean every existing install never
  // gets them. Its own stamp is what makes it once-ever (WO5).
  const templates = seedTemplates({
    store: createTemplateStore({ root: paths.root, ...(options.hooks === undefined ? {} : { hooks }) }),
    seededAt: metadata.templatesSeededAt,
    clock,
    ...(options.templates === undefined ? {} : { templates: options.templates }),
  });
  diagnostics.push(...templates.diagnostics);
  const stamped = { ...metadata, templatesSeededAt: templates.stampedAt };

  const stampSeeded = (reason: SeedResult['reason']): SeedResult => {
    const readmeWritten = writeLibraryReadme(paths.root, hooks);
    // `seededAt` records that the decision was taken, not merely that files
    // were written — which is what stops a deleted starter agent from
    // reappearing, and what stops a cloned roster being seeded on its second
    // boot after being skipped on its first.
    writeRosterMetadata(paths, { ...stamped, seededAt: isoTimestamp(clock()) }, hooks);
    return { seeded: [], skipped: [], readmeWritten, reason, diagnostics, templates };
  };

  if (metadata.seededAt !== null) {
    // Nothing to record unless the template pass just took its own decision —
    // an untouched `roster.json` is what keeps a second boot free of a write.
    if (templates.stampedAt !== metadata.templatesSeededAt) {
      writeRosterMetadata(paths, stamped, hooks);
    }
    return {
      seeded: [],
      skipped: [],
      readmeWritten: writeLibraryReadme(paths.root, hooks),
      reason: 'already-seeded',
      diagnostics,
      templates,
    };
  }

  // Somebody else's roster: `git clone`d, restored, or hand-built. Record the
  // decision and leave it exactly as it is.
  if (store.folderNames().length > 0) return stampSeeded('library-not-empty');

  const seeded: string[] = [];
  const skipped: string[] = [];
  for (const seed of seeds) {
    if (store.hasFolder(seed.id)) {
      skipped.push(seed.id);
      continue;
    }
    try {
      store.write(seedDefinition(seed, clock()), seed.persona);
      seeded.push(seed.id);
    } catch (cause) {
      diagnostics.push({
        level: 'warn',
        code: 'roster.seed-failed',
        message:
          `the starter agent "${seed.id}" could not be written ` +
          `(${cause instanceof Error ? cause.message : String(cause)}); the board will simply ` +
          'start empty (DESIGN §2.1, M10).',
        agentId: seed.id,
      });
    }
  }

  const readmeWritten = writeLibraryReadme(paths.root, hooks);
  writeRosterMetadata(paths, { ...stamped, seededAt: isoTimestamp(clock()) }, hooks);
  return { seeded, skipped, readmeWritten, reason: 'seeded', diagnostics, templates };
}

/**
 * Writes `README.md` when there is not one, and never over one there is.
 *
 * The same rule every step of bootstrap follows (`bootstrap.ts`): check for the
 * output first, so a second run changes nothing and an owner who rewrote the
 * file keeps their version.
 */
export function writeLibraryReadme(root: string, hooks: StoreHooks = {}): boolean {
  const path = join(root, LIBRARY_README_FILENAME);
  if (existsSync(path)) return false;
  writeFileAtomic(path, LIBRARY_README, hooks);
  return true;
}
