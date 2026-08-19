/**
 * The integrations form model (ui DESIGN §7.3, roster DESIGN §10).
 *
 * The criterion that matters most here is not a rendering one: **what the form
 * posts must be exactly what roster's schema accepts**. So this file validates
 * `integrationsBody`'s output against the real `integrationsSchema` rather than
 * against a second copy of the shape written by hand — the frontend restates
 * three of roster's predicates (`integrationNameProblem`, `isCredentialShapedKey`,
 * `isSecretKey`) so it can say the same sentence in the field instead of after a
 * 400, and a restatement that is never checked is a restatement that drifts.
 *
 * Importing `src/` from a web test is the established idiom for exactly this
 * kind of cross-check (`web/src/a11y/responsive.test.ts` imports the real CSP
 * header rather than asserting a copy of it). Only the schema is imported, and
 * only into a test: the bundle itself stays free of `src/` (foundation §6.1).
 */
import { describe, expect, it } from 'vitest';

import { integrationsSchema } from '../../../src/modules/roster/schema.js';

import {
  EMPTY_INTEGRATION,
  argsOf,
  connectorRefForm,
  fieldsOf,
  inlineFormOf,
  integrationProblems,
  integrationSummaries,
  integrationsBody,
  integrationsOf,
  isCredentialShapedKey,
  mcpToolPrefix,
  secretSetCommand,
  suggestedSecretRef,
  type IntegrationForm,
} from './integrationsModel';

/** The `email-responder` fixture's server, which is roster's own §10 example. */
const GMAIL = {
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-gmail'],
  env: { GMAIL_TOKEN: { secretRef: 'mcp.gmail.token' }, GMAIL_USER: 'me@example.com' },
  toolPrefixHint: 'mcp__gmail__',
} as const;

describe('wire → form → wire', () => {
  it('round-trips a stdio server with a ref and a literal', () => {
    const forms = integrationsOf({ gmail: GMAIL });
    expect(forms).toEqual([
      {
        name: 'gmail',
        transport: 'stdio',
        command: 'npx',
        args: '-y\n@modelcontextprotocol/server-gmail',
        url: '',
        // stdio has no auth mode at all (roster §10.1) — the flag is off and
        // `integrationsBody` omits the key, so the round-trip is byte-exact.
        oauth: false,
        fields: [
          { key: 'GMAIL_TOKEN', value: 'mcp.gmail.token', secret: true },
          { key: 'GMAIL_USER', value: 'me@example.com', secret: false },
        ],
      },
    ]);
    expect(integrationsBody(forms)).toEqual({ gmail: GMAIL });
  });

  it('round-trips http and sse, and keeps them apart', () => {
    const wire = {
      docs: {
        transport: 'http',
        url: 'https://mcp.example.com/mcp',
        headers: { Authorization: { secretRef: 'mcp.docs.token' } },
        toolPrefixHint: 'mcp__docs__',
      },
      feed: { transport: 'sse', url: 'https://mcp.example.com/sse', toolPrefixHint: 'mcp__feed__' },
    };
    expect(integrationsBody(integrationsOf(wire))).toEqual(wire);
  });

  it('emits the ref shape and never a value for a secret field', () => {
    const body = integrationsBody([
      {
        ...EMPTY_INTEGRATION,
        name: 'gmail',
        command: 'npx',
        fields: [{ key: 'GMAIL_TOKEN', value: 'mcp.gmail.token', secret: true }],
      },
    ]);
    // `{ secretRef }` and nothing else: the schema's `strictObject` would reject
    // a sibling key, and there is no code path that could produce a value here.
    expect(body['gmail']?.['env']).toEqual({ GMAIL_TOKEN: { secretRef: 'mcp.gmail.token' } });
  });

  it('omits every optional key rather than sending it empty', () => {
    // §10's third rule: the compiler spreads the session environment only when
    // the integration declares an `env` at all, so an empty map would replace
    // the child's PATH instead of leaving inheritance alone.
    const body = integrationsBody([{ ...EMPTY_INTEGRATION, name: 'plain', command: 'server.exe' }]);
    expect(body['plain']).toEqual({
      transport: 'stdio',
      command: 'server.exe',
      toolPrefixHint: 'mcp__plain__',
    });
  });

  it('drops a half-typed server and a half-typed field rather than posting them', () => {
    const body = integrationsBody([
      { ...EMPTY_INTEGRATION, name: '  ', command: 'x' },
      {
        ...EMPTY_INTEGRATION,
        name: 'ok',
        command: 'x',
        fields: [{ key: '', value: 'orphan', secret: false }],
      },
    ]);
    expect(Object.keys(body)).toEqual(['ok']);
    expect(body['ok']).not.toHaveProperty('env');
  });

  it('parses `env` and `headers` entries that are neither string nor ref without crashing', () => {
    expect(fieldsOf({ A: 42, B: null })).toEqual([
      { key: 'A', value: '', secret: false },
      { key: 'B', value: '', secret: false },
    ]);
    expect(integrationsOf(undefined)).toEqual([]);
    expect(integrationsOf('nonsense')).toEqual([]);
  });

  it('splits args one per line, blank lines dropped', () => {
    expect(argsOf('-y\n\n  run  \n')).toEqual(['-y', 'run']);
  });
});

