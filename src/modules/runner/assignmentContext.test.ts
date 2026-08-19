/**
 * `getAssignmentContext` — the stub runner M3 builds against, and the registry
 * lookup that lets orchestrator M1 replace it without a code change.
 *
 * The shape asserted here is orchestrator's pinned contract (runner §15.1-3,
 * orchestrator §2.3), so if the real provider ever returns something else, this
 * file is where the disagreement surfaces.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createAssignmentContextStub,
  resolveAssignmentContextProvider,
} from './assignmentContext.js';
import type { AssignmentContext, AssignmentContextProvider } from './contracts.js';
import { AssignmentNotFoundError } from './errors.js';
import { makeTempDir, openTestStorage, type TempDir } from './__tests__/helpers.js';
import type { Storage } from '../../storage/index.js';

let temp: TempDir;
let storage: Storage;

beforeEach(() => {
  temp = makeTempDir('agentmanager-runner-assignment-');
  storage = openTestStorage(`${temp.path}\\data`);
});

afterEach(() => {
  storage.close();
  temp.cleanup();
});

function seedAssignment(options: { tokenBudget?: number | null; closed?: boolean } = {}): string {
  const project = storage.store.projects.create({ slug: 'p', name: 'P' });
  const assignment = storage.store.assignments.create({
    projectId: project.id,
    pattern: 'solo',
    goal: 'ship it',
    ...(options.tokenBudget === undefined ? {} : { tokenBudget: options.tokenBudget }),
  });
  if (options.closed === true) {
    storage.store.assignments.close(assignment.id, { reason: 'user_closed' });
  }
  return assignment.id;
}

describe('the stub', () => {
  it('returns orchestrator’s pinned shape from the persisted row', async () => {
    const assignmentId = seedAssignment({ tokenBudget: 50_000 });
    const stub = createAssignmentContextStub({ assignments: storage.store.assignments });

    const context: AssignmentContext = await stub.getAssignmentContext(assignmentId);
    expect(context).toEqual({
      id: assignmentId,
      pattern: 'solo',
      status: 'open',
      write: true,
      scopeRules: {},
      // Two more the base row cannot answer, and the stub says so rather than
      // guessing: no pre-grants means every gate asks, which is the behaviour
      // every session had before the column existed.
      preGrantedTools: [],
      artifactPath: null,
      tokenBudget: 50_000,
      tokensUsed: 0,
      roundCap: null,
      roundsUsed: 0,
    });
  });

  it('reports a closed assignment as closed, so the launch chain refuses it', async () => {
    const assignmentId = seedAssignment({ closed: true });
    const stub = createAssignmentContextStub({ assignments: storage.store.assignments });
    expect((await stub.getAssignmentContext(assignmentId)).status).toBe('closed');
  });

  it('carries the seat role when the assignment has exactly one member', async () => {
    const assignmentId = seedAssignment();
    storage.store.agents.upsert({ id: 'priya', name: 'Priya' });
    storage.store.assignments.addMember(assignmentId, { agentId: 'priya', role: 'reviewer' });

    const stub = createAssignmentContextStub({ assignments: storage.store.assignments });
    expect((await stub.getAssignmentContext(assignmentId)).role).toBe('reviewer');
  });

  it('throws a typed 404 for an assignment nothing created — runner never mints one (D9)', async () => {
    const stub = createAssignmentContextStub({ assignments: storage.store.assignments });
    await expect(stub.getAssignmentContext('no-such-assignment')).rejects.toBeInstanceOf(
      AssignmentNotFoundError,
    );
  });
});

describe('the registry lookup', () => {
  const fallback: AssignmentContextProvider = {
    getAssignmentContext: () =>
      Promise.resolve({
        id: 'from-the-stub',
        pattern: 'solo',
        status: 'open',
        write: true,
        scopeRules: {},
        tokenBudget: null,
        tokensUsed: 0,
        roundCap: null,
        roundsUsed: 0,
      }),
  };

  it('uses the stub when orchestrator is not on the registry', async () => {
    const provider = resolveAssignmentContextProvider(undefined, fallback);
    expect((await provider.getAssignmentContext('a')).id).toBe('from-the-stub');
  });

  it('uses the stub when orchestrator is present but has not published the method yet', async () => {
    const provider = resolveAssignmentContextProvider({}, fallback);
    expect((await provider.getAssignmentContext('a')).id).toBe('from-the-stub');
  });

  it('prefers orchestrator’s implementation the moment it appears — a lookup, not a code change', async () => {
    const real: AssignmentContextProvider = {
      getAssignmentContext: (id) =>
        Promise.resolve({
          id,
          pattern: 'pair',
          status: 'open',
          role: 'implementer',
          write: false,
          scopeRules: { deny: ['Bash'] },
          tokenBudget: 10,
          tokensUsed: 3,
          roundCap: 4,
          roundsUsed: 1,
        }),
    };
    const provider = resolveAssignmentContextProvider(real, fallback);
    const context = await provider.getAssignmentContext('assignment-9');
    expect(context.id).toBe('assignment-9');
    expect(context.write).toBe(false);
    expect(context.scopeRules).toEqual({ deny: ['Bash'] });
  });
});
