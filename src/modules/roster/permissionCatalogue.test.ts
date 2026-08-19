/**
 * The curated permission rules, and the route that shows them (§6.3, WO2).
 *
 * WO2's acceptance list for this element is two claims, and both are about the
 * catalogue being *one* list rather than two:
 *
 * - "the route serves exactly the catalogue `draft.ts` consumes (same array
 *   identity or a parity assertion)" — asserted as identity, which is the
 *   stronger of the two offered: a copy that happened to be equal today would
 *   pass a parity check and drift tomorrow.
 * - "every catalogue `rule` passes `permissionRuleSchema`" — the picker writes
 *   these strings straight into `permissions.allow`, so a catalogue entry the
 *   schema would reject is a 400 the user could not have predicted from a form
 *   that offered it.
 *
 * The move itself is also guarded: the twenty `rule` strings are the vocabulary
 * `sanitisePermissions` holds a draft to (§12.2), so this file pins the count and
 * the drafting prompt's continued use of the same objects.
 */
import { describe, expect, it } from 'vitest';

import { CATALOGUE_RULES, PERMISSION_RULE_CATALOGUE, draftSystemPrompt } from './draft.js';
import {
  CATALOGUE_GROUPS,
  CATALOGUE_SUGGESTIONS,
  PERMISSION_RULE_CATALOGUE as CATALOGUE,
} from './permissionCatalogue.js';
import { PREFLIGHT_TOOL_CATALOGUE } from './preflight.js';
import { createRosterRoutes } from './routes.js';
import { permissionRuleSchema } from './schema.js';
import { ruleTool } from './sdkRules.js';

import {
  callRoute,
  makeHarness,
  makeSpacedTempDir,
  silentLogger,
  type Harness,
  type TempDir,
} from './__tests__/helpers.js';

describe('the catalogue module (§6.3, §12.2)', () => {
  it('is the same list drafting consumes — one array, not two', () => {
    // Identity rather than equality: `draft.ts` re-exports rather than copying,
    // which is what makes "the prompt and the picker describe a rule the same
    // way" a property of the build.
    expect(PERMISSION_RULE_CATALOGUE).toBe(CATALOGUE);
    expect(CATALOGUE_RULES).toEqual(CATALOGUE.map((entry) => entry.rule));
  });

  it('changed no rule string in the move — the sanitiser judges drafts by these', () => {
    expect(CATALOGUE.map((entry) => entry.rule)).toEqual([
      'Read',
      'Glob',
      'Grep',
      'Edit',
      'Write',
      'NotebookEdit',
      'TodoWrite',
      'WebSearch',
      'WebFetch',
      'Bash(git status)',
      'Bash(git diff*)',
      'Bash(git add*)',
      'Bash(git commit*)',
      'Bash(git push*)',
      'Bash(npm run test:*)',
      'Bash(npm run lint)',
      'Bash(npm run build)',
      'Bash(npm install*)',
      'Bash(rm *)',
      'Bash(* > *)',
    ]);
  });

  it('still builds the drafting prompt from the same entries (§12.2)', () => {
    const prompt = draftSystemPrompt();
    for (const entry of CATALOGUE) {
      expect(prompt).toContain(entry.rule);
      expect(prompt).toContain(entry.description);
    }
  });

  it('gives every entry a group and a suggestion from the closed vocabularies', () => {
    for (const entry of CATALOGUE) {
      expect(CATALOGUE_GROUPS).toContain(entry.group);
      expect(CATALOGUE_SUGGESTIONS).toContain(entry.suggest);
    }
    // Not a formatting detail: the picker renders one section per group and an
    // empty section is a heading with nothing under it.
    expect([...new Set(CATALOGUE.map((entry) => entry.group))].sort()).toEqual(
      [...CATALOGUE_GROUPS].sort(),
    );
  });

  it('offers no rule the schema would refuse — the form cannot suggest a 400', () => {
    for (const entry of CATALOGUE) {
      expect(permissionRuleSchema.safeParse(entry.rule).success).toBe(true);
    }
  });

  it('keeps AskUserQuestion out, because a bare allow on it disables the bridge', () => {
    // runner SDK-NOTES C2, enforced in `sdkRules.ts`. A catalogue that offered it
    // would be inviting the one grant the normaliser exists to undo.
    expect(CATALOGUE.map((entry) => entry.rule)).not.toContain('AskUserQuestion');
    expect(CATALOGUE.some((entry) => ruleTool(entry.rule) === 'AskUserQuestion')).toBe(false);
  });
});

describe('GET /api/roster/permission-catalogue', () => {
  let temp: TempDir;
  let harness: Harness;

  it('serves the catalogue and the tool names, and touches no agent', async () => {
    temp = makeSpacedTempDir();
    harness = makeHarness({ dataRoot: temp.path });
    try {
      const routes = createRosterRoutes({ service: harness.service, logger: silentLogger() });
      const answer = await callRoute(routes, 'GET', '/api/roster/permission-catalogue');

      expect(answer.status).toBe(200);
      const body = answer.body as { rules: unknown; tools: unknown };
      expect(body.rules).toEqual(CATALOGUE);
      expect(body.tools).toEqual(PREFLIGHT_TOOL_CATALOGUE);
      // §6.3's order is part of the contract — `Bash` first, then the file
      // mutators — because the caller renders it rather than sorting it.
      expect((body.tools as readonly string[])[0]).toBe('Bash');
    } finally {
      harness.close();
      temp.cleanup();
    }
  });
});
