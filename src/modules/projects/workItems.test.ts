/**
 * The backlog (projects DESIGN §1.5, §7.2; IMPLEMENTATION M8).
 *
 * M8's four acceptance criteria:
 *
 * 1. "An item created from the UI appears in `GET /work-items?status=open` in
 *    rank order; reordering persists";
 * 2. "Linking an item to an assignment that then starts flips it to
 *    `in_progress`; the assignment ending without user action returns it to
 *    `open`";
 * 3. "Marking `done` sets `closedAt` and is **not undone** by later assignment
 *    events";
 * 4. "Launching with no work item works unchanged (the link is nullable end to
 *    end)."
 *
 * Criterion 3 is the one that needs guarding rather than merely implementing:
 * `open ⇄ in_progress` is a projection of `work_item_assignments`, but `done`
 * and `dropped` are the human's words, and a derived transition that could
 * overwrite one would silently reopen work somebody had closed.
 */
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { hasWorkItemLinker } from '../orchestrator/ports.js';

import type { Project } from './types.js';
import {
  makeHarness,
  makeTempDir,
  refusalFrom,
  type TempDir,
  type TestHarness,
} from './__tests__/helpers.js';

let dataRootDir: TempDir;
let workDir: TempDir;
let harness: TestHarness | undefined;

beforeEach(() => {
  dataRootDir = makeTempDir('agentmanager-projects-workitems-data-');
  workDir = makeTempDir('agentmanager-projects-workitems-work-');
  harness = undefined;
});

afterEach(() => {
  harness?.storage.close();
  harness = undefined;
  dataRootDir.cleanup();
  workDir.cleanup();
});

function open(): TestHarness {
  harness = makeHarness({
    dataRoot: dataRootDir.path,
    projectsRoot: resolve(workDir.path, 'projects'),
  });
  return harness;
}

async function makeProject(h: TestHarness, name = 'App'): Promise<Project> {
  const folder = resolve(workDir.path, name);
  mkdirSync(folder, { recursive: true });
  return h.service.create({ localPath: folder });
}

/** An assignment row, so `linkWorkItems` can resolve its project (§1.5). */
function makeAssignment(h: TestHarness, project: Project, id: string): string {
  h.storage.store.assignments.create({ id, projectId: project.id, pattern: 'solo' });
  return id;
}

// ---------------------------------------------------------------------------
// M8 acceptance 1
// ---------------------------------------------------------------------------

describe('CRUD and ordering (M8 acceptance 1)', () => {
  it('lists open items in rank order, and a reorder persists', async () => {
    const h = open();
    const project = await makeProject(h);

    const first = h.service.createWorkItem(project.id, { kind: 'bug', title: 'the crash' });
    const second = h.service.createWorkItem(project.id, { kind: 'feature', title: 'dark mode' });
    const third = h.service.createWorkItem(project.id, { kind: 'chore', title: 'bump deps' });

    expect(
      h.service.listWorkItems(project.id, { status: 'open' }).map((item) => item.title),
    ).toEqual(['the crash', 'dark mode', 'bump deps']);

    // `rank` is REAL precisely so an item drops between two neighbours without
    // renumbering the list (§1.5).
    h.service.updateWorkItem(third.id, { rank: (first.rank + second.rank) / 2 });

    expect(h.service.listWorkItems(project.id).map((item) => item.title)).toEqual([
      'the crash',
      'bump deps',
      'dark mode',
    ]);

    // And it is durable, not an in-memory sort.
    expect(h.workItems.list(project.id).map((item) => item.title)).toEqual([
      'the crash',
      'bump deps',
      'dark mode',
    ]);
  });

  it('stores the thin field set of §1.5 and nothing more', async () => {
    const h = open();
    const project = await makeProject(h, 'Fields');

    const item = h.service.createWorkItem(project.id, {
      kind: 'question',
      title: 'which database?',
      body: '## options\n\n- sqlite\n- postgres\n',
      scopePaths: ['docs/adr'],
    });

    expect(item).toMatchObject({
      projectId: project.id,
      kind: 'question',
      title: 'which database?',
      status: 'open',
      source: 'user',
      scopePaths: ['docs/adr'],
      closedAt: null,
    });
    // No priority, no assignee, no labels, no dependencies (§7.2).
    expect(Object.keys(item).sort()).toEqual([
      'body',
      'closedAt',
      'createdAt',
      'id',
      'kind',
      'projectId',
      'rank',
      'scopePaths',
      'source',
      'status',
      'title',
      'updatedAt',
    ]);
  });

  it('filters by status, and emits workitem.created / workitem.updated', async () => {
    const h = open();
    const project = await makeProject(h, 'Filtered');
    const open_ = h.service.createWorkItem(project.id, { kind: 'bug', title: 'still open' });
    const dropped = h.service.createWorkItem(project.id, { kind: 'bug', title: 'never mind' });
    h.service.updateWorkItem(dropped.id, { status: 'dropped' });

    expect(h.service.listWorkItems(project.id, { status: 'open' }).map((i) => i.id)).toEqual([
      open_.id,
    ]);
    expect(h.service.listWorkItems(project.id, { status: 'dropped' }).map((i) => i.id)).toEqual([
      dropped.id,
    ]);

    expect(h.events.filter((event) => event.type === 'workitem.created')).toHaveLength(2);
    expect(h.events.find((event) => event.type === 'workitem.updated')?.payload).toMatchObject({
      id: dropped.id,
      status: 'dropped',
    });
  });

  it('refuses an unknown project, and an unknown item id', async () => {
    const h = open();
    await makeProject(h, 'Known');
    expect(refusalFrom(() => h.service.listWorkItems('ghost')).code).toBe('project_not_found');
    expect(refusalFrom(() => h.service.updateWorkItem('ghost', { title: 'x' })).code).toBe(
      'work_item_not_found',
    );
  });
});