describe('what the form posts is what roster accepts', () => {
  const cases: Record<string, IntegrationForm[]> = {
    'a stdio server with both kinds of value': [
      {
        name: 'gmail',
        transport: 'stdio',
        command: 'npx',
        args: '-y\n@modelcontextprotocol/server-gmail',
        url: '',
        oauth: false,
        fields: [
          { key: 'GMAIL_TOKEN', value: 'mcp.gmail.token', secret: true },
          { key: 'GMAIL_USER', value: 'me@example.com', secret: false },
        ],
      },
    ],
    'an http server with a header ref': [
      {
        ...EMPTY_INTEGRATION,
        name: 'docs',
        transport: 'http',
        url: 'https://mcp.example.com/mcp',
        fields: [{ key: 'Authorization', value: 'mcp.docs.token', secret: true }],
      },
    ],
    'an sse server with no headers at all': [
      { ...EMPTY_INTEGRATION, name: 'feed', transport: 'sse', url: 'https://mcp.example.com/sse' },
    ],
    'a name with a single underscore': [
      { ...EMPTY_INTEGRATION, name: 'lpm_docs', command: 'server.exe' },
    ],
    // roster §10.1 (WO6): the connector that needs no key on this machine.
    'an http server that authorises with OAuth': [
      {
        ...EMPTY_INTEGRATION,
        name: 'todo',
        transport: 'http',
        url: 'https://mcp.example.com/mcp',
        oauth: true,
      },
    ],
    'an OAuth server with a non-credential routing header': [
      {
        ...EMPTY_INTEGRATION,
        name: 'todo',
        transport: 'sse',
        url: 'https://mcp.example.com/sse',
        oauth: true,
        fields: [{ key: 'X-Tenant', value: 'acme', secret: false }],
      },
    ],
  };

  for (const [label, forms] of Object.entries(cases)) {
    it(`validates against integrationsSchema: ${label}`, () => {
      const parsed = integrationsSchema.safeParse(integrationsBody(forms));
      expect(parsed.error?.issues ?? []).toEqual([]);
      expect(parsed.success).toBe(true);
    });
  }

  it('is rejected by roster when a credential-shaped key carries a literal — the case the panel warns about first', () => {
    // Proves the two halves agree: the panel's own warning fires *and* roster
    // would refuse, which is what makes the warning honest rather than a
    // frontend opinion.
    const forms: IntegrationForm[] = [
      {
        ...EMPTY_INTEGRATION,
        name: 'gmail',
        command: 'npx',
        fields: [{ key: 'GMAIL_TOKEN', value: 'ghp_livevalue', secret: false }],
      },
    ];
    expect(integrationsSchema.safeParse(integrationsBody(forms)).success).toBe(false);
    expect(integrationProblems(forms).map((problem) => problem.key)).toContain('GMAIL_TOKEN');
  });

  it('is rejected by roster when OAuth and a credential are both ticked (§10.1)', () => {
    const forms: IntegrationForm[] = [
      {
        ...EMPTY_INTEGRATION,
        name: 'todo',
        transport: 'http',
        url: 'https://mcp.example.com/mcp',
        oauth: true,
        fields: [{ key: 'Authorization', value: 'mcp.todo.token', secret: true }],
      },
    ];
    expect(integrationsSchema.safeParse(integrationsBody(forms)).success).toBe(false);
    // Both halves again: the panel says it in the field, roster refuses the save.
    expect(
      integrationProblems(forms)
        .map((problem) => problem.message)
        .join(' '),
    ).toContain('authorise with OAuth');
  });

  it('round-trips the OAuth flag, and omits the key when it is off', () => {
    const wire = {
      todo: { transport: 'http', url: 'https://mcp.example.com/mcp', auth: 'oauth' },
    };
    const forms = integrationsOf(wire);
    expect(forms[0]?.oauth).toBe(true);
    expect(integrationsBody(forms)['todo']).toMatchObject({ auth: 'oauth' });
    expect(integrationsBody([{ ...forms[0]!, oauth: false }])['todo']).not.toHaveProperty('auth');
    // A stdio server never carries one, whatever the wire said.
    expect(
      integrationsOf({ local: { transport: 'stdio', command: 'node', auth: 'oauth' } })[0]?.oauth,
    ).toBe(false);
  });
});

