/**
 * Paste-import: a `.mcp.json` becomes integration drafts — ui DESIGN §7.3.
 *
 * The everyday case this exists for is an owner who already has a working
 * `.mcp.json` (or a snippet from a server's README) and wants that agent to
 * reach the same connector. Typing it back in field by field is exactly the
 * "hand-editing of config files for everyday flows" the north star forbids,
 * only worse — it is hand-editing with extra steps.
 *
 * Importing is a **mapping, not a copy**, because the two formats disagree on
 * two things roster §10 is explicit about:
 *
 * 1. **`${VAR}` does not survive.** "`${VAR}` expansion works in `.mcp.json` but
 *    **not** in the programmatic `mcpServers` option, so all interpolation
 *    happens in our code." A pasted `${GMAIL_TOKEN}` copied through verbatim
 *    would be sent to the server as the eight literal characters, and the
 *    failure would look like a 401 from the connector rather than a mistake in
 *    a form. So a placeholder is flagged and converted to a `secretRef`.
 * 2. **`streamable-http` is not a transport.** It is a `.mcp.json`-only alias;
 *    the programmatic option accepts `"http"` only (§10 rule 4), so it is
 *    rewritten with a note rather than passed through or rejected.
 *
 * And one thing foundation is explicit about: a pasted file very often contains
 * a **live credential**. Any credential-shaped key (roster's own definition,
 * `isCredentialShapedKey`) is *required* to become a `secretRef` — the schema
 * refuses a literal there — and every other value is offered as a ref with the
 * literal one click away, so accepting a literal is a thing the owner does
 * knowingly rather than by default.
 *
 * Nothing here writes. The preview is state in the editor; the definition only
 * changes when the owner saves the editor, like every other field.
 */

import {
  EMPTY_INTEGRATION,
  isCredentialShapedKey,
  suggestedSecretRef,
  type CredentialField,
  type IntegrationForm,
  type IntegrationTransport,
} from './integrationsModel';

/** Why the importer would not take a pasted value at face value. */
export type ImportFlagReason = 'credential-key' | 'placeholder';

export interface ImportFlag {
  readonly integration: string;
  readonly key: string;
  readonly reason: ImportFlagReason;
  readonly message: string;
  /**
   * `true` when the schema forbids a literal outright, so the "keep the literal"
   * escape is not offered — roster §10's credential rule, not a preference.
   */
  readonly required: boolean;
}

export interface ImportRow {
  /** The draft as it will be appended, already carrying the importer's choices. */
  readonly draft: IntegrationForm;
  readonly flags: readonly ImportFlag[];
  /** Anything the mapping changed that the owner should be told about. */
  readonly notes: readonly string[];
  /**
   * What was pasted, per key — so unticking "store a reference" can put a plain
   * literal back. Preview-only state: it is never part of a draft and never
   * reaches {@link IntegrationForm}, which is the thing that gets saved.
   */
  readonly pasted: Readonly<Record<string, string>>;
}

export type ImportResult =
  | { readonly kind: 'ok'; readonly rows: readonly ImportRow[] }
  | { readonly kind: 'error'; readonly message: string };

const PLACEHOLDER = /\$\{[^}]*\}/u;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * The `mcpServers` map, wherever it is.
 *
 * Both spellings are accepted deliberately: a `.mcp.json` file is
 * `{ "mcpServers": { … } }`, and the fragment a README shows is usually the
 * inner object on its own. Asking the owner which one they have would be a
 * question the parser can answer.
 */
function serversOf(parsed: unknown): Record<string, unknown> | undefined {
  const root = asRecord(parsed);
  if (root === undefined) return undefined;
  const nested = asRecord(root['mcpServers']);
  return nested ?? root;
}

interface MappedTransport {
  readonly transport: IntegrationTransport;
  readonly note?: string;
}

function transportOf(name: string, raw: Record<string, unknown>): MappedTransport {
  const declared = raw['type'] ?? raw['transport'];
  if (declared === 'stdio' || declared === 'sse' || declared === 'http') {
    return { transport: declared };
  }
  if (declared === 'streamable-http' || declared === 'streamableHttp') {
    return {
      transport: 'http',
      note: `“${name}”: ${String(declared)} is a .mcp.json alias — mapped to the transport the MCP option actually accepts, “http” (roster §10).`,
    };
  }
  // No `type` at all is the common shorthand; the shape says which it is.
  if (typeof raw['command'] === 'string') return { transport: 'stdio' };
  if (typeof raw['url'] === 'string') {
    return {
      transport: 'http',
      note: `“${name}”: no transport was given, so this was read as “http”. Switch it to “sse” if the server streams that way.`,
    };
  }
  return { transport: 'stdio' };
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
}

interface MappedFields {
  readonly fields: readonly CredentialField[];
  readonly flags: readonly ImportFlag[];
  readonly pasted: Readonly<Record<string, string>>;
}

