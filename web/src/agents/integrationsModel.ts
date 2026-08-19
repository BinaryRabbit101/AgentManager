/**
 * The editor's integrations model — roster DESIGN §10, ui DESIGN §7.3.
 *
 * roster §10's decision is that "the roster schema carries per-agent MCP server
 * configs … the integration belongs to the identity, not to the project". Until
 * now that was true of the *schema* and invisible in the UI: an owner could only
 * reach it by hand-editing `agent.json`, which is exactly the everyday
 * config-file editing CLAUDE.md's UX north star forbids. This file is the form
 * half of that: wire → form → wire, with nothing in between that a save could
 * lose.
 *
 * Two rules are load-bearing and are enforced here rather than trusted:
 *
 * 1. **The form holds references, never values.** A credential field is a
 *    `{ key, value, secret }` triple where `secret: true` means `value` is a
 *    *secret key* (`mcp.gmail.token`) and gets written as `{ secretRef: value }`.
 *    There is no code path in the frontend that can hold a resolved secret,
 *    because the API never sends one — §10: "the API returns
 *    `{ secretRef, resolved: true|false }`".
 * 2. **`http` only.** `streamable-http` is a `.mcp.json`-only alias the
 *    programmatic `mcpServers` option does not accept (§10, and the schema makes
 *    it unrepresentable), so {@link INTEGRATION_TRANSPORTS} has three members and
 *    the paste-importer rewrites the alias rather than passing it through.
 * 3. **A reference is not a config.** roster §10.3's third attachment shape,
 *    `{ "connector": "<id>" }`, is a strict one-key object: the library owns the
 *    definition and the agent owns only the local name it mounts it under. So a
 *    row that carries {@link IntegrationForm.connector} serialises to that and
 *    nothing else — no hint, no override — and the only way it becomes editable
 *    here is by being *converted*, which drops the reference outright.
 *
 * The predicates below (`integrationNameProblem`, `isCredentialShapedKey`,
 * `isSecretKey`) are deliberate re-statements of `src/modules/roster/schema.ts`,
 * `src/modules/roster/credentialKeys.ts` and `src/secrets/keys.ts` rather than
 * imports: foundation §6.1 keeps the browser bundle out of `src/`, and the
 * frontend never gets to be the authority anyway — roster's schema still
 * rejects a bad save. What these buy is the *same sentence said earlier*, in the
 * field, instead of a 400 after a click. `integrationsModel.test.ts` validates
 * this file's output against the real `integrationsSchema` so the restatement
 * cannot drift silently.
 */

/** The three the programmatic `mcpServers` option accepts (§10). */
export const INTEGRATION_TRANSPORTS = ['stdio', 'sse', 'http'] as const;
export type IntegrationTransport = (typeof INTEGRATION_TRANSPORTS)[number];

/**
 * One `env` variable or HTTP header, as the form holds it.
 *
 * `secret: true` → written as `{ secretRef: value }`; `false` → the literal
 * string. The *same* string field carries both, so toggling never has to guess
 * where the other half went, and an existing ref renders as its own name —
 * which is the only thing about it the UI is ever allowed to know.
 */
export interface CredentialField {
  readonly key: string;
  readonly value: string;
  readonly secret: boolean;
}

