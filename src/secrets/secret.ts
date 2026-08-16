/**
 * The `Secret` wrapper of DESIGN §3.2.
 *
 * "Secret values are wrapped in a `Secret` type whose `toString`, `toJSON` and
 * `util.inspect` all return `[redacted]`, so an accidental log or API
 * serialization leaks nothing. Only `.reveal()` yields the plaintext."
 *
 * The plaintext lives in a `#private` field, which is not an own property: it
 * survives neither `{...secret}`, nor `Object.keys`, nor `structuredClone`, nor
 * `JSON.stringify` — so the three redaction hooks below are a second line of
 * defence rather than the only one.
 */
import { inspect } from 'node:util';

/** What every accidental stringification of a {@link Secret} produces. */
export const REDACTED = '[redacted]';

export class Secret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  /**
   * The plaintext.
   *
   * §3.2 names exactly two authorized call sites — roster's option compiler and
   * runner's `attachAuthEnv()`. "Any third call site is a review failure, not a
   * judgement call."
   */
  reveal(): string {
    return this.#value;
  }

  /** The last four characters, for human recognition in a listing or the UI. */
  preview(): string {
    return previewOf(this.#value);
  }

  /** Covers `String(secret)`, `secret + ''` and `` `${secret}` ``. */
  toString(): string {
    return REDACTED;
  }

  /** Covers `JSON.stringify(secret)` and anything that serializes a payload containing one. */
  toJSON(): string {
    return REDACTED;
  }

  /**
   * Covers `console.log(secret)`, `util.inspect`, and pino's object serializer.
   *
   * Template interpolation reaches `toString` through `Symbol.toPrimitive`
   * anyway, but declaring the primitive hook explicitly means a numeric
   * coercion cannot skip past the string path into the raw value.
   */
  [inspect.custom](): string {
    return REDACTED;
  }

  [Symbol.toPrimitive](): string {
    return REDACTED;
  }

  get [Symbol.toStringTag](): string {
    return 'Secret';
  }
}

/** True for a {@link Secret}, without exposing the class to structural duck-typing. */
export function isSecret(value: unknown): value is Secret {
  return value instanceof Secret;
}

/**
 * The last four characters of a value.
 *
 * A value shorter than four characters yields what there is, rather than
 * padding — padding would imply a length the secret does not have. This is the
 * same "store a display fragment beside a protected credential" pattern §3.4
 * already uses for `remote_tokens.token_prefix`.
 */
export function previewOf(value: string): string {
  return value.slice(-4);
}