// ---------------------------------------------------------------------------
// M8 acceptance 2
// ---------------------------------------------------------------------------

describe('derived status (M8 acceptance 2)', () => {
  it('flips to in_progress when a linked assignment starts, and back on close', async () => {
    const h = open();
    const project = await makeProject(h, 'Derived');
    const item = h.service.createWorkItem(project.id, { kind: 'bug', title: 'the crash' });
    const assignment = makeAssignment(h, project, 'assignment-1');

    h.service.linkWorkItems(assignment, [item.id]);
    // Linking alone changes nothing: an item is `in_progress` when work starts,
    // not when it is planned.
    expect(h.workItems.get(item.id)?.status).toBe('open');

    h.service.noteAssignmentStarted(assignment);
    expect(h.workItems.get(item.id)?.status).toBe('in_progress');

    // "the assignment ending without user action returns it to `open`"
    h.service.unlinkWorkItems(assignment);
    expect(h.workItems.get(item.id)?.status).toBe('open');
    expect(h.workItems.get(item.id)?.closedAt).toBeNull();
  });

  it('keeps an item in_progress while another linked assignment is still running', async () => {
    const h = open();
    const project = await makeProject(h, 'TwoWays');
    const item = h.service.createWorkItem(project.id, { kind: 'feature', title: 'shared' });
    const first = makeAssignment(h, project, 'assignment-first');
    const second = makeAssignment(h, project, 'assignment-second');

    h.service.linkWorkItems(first, [item.id]);
    h.service.linkWorkItems(second, [item.id]);
    h.service.noteAssignmentStarted(first);
    expect(h.workItems.get(item.id)?.status).toBe('in_progress');

    // §1.5: "back to `open` if **every** linked assignment ends".
    h.workItems.noteAssignmentEnded(first, (id) => id === second);
    expect(h.workItems.get(item.id)?.status).toBe('in_progress');

    h.workItems.noteAssignmentEnded(second, () => false);
    expect(h.workItems.get(item.id)?.status).toBe('open');
  });

  it('is idempotent in both directions', async () => {
    const h = open();
    const project = await makeProject(h, 'Idempotent');
    const item = h.service.createWorkItem(project.id, { kind: 'chore', title: 'twice' });
    const assignment = makeAssignment(h, project, 'assignment-twice');

    h.service.linkWorkItems(assignment, [item.id, item.id]);
    h.service.linkWorkItems(assignment, [item.id]);
    expect(h.workItems.assignmentsFor(item.id)).toEqual([assignment]);

    h.service.unlinkWorkItems(assignment);
    h.service.unlinkWorkItems(assignment);
    expect(h.workItems.assignmentsFor(item.id)).toEqual([]);
  });

  it('refuses an item from another project, naming it, and writes nothing', async () => {
    const h = open();
    const mine = await makeProject(h, 'Mine');
    const theirs = await makeProject(h, 'Theirs');
    const ours = h.service.createWorkItem(mine.id, { kind: 'bug', title: 'ours' });
    const foreign = h.service.createWorkItem(theirs.id, { kind: 'bug', title: 'not ours' });
    const assignment = makeAssignment(h, mine, 'assignment-mixed');

    expect(refusalFrom(() => h.service.linkWorkItems(assignment, [ours.id, foreign.id])).code).toBe(
      'work_item_project_mismatch',
    );
    // Validated before written: neither of the two is linked.
    expect(h.workItems.itemsFor(assignment)).toEqual([]);
  });

  it('refuses an id that names no item', async () => {
    const h = open();
    const project = await makeProject(h, 'Ghosts');
    const assignment = makeAssignment(h, project, 'assignment-ghost');
    expect(refusalFrom(() => h.service.linkWorkItems(assignment, ['no-such-item'])).code).toBe(
      'work_item_not_found',
    );
  });
});