/** One MCP server, as the form holds it. */
export interface IntegrationForm {
  readonly name: string;
  readonly transport: IntegrationTransport;
  /** stdio only. */
  readonly command: string;
  /** stdio only — one argument per line, like the permission rule lists (§7.1). */
  readonly args: string;
  /** sse/http only. */
  readonly url: string;
  /**
   * sse/http only — roster §10.1's `auth: "oauth"` (WO6).
   *
   * A *declaration*, not a credential: it says the server authorises the human
   * through the MCP OAuth flow, so this machine holds nothing for it. Roster
   * refuses it beside a credential-shaped header or a `secretRef`, which is
   * restated in {@link integrationProblems} so the clash is caught in the field.
   */
  readonly oauth: boolean;
  /** `env` for stdio, `headers` for sse/http — §10's two credential-bearing maps. */
  readonly fields: readonly CredentialField[];
  /**
   * The library connector this row **references** (roster §10.3, WO3/WO4).
   *
   * Present makes the row a *reference*: it serialises to `{ connector: "<id>" }`
   * and nothing else, and every field above it is inert. An optional field rather
   * than a discriminated union on purpose — the two variants share the one thing
   * the form actually owns, the record **key** (`name`), which is the agent-local
   * server name in both cases and therefore the tool prefix in both cases. A
   * union would have made "rename the row" two different operations.
   *
   * Detaching drops the row; **Convert to inline copy** clears this and fills the
   * fields from the library's config, which is the one way a row moves between
   * the two variants.
   */
  readonly connector?: string | undefined;
}

/** Whether this row is a library reference rather than a config of its own. */
export function isConnectorRef(form: IntegrationForm): boolean {
  return form.connector !== undefined && form.connector !== '';
}

export const EMPTY_INTEGRATION: IntegrationForm = Object.freeze({
  name: '',
  transport: 'stdio',
  command: '',
  args: '',
  url: '',
  oauth: false,
  fields: [],
});

// ---------------------------------------------------------------------------
// Naming (§10)
// ---------------------------------------------------------------------------

/** `gmail` → `mcp__gmail__`, the prefix every permission rule for it starts with. */
export function mcpToolPrefix(server: string): string {
  return `mcp__${server}__`;
}

/**
 * roster's `integrationNameProblem`, restated (schema.ts).
 *
 * The `__` clause is the one that matters: a name containing it would make
 * `mcp__gmail__x__y` ambiguous about where the server name ends, and the
 * ambiguity would land in a permission rule.
 */
export function integrationNameProblem(name: string): string | undefined {
  if (name.length < 1 || name.length > 64) return 'A server name is required (1–64 characters).';
  if (!/^[a-z0-9][a-z0-9_-]*$/u.test(name)) {
    return `“${name}” must be lower-case letters, digits, “-” or “_”.`;
  }
  if (name.includes('__')) {
    return `“${name}” must not contain “__” — that is the MCP tool-name separator (mcp__<server>__<tool>).`;
  }
  return undefined;
}

/**
 * roster's `isCredentialShapedKey`, restated (credentialKeys.ts).
 *
 * Substring-matched and therefore over-broad on purpose: "a false positive costs
 * an author one `secretRef` for a value that did not need protecting; a false
 * negative writes a live credential into `agent.json`, into git, and into every
 * export of that agent."
 */
export function isCredentialShapedKey(name: string): boolean {
  const lowered = name.toLowerCase();
  return (
    ['token', 'key', 'secret', 'password'].some((needle) => lowered.includes(needle)) ||
    lowered.startsWith('auth')
  );
}

/** foundation's secret-key shape (§3.3, `src/secrets/keys.ts`), restated. */
export function isSecretKey(key: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9-]*(?:\.[A-Za-z0-9][A-Za-z0-9-]*)*$/u.test(key);
}

/** One segment of a secret key: no underscores, since `.` is encoded as `__`. */
function secretSegment(raw: string): string {
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
  return slug === '' ? 'value' : slug;
}

/**
 * The ref the importer proposes for a pasted credential: `mcp.<server>.<field>`,
 * which is one of the four key shapes foundation §3.3 fixes.
 */
export function suggestedSecretRef(server: string, key: string): string {
  return `mcp.${secretSegment(server)}.${secretSegment(key)}`;
}

/**
 * How an owner actually gets a value into the store.
 *
 * There is no HTTP write route for secrets and this feature does not add one:
 * foundation §3.5 requires a secret to reach the process over stdin — "never a
 * command line (visible in Task Manager), never a temp file" — which is what
 * `agentmanager secrets set <key> --stdin` exists for (`src/cli/secrets.ts`,
 * the verb `Setup-Auth.ps1` feeds). The UI shows the command; it never carries
 * the value.
 */
