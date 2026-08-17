/**
 * Scope path normalisation (§9-11) and the `scopeRules` emitter (§2.5), as
 * corrected by [SDK-NOTES.md](../../../docs/orchestrator/SDK-NOTES.md) **C1**.
 *
 * ## What C1 changed, and why this file emits one tool and not three
 *
 * DESIGN §2.5 states the write scope as three rules — `Edit(<path>)`,
 * `Write(<path>)`, `NotebookEdit(<path>)`. The SDK's own rule validator says two
 * of the three are inert:
 *
 * > `<rule>` is not matched by file permission checks — only `Edit(path)` rules
 * > are. Use `Edit(<content>)` instead (`Edit` rules cover all file-editing
 * > tools).
 *
 * The v1 slice would not have been broken by the extra two, because `Edit` is in
 * the list and does the whole job. But the *complement deny* is the half that
 * matters, and a deny of the form `Write(<everything else>)` is inert — so a
 * three-rule list reads like defence in depth while resting entirely on one of
 * its three entries. §2.5 calls the write scope "enforced", and that is the one
 * property a reader must be able to trust. So: **one tool, `Edit`, with a
 * one-line reason next to it**, per C1's required change 1.
 *
 * ## The `Edit(*)` trap (C1's required change 3)
 *
 * A rule whose content is exactly `*` collapses to the bare tool name — `Edit(*)`
 * parses to `Edit` — and under runner §5.3 a bare entry in `allowedTools`
 * auto-approves *before* `canUseTool` is consulted. A whole-project scope must
 * therefore emit **no** scope rule at all, never `Edit(*)`. `emitScopeRules`
 * returns `{}` for an empty path list for exactly that reason, and the test
 * suite pins it.
 *
 * ## What this file does not do
 *
 * It never computes an absolute path and never emits a `deny`. Paths stay
 * repo-relative — projects rewrites them onto the leased workspace root
 * (projects §1.3) before roster composes them — and the complement deny is
 * roster's to derive from the allow set (§6.2, R2), as is the mutating-tool deny
 * floor that `write === false` imposes. Orchestrator states the paths and the
 * flag; it never composes a rule set.
 */
import type { AssignmentScope, ScopeRules } from './types.js';

/** Why a path was rejected — surfaced verbatim in the §9-11 refusal. */
export type ScopePathProblem = 'empty' | 'absolute' | 'traversal' | 'glob';

export interface NormalisedPath {
  readonly input: string;
  /** Forward slashes, no leading `./`, directories keep their trailing `/`. */
  readonly path?: string;
  readonly problem?: ScopePathProblem;
}

/**
 * §9-11: "Scope paths are repo-relative, contain no `..`, and resolve inside the
 * project."
 *
 * Globs are rejected rather than passed through: §2.5 says "no globs, directory
 * or file", and a `*` reaching the rule content is the collapse-to-bare-tool
 * hazard C1 names. The `/**` suffix this file appends to a *directory* is added
 * here, after validation, so it is always ours and never the caller's.
 */
export function normaliseScopePath(input: string): NormalisedPath {
  const trimmed = input.trim().replace(/\\/g, '/');
  if (trimmed.length === 0) return { input, problem: 'empty' };
  // A drive letter or a leading slash is an absolute path in the only two
  // spellings Windows and POSIX offer.
  if (/^[a-zA-Z]:/.test(trimmed) || trimmed.startsWith('/')) return { input, problem: 'absolute' };
  if (trimmed.includes('*') || trimmed.includes('?')) return { input, problem: 'glob' };

  const segments: string[] = [];
  for (const segment of trimmed.split('/')) {
    if (segment === '' || segment === '.') continue;
    // `..` is rejected outright rather than resolved: a path that resolves back
    // inside the project after climbing out of it is still a path whose author
    // did not mean what they wrote, and §9-11 says "contain no `..`".
    if (segment === '..') return { input, problem: 'traversal' };
    segments.push(segment);
  }
  if (segments.length === 0) return { input, problem: 'empty' };

  const isDirectory = trimmed.endsWith('/');
  return { input, path: segments.join('/') + (isDirectory ? '/' : '') };
}

/**
 * §2.5's rules for one scope.
 *
 * A directory (`docs/`) becomes `Edit(./docs/**)`; a file (`docs/x/DESIGN.md`)
 * becomes `Edit(./docs/x/DESIGN.md)`. The leading `./` matches the form §2.5
 * writes and is what marks the rule content as workspace-relative to the
 * consumer that rewrites it.
 *
 * @param scope the assignment's scope, or `null`/`undefined` for whole-project
 * @param write `false` emits **no** rules: roster's compiler unions a
 *   mutating-tool deny for the flag (§2.5, R2), and a read-only assignment needs
 *   nothing else. Emitting an allow-list alongside that floor would suggest the
 *   allow-list was what made it read-only.
 */
export function emitScopeRules(
  scope: AssignmentScope | null | undefined,
  write: boolean,
): ScopeRules {
  if (!write) return {};

  const paths = scope?.paths ?? [];
  const allow: string[] = [];
  for (const raw of paths) {
    const normalised = normaliseScopePath(raw);
    // An invalid path never reaches here — §9-11 refused the create — so this is
    // a belt-and-braces skip rather than a silent drop of a meaningful rule.
    if (normalised.path === undefined) continue;
    allow.push(
      normalised.path.endsWith('/') ? `Edit(./${normalised.path}**)` : `Edit(./${normalised.path})`,
    );
  }

  // C1-3: a whole-project scope emits no rule. `Edit(*)` would collapse to the
  // bare `Edit` and auto-approve ahead of `canUseTool`, which is the opposite of
  // what "whole project" is supposed to mean.
  if (allow.length === 0) return {};
  // Deduplicated and ordered so two equivalent scopes compile to byte-identical
  // rule sets, which is what makes the compiled permissions of §9.1 diffable.
  return { allow: [...new Set(allow)].sort() };
}