describe('the predicates restated from roster', () => {
  it('matches roster’s credential-shaped rule, prefixes included', () => {
    for (const key of ['GMAIL_TOKEN', 'apiKey', 'MY_SECRET', 'PASSWORD', 'Authorization']) {
      expect(isCredentialShapedKey(key)).toBe(true);
    }
    // `AUTH*` is prefix-matched, so `OAUTH_CALLBACK_URL` is judged by the rest.
    for (const key of ['GMAIL_USER', 'OAUTH_CALLBACK_URL', 'PATH']) {
      expect(isCredentialShapedKey(key)).toBe(false);
    }
  });

  it('derives the tool prefix permission rules match on', () => {
    expect(mcpToolPrefix('gmail')).toBe('mcp__gmail__');
  });

  it('proposes a ref in foundation’s `mcp.<server>.<field>` namespace', () => {
    // Underscores are excluded from a secret key: `.` is encoded as `__` in the
    // environment-variable form, and that is only reversible without them.
    expect(suggestedSecretRef('gmail', 'GMAIL_TOKEN')).toBe('mcp.gmail.gmail-token');
    expect(suggestedSecretRef('my_docs', 'X-Api-Key')).toBe('mcp.my-docs.x-api-key');
  });

  it('shows the stdin form of the CLI, never a value on a command line', () => {
    expect(secretSetCommand('mcp.gmail.token')).toBe(
      'agentmanager secrets set mcp.gmail.token --stdin',
    );
  });
});

describe('problems said in the field', () => {
  const of = (form: Partial<IntegrationForm>): string[] =>
    integrationProblems([{ ...EMPTY_INTEGRATION, ...form }]).map((problem) => problem.message);

  it('names the `__` collision with the tool-name separator', () => {
    expect(of({ name: 'my__server', command: 'x' }).join(' ')).toContain('mcp__<server>__<tool>');
  });

  it('refuses a `${VAR}` literal, which the schema alone cannot catch', () => {
    const messages = of({
      name: 'gmail',
      command: 'npx',
      fields: [{ key: 'GMAIL_USER', value: '${GMAIL_USER}', secret: false }],
    });
    expect(messages.join(' ')).toContain('${VAR} placeholder');
  });

  it('refuses a secret ref that is not a secret key', () => {
    const messages = of({
      name: 'gmail',
      command: 'npx',
      fields: [{ key: 'GMAIL_TOKEN', value: 'mcp.gmail.token!', secret: true }],
    });
    expect(messages.join(' ')).toContain('not a secret key');
  });

  it('wants a command for stdio and an http(s) URL for a remote server', () => {
    expect(of({ name: 'a' }).join(' ')).toContain('command');
    expect(of({ name: 'a', transport: 'http', url: 'ftp://x' }).join(' ')).toContain('http(s) URL');
  });

  it('is silent on a well-formed pair', () => {
    expect(
      integrationProblems([
        {
          ...EMPTY_INTEGRATION,
          name: 'gmail',
          command: 'npx',
          fields: [{ key: 'GMAIL_TOKEN', value: 'mcp.gmail.token', secret: true }],
        },
        {
          ...EMPTY_INTEGRATION,
          name: 'docs',
          transport: 'sse',
          url: 'https://mcp.example.com/sse',
        },
      ]),
    ).toEqual([]);
  });

  it('catches two servers with the same name, which a record would silently merge', () => {
    expect(
      integrationProblems([
        { ...EMPTY_INTEGRATION, name: 'gmail', command: 'a' },
        { ...EMPTY_INTEGRATION, name: 'gmail', command: 'b' },
      ]).map((problem) => problem.message),
    ).toContain('Two servers are both called “gmail”.');
  });
});