export function secretSetCommand(ref: string): string {
  return `agentmanager secrets set ${ref} --stdin`;
}

// ---------------------------------------------------------------------------
// Wire → form
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function transportOf(raw: Record<string, unknown>): IntegrationTransport {
  const declared = raw['transport'];
  if (declared === 'sse' || declared === 'http' || declared === 'stdio') return declared;
  // A definition that predates the discriminator (or one hand-written badly) is
  // still shown rather than dropped: an integration the owner cannot see is the
  // bug this panel exists to fix.
  return typeof raw['url'] === 'string' ? 'http' : 'stdio';
}

/** `env` / `headers` → rows, in the order the record carries them. */
export function fieldsOf(value: unknown): CredentialField[] {
  const record = asRecord(value);
  if (record === undefined) return [];
  return Object.entries(record).map(([key, entry]) => {
    const ref = asRecord(entry)?.['secretRef'];
    if (typeof ref === 'string') return { key, value: ref, secret: true };
    return { key, value: typeof entry === 'string' ? entry : '', secret: false };
  });
}

/** `definition.integrations` → the form's list, in name order as stored. */
export function integrationsOf(value: unknown): IntegrationForm[] {
  const record = asRecord(value);
  if (record === undefined) return [];
  const out: IntegrationForm[] = [];
  for (const [name, entry] of Object.entries(record)) {
    const raw = asRecord(entry);
    if (raw === undefined) continue;
    // roster §10.3's third shape, dispatched on the presence of `connector`
    // exactly as roster's own `integrationAttachmentSchema` dispatches: a ref
    // carries no transport, so reading it as one would invent a `stdio` server
    // with an empty command and report it as a broken definition.
    const connector = raw['connector'];
    if (typeof connector === 'string') {
      out.push({ ...EMPTY_INTEGRATION, name, connector });
      continue;
    }
    const transport = transportOf(raw);
    const args = raw['args'];
    out.push({
      name,
      transport,
      command: typeof raw['command'] === 'string' ? raw['command'] : '',
      args: Array.isArray(args) ? args.filter((arg) => typeof arg === 'string').join('\n') : '',
      url: typeof raw['url'] === 'string' ? raw['url'] : '',
      // Only `"oauth"` is representable, so anything else round-trips as off
      // rather than as a value the form would write back unrecognised.
      oauth: transport !== 'stdio' && raw['auth'] === 'oauth',
      fields: fieldsOf(transport === 'stdio' ? raw['env'] : raw['headers']),
    });
  }
  return out;
}

/** The row **Attach from library** appends: a reference under the library id. */
export function connectorRefForm(connectorId: string): IntegrationForm {
  return { ...EMPTY_INTEGRATION, name: connectorId, connector: connectorId };
}

/**
 * A library connector's config, read into an editable row under `name`.
 *
 * What **Convert to inline copy** produces. It goes through `integrationsOf`
 * rather than through a second reader, because the library's `config` *is*
 * roster's `IntegrationConfig` — the same object an inline integration holds
 * (roster §10.3 decision 2) — so a second parser here would be a second dialect
 * of the shape the library exists to keep single.
 */
export function inlineFormOf(name: string, config: unknown): IntegrationForm {
  const [form] = integrationsOf({ [name]: config });
  return form ?? { ...EMPTY_INTEGRATION, name };
}

// ---------------------------------------------------------------------------
// Form → wire
// ---------------------------------------------------------------------------

