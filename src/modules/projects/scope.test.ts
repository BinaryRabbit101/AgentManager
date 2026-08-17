/**
 * Scope handling and conflict warnings (projects DESIGN §1.3, §4.3;
 * IMPLEMENTATION M7).
 *
 * M7's three acceptance criteria:
 *
 * 1. "A scope of `src/api` in a worktree produces rules rooted at the **worktree
 *    path**, not `localPath`, and those rules reach roster's
 *    `compilePermissions` as assignment-scope input";
 * 2. "Two shared-workspace assignments scoped to `src/api` and `src/api/routes`
 *    emit **one** overlap event naming both assignments and the overlapping
 *    prefix; disjoint scopes emit nothing";
 * 3. "The overlap event never blocks acquisition or session start."
 *
 * Criterion 1's second half is checked against roster's real compiler rather
 * than restated: DESIGN §1.3 says what projects produces is "input rules for
 * roster to compose, **not an effective set**", and the only way to show that
 * distinction is true is to hand the rules to the thing that composes them.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { compilePermissions } from '../roster/permissions.js';

import {
  findScopeOverlaps,
  normaliseScopePath,
  overlappingPrefixes,
  rewriteScopeRules,
  summariseScope,
  toRuleRoot,
} from './scope.js';
import { isWorkspaceRefusal, type Project } from './types.js';
import {
  hasGit,
  makeGitRepo,
  makeHarness,
  makeTempDir,
  realGit,
  type TempDir,
  type TestHarness,
} from './__tests__/helpers.js';

let dataRootDir: TempDir;
let workDir: TempDir;
let harness: TestHarness | undefined;

beforeEach(() => {
  dataRootDir = makeTempDir('agentmanager-projects-scope-data-');
  workDir = makeTempDir('agentmanager-projects-scope-work-');
  harness = undefined;
});

afterEach(() => {
  harness?.storage.close();
  harness = undefined;
  dataRootDir.cleanup();
  workDir.cleanup();
});

function open(options: { git?: boolean } = {}): TestHarness {
  harness = makeHarness({
    dataRoot: dataRootDir.path,
    projectsRoot: resolve(workDir.path, 'projects'),
    worktreesRoot: resolve(workDir.path, 'worktrees'),
    ...(options.git === true ? { git: realGit() } : {}),
  });
  return harness;
}

async function plainProject(h: TestHarness, name = 'App'): Promise<Project> {
  const folder = resolve(workDir.path, name);
  mkdirSync(folder, { recursive: true });
  return h.service.create({ localPath: folder });
}

async function gitProject(h: TestHarness, name = 'repo'): Promise<Project> {
  const folder = resolve(workDir.path, name);
  makeGitRepo(folder);
  mkdirSync(resolve(folder, 'src', 'api'), { recursive: true });
  writeFileSync(resolve(folder, 'src', 'api', 'index.ts'), 'export {};\n', 'utf8');
  execFileSync('git', ['-C', folder, 'add', '-A'], { stdio: 'ignore', windowsHide: true });
  execFileSync('git', ['-C', folder, 'commit', '-m', 'src'], {
    stdio: 'ignore',
    windowsHide: true,
  });
  return h.service.create({ localPath: folder });
}

function leaseOrThrow(result: Awaited<ReturnType<TestHarness['service']['acquireWorkspace']>>) {
  if (isWorkspaceRefusal(result)) throw new Error(`the workspace was refused: ${result.reason}`);
  return result;
}

// ---------------------------------------------------------------------------
// Rewriting (§1.3)
// ---------------------------------------------------------------------------

describe('normaliseScopePath', () => {
  it.each([
    ['src/api', 'src/api'],
    ['./src/api', 'src/api'],
    ['src\\api', 'src/api'],
    ['src//api//', 'src/api'],
  ])('normalises %s to %s', (input, expected) => {
    expect(normaliseScopePath(input).path).toBe(expected);
  });

  it('keeps an explicit trailing slash as the directory marker', () => {
    expect(normaliseScopePath('docs/')).toMatchObject({ path: 'docs', directory: true });
    expect(normaliseScopePath('docs').directory).toBeUndefined();
  });

  it.each([['/etc/passwd'], ['C:\\Windows'], ['../outside'], ['src/**'], ['src/?'], ['   ']])(
    'drops %s rather than repairing it into a rule nobody wrote',
    (input) => {
      expect(normaliseScopePath(input).path).toBeUndefined();
    },
  );
});

describe('rewriteScopeRules (§1.3, M7 acceptance 1)', () => {
  it('roots the rules at the workspace, with forward slashes and one tool', () => {
    const rules = rewriteScopeRules('C:\\Local\\worktrees\\app\\1a2b3c4d', ['src/api/']);
    // One tool, `Edit`: orchestrator SDK-NOTES C1 — `Write(path)` and
    // `NotebookEdit(path)` rules parse and are then never consulted.
    expect(rules.allow).toEqual(['Edit(C:/Local/worktrees/app/1a2b3c4d/src/api/**)']);
  });

  it('emits a file scope without the /** suffix', () => {
    const rules = rewriteScopeRules('C:\\ws', ['docs/DESIGN.md']);
    expect(rules.allow).toEqual(['Edit(C:/ws/docs/DESIGN.md)']);
  });

  it('emits **no** rule for a whole-project scope — never Edit(*)', () => {
    // C1-3: rule content of exactly `*` collapses to the bare tool name, which
    // in `allowedTools` auto-approves every file edit ahead of `canUseTool`.
    expect(rewriteScopeRules('C:\\ws', []).allow).toEqual([]);
    expect(rewriteScopeRules('C:\\ws', undefined).allow).toEqual([]);
    expect(rewriteScopeRules('C:\\ws', ['../escape']).allow).toEqual([]);
  });

  it('deduplicates and sorts, so equivalent scopes compile identically', () => {
    const a = rewriteScopeRules('C:\\ws', ['src/', 'docs/', 'src/']);
    const b = rewriteScopeRules('C:\\ws', ['docs/', 'src/']);
    expect(a.allow).toEqual(b.allow);
    expect(a.allow).toEqual(['Edit(C:/ws/docs/**)', 'Edit(C:/ws/src/**)']);
  });

  it('strips a trailing separator from the root', () => {
    expect(toRuleRoot('C:\\ws\\')).toBe('C:/ws');
  });
});

describe('summariseScope', () => {
  it('renders a one-line summary for the timeline, or null', () => {
    expect(summariseScope(['src/api', 'docs/'])).toBe('docs, src/api');
    expect(summariseScope([])).toBeNull();
    expect(summariseScope(undefined)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// M7 acceptance 1, end to end
// ---------------------------------------------------------------------------

describe.runIf(hasGit())('scope rules on a leased worktree (M7 acceptance 1)', () => {
  it('roots them at the worktree, not at localPath', async () => {
    const h = open({ git: true });
    const project = await gitProject(h);

    // The first writer holds the primary tree; the second gets a worktree — the
    // one case §4.1 says is worth one, and the case the rewrite exists for.
    leaseOrThrow(
      await h.service.acquireWorkspace(project.id, 'assignment-first', {
        write: true,
        scopePaths: ['docs/'],
      }),
    );
    const worktree = leaseOrThrow(
      await h.service.acquireWorkspace(project.id, 'assignment-second', {
        write: true,
        scopePaths: ['src/api'],
      }),
    );
    expect(worktree.kind).toBe('worktree');

    const context = await h.service.getEffectiveLaunchContext(project.id, 'assignment-second');
    expect(context.cwd).toBe(worktree.path);

    const allow = context.scopeRules?.allow ?? [];
    expect(allow).toEqual([`Edit(${toRuleRoot(worktree.path)}/src/api/**)`]);
    // The whole point: *not* the project folder.
    expect(allow[0]).not.toContain(toRuleRoot(project.localPath));
  });

  it('reaches roster’s compilePermissions as assignment-scope input, not an effective set', async () => {
    const h = open({ git: true });
    const project = await gitProject(h, 'compiled');
    leaseOrThrow(await h.service.acquireWorkspace(project.id, 'assignment-a', { write: true }));
    const worktree = leaseOrThrow(
      await h.service.acquireWorkspace(project.id, 'assignment-b', {
        write: true,
        scopePaths: ['src/api/'],
      }),
    );
    const context = await h.service.getEffectiveLaunchContext(project.id, 'assignment-b');

    // §1.3 / §7.6: projects composes nothing. It hands the rules over, and
    // roster's compiler is the sole composer.
    expect(context).not.toHaveProperty('permissions');

    const rule = context.scopeRules?.allow[0];
    expect(rule).toBe(`Edit(${toRuleRoot(worktree.path)}/src/api/**)`);
    if (rule === undefined) throw new Error('no scope rule was produced');

    const policy = { allowPermissionElevation: true, globalDeny: [] };
    const compiled = compilePermissions(
      { mode: 'default', allow: [rule, 'Read'] },
      undefined,
      { write: true, scopeRules: { allow: [rule] } },
      policy,
    );
    // `allow` intersects (roster §6.2), so a scope rule that is in the agent's
    // baseline survives — which is what "input rules" means.
    expect(compiled.effective.allow).toContain(rule);

    // And the monotonic-narrowing rule, from the other direction: a scope rule
    // the baseline does not carry is dropped rather than granted. Projects
    // supplies material; it grants nothing.
    const narrowed = compilePermissions(
      { mode: 'default', allow: ['Read'] },
      undefined,
      { write: true, scopeRules: { allow: [rule] } },
      policy,
    );
    expect(narrowed.effective.allow).not.toContain(rule);
  });

  it('carries no scopeRules key at all for a whole-project assignment', async () => {
    const h = open({ git: true });
    const project = await gitProject(h, 'unscoped');
    leaseOrThrow(await h.service.acquireWorkspace(project.id, 'assignment-x', { write: true }));

    const context = await h.service.getEffectiveLaunchContext(project.id, 'assignment-x');
    expect(context.scopeRules).toBeUndefined();
  });

  it('survives a restart: the scope is on the lease, not in memory', async () => {
    const h = open({ git: true });
    const project = await gitProject(h, 'durable');
    leaseOrThrow(
      await h.service.acquireWorkspace(project.id, 'assignment-durable', {
        write: true,
        scopePaths: ['src/api'],
      }),
    );

    // Closing and reopening the whole stack over the same data root is what a
    // restart is, minus the process boundary — and the launch context still
    // knows the scope, because it was never in memory to begin with.
    h.storage.close();
    harness = makeHarness({
      dataRoot: dataRootDir.path,
      projectsRoot: resolve(workDir.path, 'projects'),
      worktreesRoot: resolve(workDir.path, 'worktrees'),
      git: realGit(),
    });

    const context = await harness.service.getEffectiveLaunchContext(
      project.id,
      'assignment-durable',
    );
    expect(context.scopeRules?.allow).toEqual([
      `Edit(${toRuleRoot(project.localPath)}/src/api/**)`,
    ]);
  });
});

// ---------------------------------------------------------------------------
// M7 acceptance 2 and 3
// ---------------------------------------------------------------------------

describe('overlappingPrefixes', () => {
  it('finds a prefix overlap and reports the shorter path', () => {
    expect(overlappingPrefixes(['src/api'], ['src/api/routes'])).toEqual(['src/api']);
    expect(overlappingPrefixes(['src/api/routes'], ['src/api'])).toEqual(['src/api']);
    expect(overlappingPrefixes(['src/api'], ['src/api'])).toEqual(['src/api']);
  });

  it('does not mistake a shared name prefix for a path prefix', () => {
    // `src/api` and `src/apiv2` are different directories, and a bare
    // `startsWith` would call them nested.
    expect(overlappingPrefixes(['src/api'], ['src/apiv2'])).toEqual([]);
  });

  it('treats a whole-project scope as overlapping everything', () => {
    expect(overlappingPrefixes([], ['src/api'])).toEqual(['.']);
    expect(overlappingPrefixes(['src/api'], [])).toEqual(['.']);
  });

  it('finds nothing between disjoint scopes', () => {
    expect(overlappingPrefixes(['src/api'], ['web/ui'])).toEqual([]);
  });
});

describe('findScopeOverlaps', () => {
  it('compares only assignments sharing one workspace', () => {
    const overlaps = findScopeOverlaps(
      { assignmentId: 'b', workspacePath: 'C:\\ws\\one', scopePaths: ['src/api'] },
      [
        // Same tree, overlapping — reported.
        { assignmentId: 'a', workspacePath: 'C:\\WS\\ONE', scopePaths: ['src/api/routes'] },
        // A different worktree: two checkouts cannot collide on a file (§4.1).
        { assignmentId: 'c', workspacePath: 'C:\\ws\\two', scopePaths: ['src/api'] },
      ],
    );
    expect(overlaps).toHaveLength(1);
    expect(overlaps[0]?.assignmentIds).toEqual(['b', 'a']);
    expect(overlaps[0]?.paths).toEqual(['src/api']);
  });
});

describe('project.scope.overlap (M7 acceptances 2 and 3)', () => {
  it('emits one event naming both assignments and the overlapping prefix', async () => {
    const h = open();
    // A non-git project behaves as `shared` (§4.2), which is exactly the
    // "second write-capable assignment in the *same* workspace" case §4.3 warns
    // about — with a reader alongside a writer, which takes no hold.
    const project = await plainProject(h);

    leaseOrThrow(
      await h.service.acquireWorkspace(project.id, 'assignment-writer', {
        write: true,
        scopePaths: ['src/api'],
      }),
    );
    const second = await h.service.acquireWorkspace(project.id, 'assignment-reader', {
      write: false,
      scopePaths: ['src/api/routes'],
    });

    // Acceptance 3: the warning never blocks — the lease was granted.
    expect(isWorkspaceRefusal(second)).toBe(false);

    const overlaps = h.events.filter((event) => event.type === 'project.scope.overlap');
    expect(overlaps).toHaveLength(1);
    expect(overlaps[0]?.payload).toMatchObject({
      projectId: project.id,
      workspacePath: project.localPath,
      assignmentIds: ['assignment-reader', 'assignment-writer'],
      paths: ['src/api'],
    });
  });

  it('emits nothing for disjoint scopes', async () => {
    const h = open();
    const project = await plainProject(h, 'Disjoint');

    leaseOrThrow(
      await h.service.acquireWorkspace(project.id, 'assignment-one', {
        write: true,
        scopePaths: ['src/api'],
      }),
    );
    leaseOrThrow(
      await h.service.acquireWorkspace(project.id, 'assignment-two', {
        write: false,
        scopePaths: ['web/ui'],
      }),
    );

    expect(h.events.filter((event) => event.type === 'project.scope.overlap')).toHaveLength(0);
  });

  it('emits nothing when the first assignment is alone in the tree', async () => {
    const h = open();
    const project = await plainProject(h, 'Alone');
    leaseOrThrow(
      await h.service.acquireWorkspace(project.id, 'assignment-only', {
        write: true,
        scopePaths: ['src/api'],
      }),
    );
    expect(h.events.filter((event) => event.type === 'project.scope.overlap')).toHaveLength(0);
  });

  it('never blocks a session start: the launch context is still produced', async () => {
    const h = open();
    const project = await plainProject(h, 'Unblocked');
    leaseOrThrow(
      await h.service.acquireWorkspace(project.id, 'assignment-a', {
        write: true,
        scopePaths: ['src'],
      }),
    );
    leaseOrThrow(
      await h.service.acquireWorkspace(project.id, 'assignment-b', {
        write: false,
        scopePaths: ['src/deep'],
      }),
    );

    expect(h.events.some((event) => event.type === 'project.scope.overlap')).toBe(true);
    const context = await h.service.getEffectiveLaunchContext(project.id, 'assignment-b');
    expect(context.cwd).toBe(project.localPath);
  });
});
