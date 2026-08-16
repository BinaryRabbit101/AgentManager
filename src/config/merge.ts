/**
 * Deep merge with array-replace semantics and per-key source tracking
 * (foundation DESIGN.md §2.1: "Deep-merged object by object; arrays replace
 * rather than concatenate").
 *
 * Arrays replacing is the load-bearing half. `policy.globalDeny` is a security
 * lever; if layers concatenated, a lower layer's entry could never be removed
 * and a higher layer could never state the complete set it means — both of
 * which make the effective value something no single file shows.
 */
import type { ConfigPatch, ConfigSource } from './types.js';

/**
 * True for objects the merge descends into: plain data objects only. Arrays,
 * `null`, dates and class instances are leaves and replace wholesale.
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function joinPath(prefix: string, key: string): string {
  return prefix === '' ? key : `${prefix}.${key}`;
}

/** Records `source` for every leaf path inside `value`. */
function recordLeaves(
  sources: Map<string, ConfigSource>,
  path: string,
  value: unknown,
  source: ConfigSource,
): void {
  if (isPlainObject(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) {
      sources.set(path, source);
      return;
    }
    for (const [key, child] of entries) {
      recordLeaves(sources, joinPath(path, key), child, source);
    }
    return;
  }
  sources.set(path, source);
}

/** Drops `path` and everything beneath it, so a replaced subtree leaves no stale attribution. */
function clearSources(sources: Map<string, ConfigSource>, path: string): void {
  sources.delete(path);
  const prefix = `${path}.`;
  for (const key of sources.keys()) {
    if (key.startsWith(prefix)) sources.delete(key);
  }
}

function applyPatch(
  base: Record<string, unknown>,
  patch: Readonly<Record<string, unknown>>,
  source: ConfigSource,
  sources: Map<string, ConfigSource>,
  prefix: string,
): void {
  for (const [key, patchValue] of Object.entries(patch)) {
    // Never let a config file or environment variable reach the prototype chain.
    if (key === '__proto__') continue;

    const path = joinPath(prefix, key);
    const baseValue = base[key];

    if (isPlainObject(patchValue) && isPlainObject(baseValue)) {
      applyPatch(baseValue, patchValue, source, sources, path);
      continue;
    }

    base[key] = structuredClone(patchValue);
    clearSources(sources, path);
    recordLeaves(sources, path, patchValue, source);
  }
}

export interface MergeResult {
  readonly value: Record<string, unknown>;
  readonly sources: Map<string, ConfigSource>;
}

/**
 * Applies patches in order — lowest precedence first — returning the merged
 * value and the winning source of every leaf key.
 */
export function mergePatches(patches: readonly ConfigPatch[]): MergeResult {
  const value: Record<string, unknown> = {};
  const sources = new Map<string, ConfigSource>();
  for (const patch of patches) {
    applyPatch(value, patch.values, patch.source, sources, '');
  }
  return { value, sources };
}

/**
 * Sets a dotted path (`http.port`) inside a nested object, creating the
 * intermediate objects. Used by `--set` and by the environment layer, both of
 * which address keys by path rather than by nesting.
 */
export function setAtPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split('.');
  let cursor = target;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const segment = segments[i];
    if (segment === undefined || segment === '__proto__') return;
    const next = cursor[segment];
    if (isPlainObject(next)) {
      cursor = next;
    } else {
      const created: Record<string, unknown> = {};
      cursor[segment] = created;
      cursor = created;
    }
  }
  const last = segments[segments.length - 1];
  if (last === undefined || last === '__proto__') return;
  cursor[last] = value;
}

/** Recursively freezes a value, so `AppConfig` cannot be mutated (DESIGN §2.4). */
export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}
