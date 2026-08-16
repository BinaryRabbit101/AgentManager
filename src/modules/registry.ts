/**
 * The service registry of DESIGN §6.1.
 *
 * "Feature modules never import each other directly. They communicate through
 * the event bus (fire-and-forget, typed) and through service interfaces
 * published on the registry (request/response). This is what makes the remote
 * module removable without a compile error anywhere else."
 *
 * `require` returns `undefined` for an absent name rather than throwing,
 * because that is the edition-gating mechanism itself (§6.2): "any code that
 * would want to ask 'are we home edition?' instead asks whether a capability is
 * present (`ctx.require('remote')` returns undefined)". Making absence an
 * exception would push every caller back into try/catch or into asking about
 * the edition, which is the branching §6.2 exists to prevent.
 */
import { ModuleConflictError } from './errors.js';

export interface ProvidedService {
  readonly name: string;
  /** The module that published it — the answer to "who owns this?" in logs. */
  readonly moduleId: string;
  readonly api: unknown;
}

export class ServiceRegistry {
  readonly #services = new Map<string, ProvidedService>();

  /**
   * Publishes `api` under `name`.
   *
   * @throws ModuleConflictError when the name is taken. Two implementations of
   *   one service name means `require` silently returns one of them, and which
   *   one depends on module order — a bug that shows up as behaviour, not as an
   *   error, so it is refused at registration.
   */
  provide(moduleId: string, name: string, api: unknown): void {
    const existing = this.#services.get(name);
    if (existing !== undefined) {
      throw new ModuleConflictError(
        `Service "${name}" is already provided by module "${existing.moduleId}"; ` +
          `module "${moduleId}" cannot provide it as well.`,
      );
    }
    this.#services.set(name, { name, moduleId, api });
  }

  /** The service, or `undefined` when nothing provides it. */
  require<T>(name: string): T | undefined {
    return this.#services.get(name)?.api as T | undefined;
  }

  has(name: string): boolean {
    return this.#services.has(name);
  }

  /** Registered names, in registration order. For diagnostics and `/api/health`. */
  names(): readonly string[] {
    return [...this.#services.keys()];
  }

  list(): readonly ProvidedService[] {
    return [...this.#services.values()];
  }
}
