/**
 * The two shapes roster hands to other elements: what an agent's permissions
 * actually came out as, and what went wrong.
 *
 * They live beside the definition schema rather than inside it because neither
 * is ever stored in `agent.json` — `EffectivePermissions` is computed per
 * launch by the compiler (§6.2, §13) and returned by `POST /agents/:id/validate`
 * for display, and a `Diagnostic` is produced by the registry, the validator or
 * the compiler and is never authored by a human.
 */
import { z } from 'zod';

import { agentIdSchema, permissionModeSchema } from './schema.js';

// ---------------------------------------------------------------------------
// Effective permissions (§6.2)
// ---------------------------------------------------------------------------

/**
 * The declared widening a project asked for (§6.2's "one escape hatch,
 * deliberately loud"). The reason is required by the schema, not by convention:
 * an elevation nobody has to justify is an elevation that gets copied around.
 */
export const permissionElevationSchema = z.strictObject({
  allow: z.array(z.string().min(1)),
  reason: z.string().min(1).max(500),
});
export type PermissionElevation = z.infer<typeof permissionElevationSchema>;

/**
 * The result of `compilePermissions(baseline, projectOverride, assignmentScope,
 * policy)` (§6.2) — the audit record behind every session, and what the UI
 * shows before launch, because "permission composition that the user cannot see
 * is permission composition they will not trust" (§9.1).
 *
 * Every field is total. An `EffectivePermissions` with an absent `deny` would
 * be indistinguishable from one that denied nothing, and that is precisely the
 * distinction the whole element exists to keep.
 */
export const effectivePermissionsSchema = z.strictObject({
  mode: permissionModeSchema,
  allow: z.array(z.string().min(1)),
  deny: z.array(z.string().min(1)),
  ask: z.array(z.string().min(1)),
  /** The elevation that was **applied**, or `null`. Dropped elevations are a
   *  diagnostic (§6.2, `policy.allowPermissionElevation: false`), not this. */
  elevation: permissionElevationSchema.nullable(),
});
export type EffectivePermissions = z.infer<typeof effectivePermissionsSchema>;

// ---------------------------------------------------------------------------
// Diagnostics (§2.3)
// ---------------------------------------------------------------------------

/**
 * `error` keeps an agent out of the registry or a session from starting;
 * `warn` is the "this will surprise you later" class (§10's integration with
 * no matching allow rule, §8's unrecognised model, §11's model floor); `info`
 * records a decision worth seeing, such as an elevation being applied.
 *
 * Compatible by construction with foundation's `HealthCondition`
 * (`modules/types.ts`), whose levels are `warn | error` — a roster diagnostic
 * at those levels can be lifted into a health condition unchanged.
 */
export const DIAGNOSTIC_LEVELS = ['error', 'warn', 'info'] as const;
export const diagnosticLevelSchema = z.enum(DIAGNOSTIC_LEVELS);
export type DiagnosticLevel = z.infer<typeof diagnosticLevelSchema>;

export const diagnosticSchema = z.strictObject({
  level: diagnosticLevelSchema,
  /** Stable, dotted, machine-readable: `roster.invalid-definition`. The UI
   *  groups and dismisses on this, so it must not carry the detail. */
  code: z
    .string()
    .min(1)
    .regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/, 'must be a dotted lower-case code'),
  message: z.string().min(1),
  /** Which agent it is about, when it is about one. */
  agentId: agentIdSchema.optional(),
  /** Dotted path into the definition, or a file path — whatever the reader
   *  has to go and open. */
  path: z.string().min(1).optional(),
});
export type Diagnostic = z.infer<typeof diagnosticSchema>;
