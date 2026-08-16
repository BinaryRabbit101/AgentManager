/**
 * The config sub-schema registry (foundation DESIGN.md §2.1).
 *
 * "Modules contribute config sub-schemas, symmetrically with element-owned
 * migrations: a module declares a zod sub-schema for its own key namespace and
 * the defaults that go with it, and the loader composes them into the one schema
 * it validates against."
 *
 * So the loader never hard-codes the key inventory. Foundation registers all v1
 * namespaces itself for now (see schema.ts) — DESIGN §2.3 is the composed
 * result, not a list foundation owns alone — and a module gains its own
 * namespace by registering here instead of editing the loader.
 */
import { z } from 'zod';

import { isPlainObject } from './merge.js';

/** One namespace's schema and shipped defaults. */
export interface ConfigContribution {
  /** Top-level config key this contribution owns (`http`, `orchestrator`, `edition`). */
  readonly namespace: string;
  readonly schema: z.ZodType;
  /** The value this namespace takes when no layer sets it. */
  readonly defaults: unknown;
  /** Module id, used as the source origin for the defaults it ships. */
  readonly owner: string;
}

export interface ConfigInvariantViolation {
  /** Path of the key to blame, as segments (`['modules', 'remote', 'enabled']`). */
  readonly path: readonly string[];
  readonly message: string;
}

/**
 * A cross-key rule that no single namespace can express — the edition/remote
 * invariant of DESIGN §2.2 being the reason this exists.
 */
export interface ConfigInvariant {
  readonly id: string;
  readonly check: (
    config: Readonly<Record<string, unknown>>,
  ) => readonly ConfigInvariantViolation[];
}

export class ConfigSchemaRegistry {
  readonly #contributions = new Map<string, ConfigContribution>();
  readonly #invariants = new Map<string, ConfigInvariant>();

  register(contribution: ConfigContribution): this {
    if (this.#contributions.has(contribution.namespace)) {
      const existing = this.#contributions.get(contribution.namespace);
      throw new Error(
        `Config namespace "${contribution.namespace}" is already registered by "${existing?.owner ?? 'unknown'}"; ` +
          `"${contribution.owner}" cannot claim it as well.`,
      );
    }
    this.#contributions.set(contribution.namespace, contribution);
    return this;
  }

  registerInvariant(invariant: ConfigInvariant): this {
    if (this.#invariants.has(invariant.id)) {
      throw new Error(`Config invariant "${invariant.id}" is already registered.`);
    }
    this.#invariants.set(invariant.id, invariant);
    return this;
  }

  get contributions(): readonly ConfigContribution[] {
    return [...this.#contributions.values()];
  }

  get invariants(): readonly ConfigInvariant[] {
    return [...this.#invariants.values()];
  }

  /** The composed layer-1 seed: every registered namespace at its shipped default. */
  composeDefaults(): Record<string, unknown> {
    const defaults: Record<string, unknown> = {};
    for (const contribution of this.#contributions.values()) {
      defaults[contribution.namespace] = structuredClone(contribution.defaults);
    }
    return defaults;
  }

  /**
   * The one schema the merged config is validated against: a strict object over
   * every registered namespace, with the invariants attached as a refinement so
   * they report against the same issue list as type errors do.
   *
   * Strict rather than permissive on purpose — an unrecognised key is almost
   * always a typo, and a typo that is silently ignored is a setting the user
   * believes is applied.
   */
  composeSchema(): z.ZodType {
    const shape: Record<string, z.ZodType> = {};
    for (const contribution of this.#contributions.values()) {
      shape[contribution.namespace] = contribution.schema;
    }
    const invariants = this.invariants;

    return z.strictObject(shape).superRefine((value, ctx) => {
      if (!isPlainObject(value)) return;
      for (const invariant of invariants) {
        for (const violation of invariant.check(value)) {
          ctx.addIssue({
            code: 'custom',
            message: violation.message,
            path: [...violation.path],
          });
        }
      }
    });
  }
}