// ---------------------------------------------------------------------------
// M8 acceptance 3
// ---------------------------------------------------------------------------

describe('done is the human’s word (M8 acceptance 3)', () => {
  it('sets closedAt, and no later assignment event undoes it', async () => {
    const h = open();
    const project = await makeProject(h, 'Closed');
    const item = h.service.createWorkItem(project.id, { kind: 'bug', title: 'fixed it' });
    const assignment = makeAssignment(h, project, 'assignment-done');
    h.service.linkWorkItems(assignment, [item.id]);
    h.service.noteAssignmentStarted(assignment);

    const done = h.service.updateWorkItem(item.id, { status: 'done' });
    expect(done.status).toBe('done');
    expect(done.closedAt).not.toBeNull();

    // Every derived transition, in both directions, must leave it alone.
    h.service.noteAssignmentStarted(assignment);
    expect(h.workItems.get(item.id)?.status).toBe('done');
    h.service.unlinkWorkItems(assignment);
    expect(h.workItems.get(item.id)?.status).toBe('done');
    expect(h.workItems.get(item.id)?.closedAt).toBe(done.closedAt);
  });

  it('treats dropped the same way', async () => {
    const h = open();
    const project = await makeProject(h, 'Dropped');
    const item = h.service.createWorkItem(project.id, { kind: 'chore', title: 'not doing it' });
    const assignment = makeAssignment(h, project, 'assignment-dropped');
    h.service.linkWorkItems(assignment, [item.id]);
    h.service.updateWorkItem(item.id, { status: 'dropped' });

    h.service.noteAssignmentStarted(assignment);
    expect(h.workItems.get(item.id)?.status).toBe('dropped');
  });

  it('clears closedAt when a closed item is deliberately reopened', async () => {
    const h = open();
    const project = await makeProject(h, 'Reopened');
    const item = h.service.createWorkItem(project.id, { kind: 'bug', title: 'came back' });
    h.service.updateWorkItem(item.id, { status: 'done' });

    const reopened = h.service.updateWorkItem(item.id, { status: 'open' });
    expect(reopened.status).toBe('open');
    // "Closed" and "has a closing timestamp" must not be able to disagree.
    expect(reopened.closedAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// M8 acceptance 4, and orchestrator's probe
// ---------------------------------------------------------------------------

describe('the link is nullable end to end (M8 acceptance 4)', () => {
  it('writes no rows for an assignment created with no items', async () => {
    const h = open();
    const project = await makeProject(h, 'Unlinked');
    const assignment = makeAssignment(h, project, 'assignment-bare');

    h.service.linkWorkItems(assignment, []);
    expect(h.workItems.itemsFor(assignment)).toEqual([]);

    // And the whole lifecycle still works without a single link.
    h.service.noteAssignmentStarted(assignment);
    h.service.unlinkWorkItems(assignment);
    expect(h.service.activity(project.id).entries[0]?.workItemIds).toEqual([]);
  });

  it('leaves an item nobody linked simply open', async () => {
    const h = open();
    const project = await makeProject(h, 'Lonely');
    const item = h.service.createWorkItem(project.id, { kind: 'bug', title: 'no time now' });

    const assignment = makeAssignment(h, project, 'assignment-elsewhere');
    h.service.noteAssignmentStarted(assignment);

    expect(h.workItems.get(item.id)?.status).toBe('open');
  });
});

describe('orchestrator’s work-item probe (§1.5, orchestrator §17 R4)', () => {
  it('now finds the real methods on the published service', async () => {
    const h = open();
    const project = await makeProject(h, 'Probed');

    // `hasWorkItemLinker` is orchestrator's own predicate, imported rather than
    // restated: before M8 it was false and `createSolo` refused any request
    // naming work items. The service this element publishes is what it probes.
    expect(hasWorkItemLinker(h.service)).toBe(true);

    const item = h.service.createWorkItem(project.id, { kind: 'bug', title: 'probed' });
    expect(h.service.getWorkItem(item.id)).toEqual({ id: item.id, projectId: project.id });
    expect(h.service.getWorkItem('nope')).toBeUndefined();
  });
});