describe('the read-only summary (§7.3)', () => {
  it('answers "what can this agent reach" with names, prefixes and ref names', () => {
    expect(integrationSummaries({ gmail: GMAIL })).toEqual([
      {
        name: 'gmail',
        transport: 'stdio',
        target: 'npx -y @modelcontextprotocol/server-gmail',
        toolPrefix: 'mcp__gmail__',
        secretRefs: ['mcp.gmail.token'],
      },
    ]);
  });

  it('names the library entry for a reference, which has no command of its own', () => {
    expect(integrationSummaries({ mail: { connector: 'shared-gmail' } })).toEqual([
      {
        name: 'mail',
        transport: 'stdio',
        target: 'library connector “shared-gmail”',
        // The *agent-local* name is what the prefix is built from, not the
        // library id: an agent may mount the same connector under its own name.
        toolPrefix: 'mcp__mail__',
        secretRefs: [],
        connector: 'shared-gmail',
      },
    ]);
  });
});

/**
 * roster §10.3's third attachment shape (WO3/WO4).
 *
 * Held to the same standard as every other shape in this file: what the form
 * posts is validated against roster's own `integrationsSchema`, because a
 * reference that *nearly* matched `connectorRefSchema` — one that carried a
 * `toolPrefixHint`, say — would be a strict-object rejection at save time for
 * something the panel put there.
 */
describe('references to the connector library (§10.3)', () => {
  const REF: IntegrationForm = { ...EMPTY_INTEGRATION, name: 'mail', connector: 'shared-gmail' };

  it('round-trips a reference without inventing a transport for it', () => {
    expect(integrationsOf({ mail: { connector: 'shared-gmail' } })).toEqual([REF]);
    expect(integrationsBody([REF])).toEqual({ mail: { connector: 'shared-gmail' } });
  });

  it('posts the one key and nothing beside it — no hint, no override', () => {
    const body = integrationsBody([REF]);
    expect(Object.keys(body['mail'] ?? {})).toEqual(['connector']);
    expect(integrationsSchema.safeParse(body).success).toBe(true);
  });

  it('accepts a reference beside an inline server in the same record', () => {
    const body = integrationsBody([
      REF,
      { ...EMPTY_INTEGRATION, name: 'files', command: 'npx', args: '-y\nserver-files' },
    ]);
    expect(integrationsSchema.safeParse(body).success).toBe(true);
  });

  it('judges nothing about a reference’s config, because it has none', () => {
    // An inline row with no command is a problem; the same row as a reference is
    // not — the library holds the command, and this row holds only the name.
    expect(integrationProblems([REF], { connectorIds: ['shared-gmail'] })).toEqual([]);
    expect(integrationProblems([{ ...EMPTY_INTEGRATION, name: 'mail' }])).not.toEqual([]);
  });

  it('flags a dangling connector id against the fetched list, and only then', () => {
    expect(
      integrationProblems([REF], { connectorIds: ['other'] }).map((one) => one.message),
    ).toEqual([expect.stringContaining('“shared-gmail”')]);

    // No list means the library could not be read. Accusing a good definition on
    // the strength of a failed fetch is the one thing this must not do.
    expect(integrationProblems([REF])).toEqual([]);
  });

  it('still checks the record key, which is a server name like any other', () => {
    expect(
      integrationProblems([{ ...REF, name: 'Mail__Box' }], {
        connectorIds: ['shared-gmail'],
      }).map((one) => one.message),
    ).toEqual([expect.stringContaining('must be lower-case')]);
  });

  it('converts a library config into an editable row under the agent’s own name', () => {
    expect(inlineFormOf('mail', GMAIL)).toEqual({
      name: 'mail',
      transport: 'stdio',
      command: 'npx',
      args: '-y\n@modelcontextprotocol/server-gmail',
      url: '',
      oauth: false,
      fields: [
        { key: 'GMAIL_TOKEN', value: 'mcp.gmail.token', secret: true },
        { key: 'GMAIL_USER', value: 'me@example.com', secret: false },
      ],
    });
  });

  it('attaches under the library id, which is what makes the prefix predictable', () => {
    expect(connectorRefForm('shared-gmail')).toEqual({
      ...EMPTY_INTEGRATION,
      name: 'shared-gmail',
      connector: 'shared-gmail',
    });
  });
});