/**
 * One `env` / `headers` map, with each value judged.
 *
 * The default for a flagged value is the *ref*, not the literal: the safe
 * choice is the one that happens when nobody clicks anything.
 */
function mapFields(integration: string, kind: 'env' | 'headers', value: unknown): MappedFields {
  const record = asRecord(value);
  if (record === undefined) return { fields: [], flags: [], pasted: {} };

  const fields: CredentialField[] = [];
  const flags: ImportFlag[] = [];
  const pastedByKey: Record<string, string> = {};

  for (const [key, entry] of Object.entries(record)) {
    const pasted = typeof entry === 'string' ? entry : '';
    pastedByKey[key] = pasted;
    const credentialShaped = isCredentialShapedKey(key);
    const placeholder = PLACEHOLDER.test(pasted);

    if (credentialShaped) {
      flags.push({
        integration,
        key,
        reason: 'credential-key',
        required: true,
        message:
          `“${key}” is credential-shaped, so roster stores a reference and never the value — ` +
          `whatever this ${kind === 'env' ? 'variable' : 'header'} was set to in the pasted file ` +
          'stays out of agent.json, out of git and out of every export.',
      });
    } else if (placeholder) {
      flags.push({
        integration,
        key,
        reason: 'placeholder',
        required: false,
        message:
          `“${key}” holds ${pasted}, which .mcp.json expands and the MCP option we compile to does ` +
          'not (roster §10). It has been converted to a secret reference; untick to type a real value instead.',
      });
    }

    const secret = credentialShaped || placeholder;
    fields.push({
      key,
      value: secret ? suggestedSecretRef(integration, key) : pasted,
      secret,
    });
  }

  return { fields, flags, pasted: pastedByKey };
}

/**
 * Parse a pasted `.mcp.json` into drafts.
 *
 * Failure is a message, not a throw: the textarea is a place people paste half
 * a file into, and "that is not JSON" is a normal thing for it to have to say.
 */
export function parseMcpJson(text: string): ImportResult {
  if (text.trim() === '') return { kind: 'error', message: 'Paste a .mcp.json first.' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      kind: 'error',
      message: `That is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const servers = serversOf(parsed);
  if (servers === undefined) {
    return {
      kind: 'error',
      message: 'Expected an object — either a .mcp.json or its mcpServers map.',
    };
  }

  const rows: ImportRow[] = [];
  for (const [rawName, entry] of Object.entries(servers)) {
    const raw = asRecord(entry);
    if (raw === undefined) continue;

    const notes: string[] = [];
    // roster's name rule is stricter than `.mcp.json`'s (§10: the name becomes
    // the `mcp__<server>__` prefix), so a name is normalised here rather than
    // handed to the owner as a validation error they did not cause.
    const name = rawName
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/gu, '-')
      .replace(/_{2,}/gu, '_')
      .replace(/^[^a-z0-9]+/u, '');
    if (name !== rawName) {
      notes.push(
        `“${rawName}” was renamed to “${name}” — the name becomes the mcp__<server>__ tool prefix, ` +
          'so it is limited to lower-case letters, digits, “-” and “_” (roster §10).',
      );
    }

    const mapped = transportOf(name, raw);
    if (mapped.note !== undefined) notes.push(mapped.note);

    const credentials = mapFields(
      name,
      mapped.transport === 'stdio' ? 'env' : 'headers',
      mapped.transport === 'stdio' ? raw['env'] : raw['headers'],
    );

    const draft: IntegrationForm = {
      ...EMPTY_INTEGRATION,
      name,
      transport: mapped.transport,
      command: typeof raw['command'] === 'string' ? raw['command'] : '',
      args: stringList(raw['args']).join('\n'),
      url: typeof raw['url'] === 'string' ? raw['url'] : '',
      fields: credentials.fields,
    };

    rows.push({ draft, flags: credentials.flags, notes, pasted: credentials.pasted });
  }

  if (rows.length === 0) {
    return { kind: 'error', message: 'No MCP servers were found in that JSON.' };
  }
  return { kind: 'ok', rows };
}

/**
 * Flip one previewed field between "store a reference" and "keep the literal".
 *
 * Unticking a placeholder clears the value rather than restoring the `${VAR}`
 * text: the point of the flag is that the placeholder does not work, and
 * handing it back would undo the only thing the importer did. The owner types
 * the real value, or ticks it again.
 */
export function withFieldSecret(row: ImportRow, key: string, secret: boolean): ImportRow {
  return {
    ...row,
    draft: {
      ...row.draft,
      fields: row.draft.fields.map((field) => {
        if (field.key !== key) return field;
        if (secret) {
          return { ...field, secret: true, value: suggestedSecretRef(row.draft.name, key) };
        }
        const pasted = row.pasted[key] ?? '';
        return { ...field, secret: false, value: PLACEHOLDER.test(pasted) ? '' : pasted };
      }),
    },
  };
}
