/**
 * The orchestrator's configuration sub-schema (orchestrator DESIGN §12).
 *
 * **How the contribution reaches the loader.** Exactly the arrangement runner
 * established in `src/modules/runner/config.ts`: foundation's
 * {@link ConfigSchemaRegistry} keys a contribution by *namespace* and refuses a
 * second claim on one, and the `orchestrator` namespace is already claimed —
 * foundation registered it (with `owner: 'orchestrator'`) while this module did
 * not exist, shipping the one key the edition files needed,
 * `orchestrator.notify.enabled`. So the schema and its defaults live **here**,
 * owned by this element, and `src/config/schema.ts` composes them into the
 * single `orchestrator` contribution. Nothing about the five layers, the env
 * mapping, or validation changes, and `notify.enabled` keeps the exact meaning
 * and the exact default it already had.
 *
 * `modules.orchestrator.enabled` stays where foundation §2.3 put it and is **not**
 * duplicated here (§12). Runner's `question.holdMs` and `question.expireHours`
 * are read from `config.runner.question` rather than copied (§12), so this
 * schema deliberately has no question-timing keys.
 *
 * Every bound below is a real refusal rather than decoration. A round cap of 0
 * is an assignment that can never take a turn; a `maxConcurrentPerAgent` of 0 is
 * a roster that can never be assigned anything. Both are configuration mistakes
 * that would otherwise present as an inexplicably idle fleet.
 */
import { z } from 'zod';

const positiveInt = z.number().int().positive();

/** DESIGN §12, key for key. */
export const orchestratorConfigSchema = z.strictObject({
  patterns: z.strictObject({
    pair: z.strictObject({
      /** The default round cap a user-created pair gets (§7.2). */
      roundCap: positiveInt,
      /** The ceiling a user may raise it to, including from the round-cap card (§3.3). */
      maxRoundCap: positiveInt,
      /** §6.4's "ask the other seat for its stance while planning its turn anyway". */
      stanceSolicitation: z.boolean(),
      /** A critique of a chat message is a conversation; of a file, a review (§3.3). */
      requireArtifact: z.boolean(),
    }),
    /** §3.5's lead-and-children pattern. */
    overseer: z.strictObject({
      /**
       * Round 1 decomposes; every later round reviews what finished (§3.5). So
       * the default of 3 is "decompose, review, review once more" — and the cap
       * is what stops a lead that keeps re-delegating from running forever.
       */
      roundCap: positiveInt,
      /** The ceiling the round-cap card may raise it to, as the pair has (§3.3). */
      maxRoundCap: positiveInt,
    }),
  }),
  budgets: z.strictObject({
    /** §7.2's default for a user-created pair. `solo` defaults to `null` — uncapped. */
    defaultPairTokens: positiveInt,
    /**
     * §7.2's projection constant.
     *
     * "A crude planning constant, not a prediction" — it is one number in a
     * config file, and calling it an estimate would dress a guess up as
     * arithmetic.
     */
    turnEstimateTokens: positiveInt,
    /** The one-shot overdraft *Continue once* grants (§7.3). */
    overdraftTokens: positiveInt,
    /** A raise beyond this × the original needs an approval gate of its own (§7.3). */
    raiseMaxFactor: z.number().positive(),
  }),
  assignment: z.strictObject({
    /** The staleness sweep's threshold (§8.1 `stale`). */
    maxAgeHours: positiveInt,
    /** §9-7: how many other open assignments an agent may already hold a seat in. */
    maxConcurrentPerAgent: positiveInt,
    /** §9-3. v1 pins 1: no overseer minting overseers. */
    maxNestingDepth: z.number().int().min(0),
  }),
  questions: z.strictObject({
    /** §6.3's join window. Exact normalised equality, never fuzzy similarity. */
    joinWindowMs: positiveInt,
  }),
  mailbox: z.strictObject({
    /** How many unread messages a launch prompt inlines (§5.1). */
    inlineMax: positiveInt,
    inlineMaxBytes: positiveInt,
  }),
  prompt: z.strictObject({
    /** The composed prompt's hard cap (§3.2). */
    maxBytes: positiveInt,
    /** How much of a counterpart's last message the handoff section carries (§3.2). */
    excerptBytes: positiveInt,
    /** The bound on `assignment_turns.output_text` (§3.2). */
    outputCaptureBytes: positiveInt,
  }),
  breakers: z.strictObject({
    denialsPerSession: positiveInt,
    consecutiveFailures: positiveInt,
    identicalTurns: positiveInt,
    messagesPerTurn: positiveInt,
    maxAssignmentsPerSession: positiveInt,
    maxDecisionsPerSession: positiveInt,
  }),
  notify: z.strictObject({
    /**
     * The one key foundation already shipped, unchanged.
     *
     * `edition.work.json` sets it `false` and `edition.home.json` sets it
     * `true`: outbound push from a work machine is a policy decision rather than
     * a preference (§10, R5), so the unconfigured value is the closed one.
     */
    enabled: z.boolean(),
    channel: z.enum(['ntfy']),
    /** The delay that stops a user at their desk being pushed for a 10-second answer (§10). */
    afterMs: positiveInt,
    maxPerHour: positiveInt,
    /** `blocking` — gates and budget halts always; plain questions only when urgent (§10). */
    minLevel: z.enum(['blocking', 'all']),
    /** Resolved through `SecretResolver`; a capability URL, therefore a secret (R5). */
    topicSecretRef: z.string().min(1),
  }),
  /**
   * §11.5's glanceable projection. Both keys cap what `GET /api/widget`
   * *sends*, never what it counts: `waitingTotal` is taken before the slice, so
   * lowering `maxWaiting` shortens the widget and never hides the number.
   */
  widget: z.strictObject({
    /** How many waiting rows the payload carries. Four is what a small widget fits. */
    maxWaiting: positiveInt,
    /** Per-row prompt budget, so one pathological question cannot dominate the response. */
    promptChars: positiveInt,
  }),
});

/** The frozen shape modules read off `ctx.config.orchestrator`. */
export type OrchestratorConfig = z.infer<typeof orchestratorConfigSchema>;

/** DESIGN §12's defaults, mirrored by `config/defaults.json` (layer 1). */
export const ORCHESTRATOR_CONFIG_DEFAULTS: OrchestratorConfig = {
  patterns: {
    pair: { roundCap: 3, maxRoundCap: 6, stanceSolicitation: true, requireArtifact: true },
    overseer: { roundCap: 3, maxRoundCap: 6 },
  },
  budgets: {
    defaultPairTokens: 400_000,
    turnEstimateTokens: 25_000,
    overdraftTokens: 25_000,
    raiseMaxFactor: 2,
  },
  assignment: { maxAgeHours: 24, maxConcurrentPerAgent: 2, maxNestingDepth: 1 },
  questions: { joinWindowMs: 120_000 },
  mailbox: { inlineMax: 10, inlineMaxBytes: 8192 },
  prompt: { maxBytes: 16_384, excerptBytes: 2048, outputCaptureBytes: 32_768 },
  breakers: {
    denialsPerSession: 5,
    consecutiveFailures: 2,
    identicalTurns: 2,
    messagesPerTurn: 20,
    maxAssignmentsPerSession: 5,
    maxDecisionsPerSession: 3,
  },
  notify: {
    enabled: false,
    channel: 'ntfy',
    afterMs: 60_000,
    maxPerHour: 6,
    minLevel: 'blocking',
    topicSecretRef: 'notify.ntfy.topicUrl',
  },
  widget: { maxWaiting: 4, promptChars: 140 },
};
