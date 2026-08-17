/**
 * The editor's form model (ui IMPLEMENTATION §8).
 *
 * Two criteria are properties of this file rather than of any screen:
 *
 * - **"The saved definition is byte-equal to what the form posted (no
 *   client-side merge, no server reconciliation)."** The round trip against a
 *   real core is `web/e2e/agent.test.ts`; what is asserted here is the half that
 *   makes it possible — `toCreateBody` reads the form and nothing else.
 * - **"`persona.md` round-trips byte-for-byte through the textarea, including
 *   trailing whitespace and Windows line endings."**
 *
 * Plus the redraft guard: `hasEdits` is what decides whether a swap costs the
 * user anything, and §7.1 forbids a silent overwrite either way.
 */
import { describe, expect, it } from 'vitest';

import type { AgentView, DraftResponse } from '../api/types';

import {
  EMPTY_MODEL,
  fromAgent,
  fromDraft,
  hasEdits,
  linesOf,
  rulesOf,
  toCreateBody,
} from './editorModel';

const DRAFT: DraftResponse = {
  draft: {
    name: 'Priya',
    specialty: 'bug-patching',
    tagline: 'Reproduces first, then fixes.',
    avatar: { kind: 'emoji', value: '🐛' },
    persona: { mode: 'append', file: 'persona.md' },
    model: { primary: 'sonnet' },
    permissions: { mode: 'acceptEdits', allow: ['Read', 'Edit'], deny: ['Bash(git push*)'] },
    capabilities: { overseer: false, roles: ['implementer'] },
  },
  persona: '# Priya\r\n\r\nWrite a failing test first.  \r\n',
  rationale: { permissions: 'Edit is auto-approved because…' },
  suggestedSkills: [{ name: 'triage-a-stack-trace', description: 'Read a PHP trace.' }],
  suggestedIntegrations: [],
  warnings: [],
  degraded: false,
};

describe('a draft becomes a form', () => {
  it('carries every field across, and the persona verbatim', () => {
    const model = fromDraft(DRAFT);
    expect(model.name).toBe('Priya');
    expect(model.specialty).toBe('bug-patching');
    expect(model.avatarEmoji).toBe('🐛');
    expect(model.allow).toBe('Read\nEdit');
    expect(model.roles).toEqual(['implementer']);
    expect(model.personaText).toBe(DRAFT.persona);
  });

  it('starts with no skill accepted — suggestions are inert (roster §12.4)', () => {
    expect(fromDraft(DRAFT).acceptedSkills).toEqual([]);
  });
});

describe('persona.md round-trips byte-for-byte', () => {
  const persona = '# Priya\r\n\r\nTrailing spaces matter:   \r\n\ttabbed\r\n\r\n\r\n';

  it('survives draft → form → body without a single byte changing', () => {
    const model = fromDraft({ ...DRAFT, persona });
    expect(toCreateBody(model)['personaText']).toBe(persona);
  });

  it('survives agent → form → body the same way', () => {
    const agent = { definition: DRAFT.draft, persona } as unknown as AgentView;
    expect(toCreateBody(fromAgent(agent))['personaText']).toBe(persona);
  });

  it('is not trimmed, not newline-normalised, and not given a trailing newline', () => {
    // Every "helpful" normalisation is a byte the user did not ask to change,
    // and roster §4 wants the file back exactly as it went in.
    const body = toCreateBody({ ...EMPTY_MODEL, name: 'x', personaText: '  \r\n' });
    expect(body['personaText']).toBe('  \r\n');
  });
});

describe('the body is a projection of the form and nothing else', () => {
  it('omits every field the user left empty rather than defaulting it', () => {
    // An absent key means roster's own schema default applies — one owner of a
    // default, rather than the form guessing at one.
    const body = toCreateBody({ ...EMPTY_MODEL, name: 'Sam' });
    expect(Object.keys(body).sort()).toEqual(['name', 'persona', 'personaText', 'specialty']);
  });

  it('does not restore a field the user cleared after the draft filled it', () => {
    const model = { ...fromDraft(DRAFT), tagline: '', modelPrimary: '' };
    const body = toCreateBody(model);
    expect(body).not.toHaveProperty('tagline');
    expect(body).not.toHaveProperty('model');
  });

  it('splits rule textareas into lists, dropping blank lines', () => {
    expect(rulesOf('Read\n\n  Edit  \n')).toEqual(['Read', 'Edit']);
    expect(linesOf(['Read', 'Edit'])).toBe('Read\nEdit');
  });

  it('writes skills only for the suggestions the user ticked', () => {
    const accepted = toCreateBody(
      { ...fromDraft(DRAFT), acceptedSkills: ['triage-a-stack-trace'] },
      { suggestedSkills: DRAFT.suggestedSkills },
    );
    expect(accepted['skills']).toEqual({
      mode: 'declared',
      names: ['triage-a-stack-trace'],
    });
    expect(accepted['acceptedSkills']).toEqual([
      { name: 'triage-a-stack-trace', description: 'Read a PHP trace.' },
    ]);
  });

  it('writes nothing at all for a declined suggestion', () => {
    const declined = toCreateBody(fromDraft(DRAFT), { suggestedSkills: DRAFT.suggestedSkills });
    expect(declined).not.toHaveProperty('skills');
    expect(declined).not.toHaveProperty('acceptedSkills');
  });

  it('stamps meta.origin only when the caller asks for it', () => {
    expect(toCreateBody(fromDraft(DRAFT), { origin: 'drafted' })['meta']).toEqual({
      origin: 'drafted',
    });
    expect(toCreateBody(fromDraft(DRAFT))).not.toHaveProperty('meta');
  });
});

describe('the redraft guard (§7.1)', () => {
  it('knows an untouched form from an edited one', () => {
    const baseline = fromDraft(DRAFT);
    expect(hasEdits(baseline, baseline)).toBe(false);
    expect(hasEdits({ ...baseline, tagline: 'mine' }, baseline)).toBe(true);
  });
});