/** One argument per line, blank lines dropped — `rulesOf`'s rule, for `args`. */
export function argsOf(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

type WireSecretValue = string | { readonly secretRef: string };

function fieldsBody(fields: readonly CredentialField[]): Record<string, WireSecretValue> {
  const out: Record<string, WireSecretValue> = {};
  for (const field of fields) {
    const key = field.key.trim();
    // A half-typed row is not a key: an empty name would be a schema error for
    // something the user has not finished saying.
    if (key === '') continue;
    out[key] = field.secret ? { secretRef: field.value.trim() } : field.value;
  }
  return out;
}

/**
 * The `integrations` object exactly as roster's `integrationsSchema` wants it.
 *
 * Every optional key is *omitted* rather than sent empty, for `toCreateBody`'s
 * reason: an absent key means roster's own schema default applies, and the
 * compiler treats "no `env` at all" differently from "an empty `env`" — §10's
 * third rule spreads the session environment only when the integration declares
 * one, so an empty map would silently replace the child's `PATH`.
 */
export function integrationsBody(
  forms: readonly IntegrationForm[],
): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const form of forms) {
    const name = form.name.trim();
    if (name === '') continue;
    // A reference is a strict one-key object (roster's `connectorRefSchema`).
    // Not even the `toolPrefixHint` rides along: an override beside a reference
    // would be a second place the connector is defined, which is the exact thing
    // the library exists to remove (roster §10.3).
    if (isConnectorRef(form)) {
      out[name] = { connector: (form.connector ?? '').trim() };
      continue;
    }
    const fields = fieldsBody(form.fields);
    const hasFields = Object.keys(fields).length > 0;
    // Derived on write and display-only (§3, §10) — and only when the name is
    // one the hint's own pattern accepts, so an invalid name is reported as an
    // invalid *name* rather than as a malformed hint.
    const hint =
      integrationNameProblem(name) === undefined ? { toolPrefixHint: mcpToolPrefix(name) } : {};

    if (form.transport === 'stdio') {
      const args = argsOf(form.args);
      out[name] = {
        transport: 'stdio',
        command: form.command,
        ...(args.length === 0 ? {} : { args }),
        ...(hasFields ? { env: fields } : {}),
        ...hint,
      };
      continue;
    }
    out[name] = {
      transport: form.transport,
      url: form.url,
      // Omitted rather than sent `false`: the schema has one auth mode and an
      // absent key is what "no declared auth mode" spells (roster §10.1).
      ...(form.oauth ? { auth: 'oauth' } : {}),
      ...(hasFields ? { headers: fields } : {}),
      ...hint,
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Problems the owner should see before roster says no
// ---------------------------------------------------------------------------

export interface IntegrationProblem {
  readonly integration: string;
  readonly key?: string;
  readonly message: string;
}

/**
 * Everything roster's schema would reject, said in the field instead.
 *
 * Not a gate: Save still posts and roster still refuses. This is the earlier,
 * kinder half of the same sentence, and the `${VAR}` clause is one the server
 * cannot say at all — a literal `${GMAIL_TOKEN}` is a *valid* string as far as
 * the schema is concerned, and §10's second constraint ("`${VAR}` expansion
 * works in `.mcp.json` but **not** in the programmatic `mcpServers` option") is
 * what makes it wrong anyway.
 */
export interface IntegrationProblemOptions {
  /**
   * The ids the connector library actually holds (roster §10.3).
   *
   * **Fetched, never guessed** — omit it and no reference is judged, because a
   * dangling-connector warning derived from a list that failed to load would
   * accuse a perfectly good definition. When it is present, a reference to an id
   * that is not in it is roster's `missing-connector` said in the panel instead
   * of at launch.
   */
  readonly connectorIds?: readonly string[] | undefined;
}

export function integrationProblems(
  forms: readonly IntegrationForm[],
  options: IntegrationProblemOptions = {},
): IntegrationProblem[] {
  const problems: IntegrationProblem[] = [];
  const seen = new Set<string>();
  const known = options.connectorIds === undefined ? undefined : new Set(options.connectorIds);

  for (const form of forms) {
    const name = form.name.trim();
    const problem = integrationNameProblem(name);
    if (problem !== undefined) problems.push({ integration: name, message: problem });
    else if (seen.has(name)) {
      problems.push({ integration: name, message: `Two servers are both called “${name}”.` });
    }
    seen.add(name);

    // A reference has no config to judge: the library owns the transport, the
    // command and the credentials, and the one thing that can be wrong here is
    // that the library no longer holds it.
    if (isConnectorRef(form)) {
      const id = (form.connector ?? '').trim();
      if (known !== undefined && !known.has(id)) {
        problems.push({
          integration: name,
          message:
            `“${name}” references the library connector “${id}”, which the library does not ` +
            'hold. Recreate it on the Connectors page, or convert this row to an inline copy — ' +
            'a dangling reference refuses the launch (roster §10.3).',
        });
      }
      continue;
    }

    if (form.transport === 'stdio' && form.command.trim() === '') {
      problems.push({ integration: name, message: 'A stdio server needs a command to run.' });
    }
    if (form.transport !== 'stdio' && !/^https?:\/\//u.test(form.url.trim())) {
      problems.push({ integration: name, message: 'A remote server needs an http(s) URL.' });
    }

    for (const field of form.fields) {
      const key = field.key.trim();
      if (key === '') continue;
      // roster §10.1's mutual exclusion, said in the field. An OAuth server that
      // also carries a bearer token is two auth mechanisms whose failure modes
      // cannot be told apart, and the point of the mode is that this machine
      // holds nothing for the server at all.
      if (form.oauth && (field.secret || isCredentialShapedKey(key))) {
        problems.push({
          integration: name,
          key,
          message:
            `“${key}” is a credential, and this server is set to authorise with OAuth. Untick ` +
            'one of the two: an OAuth connector carries no secret reference and no key.',
        });
      }
      if (field.secret) {
        if (!isSecretKey(field.value.trim())) {
          problems.push({
            integration: name,
            key,
            message:
              `“${field.value}” is not a secret key — use dot-separated groups of letters, ` +
              'digits and hyphens, like mcp.gmail.token.',
          });
        }
        continue;
      }
      if (isCredentialShapedKey(key)) {
        problems.push({
          integration: name,
          key,
          message:
            `“${key}” is credential-shaped, so its value must be a secret reference and not a ` +
            'literal — secrets never enter agent.json (roster §10).',
        });
      }
      if (field.value.includes('${')) {
        problems.push({
          integration: name,
          key,
          message:
            `“${key}” still holds a \${VAR} placeholder. That expands in .mcp.json but not in the ` +
            'MCP option we compile to (roster §10), so it must become a secret reference or a real value.',
        });
      }
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Read-only summary (§7.3 — "what can this agent reach")
// ---------------------------------------------------------------------------

export interface IntegrationSummary {
  readonly name: string;
  readonly transport: IntegrationTransport;
  /** The command or the URL — what the server actually is. */
  readonly target: string;
  readonly toolPrefix: string;
  /** The refs it needs, by name only. Never a value; there is none to have. */
  readonly secretRefs: readonly string[];
  /** Set when the row is a library reference (roster §10.3). */
  readonly connector?: string | undefined;
}

export function integrationSummaries(value: unknown): IntegrationSummary[] {
  return integrationsOf(value).map((form) => {
    // A reference's *target* is the library entry, said in words rather than as
    // a bare id: the saved definition genuinely does not know the command, and a
    // blank line here would read as "this server runs nothing".
    if (isConnectorRef(form)) {
      const id = form.connector ?? '';
      return {
        name: form.name,
        transport: form.transport,
        target: `library connector “${id}”`,
        toolPrefix: mcpToolPrefix(form.name),
        secretRefs: [],
        connector: id,
      };
    }
    return {
      name: form.name,
      transport: form.transport,
      target:
        form.transport === 'stdio'
          ? [form.command, ...argsOf(form.args)].join(' ').trim()
          : form.url,
      toolPrefix: mcpToolPrefix(form.name),
      secretRefs: form.fields.filter((field) => field.secret).map((field) => field.value),
    };
  });
}
