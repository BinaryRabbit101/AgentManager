/**
 * Paste-import: `.mcp.json` → integration drafts (ui DESIGN §7.3).
 *
 * Three rules are asserted here because all three are places where a faithful
 * copy would be the *wrong* answer (roster DESIGN §10):
 *
 * - a `${VAR}` placeholder does not expand in the programmatic `mcpServers`
 *   option, so copying it through would produce a connector that 401s;
 * - `streamable-http` is a `.mcp.json`-only alias the option does not accept;
 * - a credential-shaped key may not hold a literal at all, so the importer's
 *   default has to be the reference and the literal escape has to be closed.
 */
import { describe, expect, it } from 'vitest';

import { integrationsSchema } from '../../../src/modules/roster/schema.js';

import { integrationsBody } from './integrationsModel';
import { parseMcpJson, withFieldSecret, type ImportRow } from './mcpImport';

function rowsOf(json: unknown): readonly ImportRow[] {
  const result = parseMcpJson(JSON.stringify(json));
  if (result.kind !== 'ok') throw new Error(`expected a mapping, got: ${result.message}`);
  return result.rows;
}

function rowNamed(rows: readonly ImportRow[], name: string): ImportRow {
  const row = rows.find((one) => one.draft.name === name);
  if (row === undefined) throw new Error(`no row for ${name}`);
  return row;
}

describe('what the parser accepts', () => {
  it('takes a whole .mcp.json and its bare mcpServers object alike', () => {
    const server = { gmail: { command: 'npx', args: ['-y', 'server-gmail'] } };
    expect(rowsOf({ mcpServers: server })[0]?.draft.name).toBe('gmail');
    expect(rowsOf(server)[0]?.draft.name).toBe('gmail');
  });

  it('says what is wrong rather than throwing, because a textarea gets half a file pasted into it', () => {
    expect(parseMcpJson('')).toMatchObject({ kind: 'error' });
    expect(parseMcpJson('{ "mcpServers": ')).toMatchObject({ kind: 'error' });
    expect(parseMcpJson('[]')).toMatchObject({ kind: 'error' });
    expect(parseMcpJson('{"mcpServers":{}}')).toMatchObject({
      kind: 'error',
      message: 'No MCP servers were found in that JSON.',
    });
  });
});

describe('transport mapping', () => {
  it('maps the .mcp.json-only `streamable-http` alias onto `http`, with a note', () => {
    const row = rowsOf({
      mcpServers: { docs: { type: 'streamable-http', url: 'https://mcp.example.com/mcp' } },
    })[0];
    expect(row?.draft.transport).toBe('http');
    expect(row?.notes.join(' ')).toContain('http');
    expect(row?.notes.join(' ')).toContain('§10');
  });

  it('keeps stdio, sse and http as they are', () => {
    const rows = rowsOf({
      mcpServers: {
        a: { type: 'stdio', command: 'x' },
        b: { type: 'sse', url: 'https://x/sse' },
        c: { type: 'http', url: 'https://x/mcp' },
      },
    });
    expect(rows.map((row) => row.draft.transport)).toEqual(['stdio', 'sse', 'http']);
    expect(rows.flatMap((row) => row.notes)).toEqual([]);
  });

  it('infers the transport from the shape when none is declared', () => {
    const rows = rowsOf({ mcpServers: { a: { command: 'x' }, b: { url: 'https://x/mcp' } } });
    expect(rows.map((row) => row.draft.transport)).toEqual(['stdio', 'http']);
    // The inferred remote one is a guess, and says so rather than looking certain.
    expect(rowNamed(rows, 'b').notes.join(' ')).toContain('sse');
  });

  it('normalises a name that could not become an mcp__<server>__ prefix, and says it did', () => {
    const row = rowsOf({ mcpServers: { 'My Gmail': { command: 'x' } } })[0];
    expect(row?.draft.name).toBe('my-gmail');
    expect(row?.notes.join(' ')).toContain('mcp__<server>__');
  });
});

describe('credential mapping', () => {
  const PASTED = {
    mcpServers: {
      gmail: {
        command: 'npx',
        args: ['-y', 'server-gmail'],
        env: {
          GMAIL_TOKEN: 'ghp_a_real_live_token',
          GMAIL_USER: '${GMAIL_USER}',
          GMAIL_FOLDER: 'INBOX',
        },
      },
    },
  };

  it('turns a credential-shaped key into a ref and drops the pasted value on the floor', () => {
    const row = rowNamed(rowsOf(PASTED), 'gmail');
    const token = row.draft.fields.find((field) => field.key === 'GMAIL_TOKEN');
    expect(token).toEqual({ key: 'GMAIL_TOKEN', value: 'mcp.gmail.gmail-token', secret: true });
    // The live token appears nowhere in the draft — the thing that gets saved.
    expect(JSON.stringify(row.draft)).not.toContain('ghp_a_real_live_token');
  });

  it('converts a ${VAR} placeholder, which .mcp.json expands and the MCP option does not', () => {
    const row = rowNamed(rowsOf(PASTED), 'gmail');
    expect(row.draft.fields.find((field) => field.key === 'GMAIL_USER')).toEqual({
      key: 'GMAIL_USER',
      value: 'mcp.gmail.gmail-user',
      secret: true,
    });
    expect(row.flags.find((flag) => flag.key === 'GMAIL_USER')?.reason).toBe('placeholder');
  });

  it('leaves an ordinary literal alone and does not flag it', () => {
    const row = rowNamed(rowsOf(PASTED), 'gmail');
    expect(row.draft.fields.find((field) => field.key === 'GMAIL_FOLDER')).toEqual({
      key: 'GMAIL_FOLDER',
      value: 'INBOX',
      secret: false,
    });
    expect(row.flags.map((flag) => flag.key)).toEqual(['GMAIL_TOKEN', 'GMAIL_USER']);
  });

  it('closes the literal escape for a credential-shaped key and leaves it open for a placeholder', () => {
    const row = rowNamed(rowsOf(PASTED), 'gmail');
    expect(row.flags.find((flag) => flag.key === 'GMAIL_TOKEN')?.required).toBe(true);
    expect(row.flags.find((flag) => flag.key === 'GMAIL_USER')?.required).toBe(false);
  });

  it('gives back an empty box rather than the ${VAR} when a placeholder is accepted as a literal', () => {
    // Handing the placeholder back would undo the only thing the importer did.
    const row = withFieldSecret(rowNamed(rowsOf(PASTED), 'gmail'), 'GMAIL_USER', false);
    expect(row.draft.fields.find((field) => field.key === 'GMAIL_USER')).toEqual({
      key: 'GMAIL_USER',
      value: '',
      secret: false,
    });
  });

  it('gives back the pasted literal when a plain value is switched back from a ref', () => {
    const row = rowNamed(rowsOf(PASTED), 'gmail');
    const asRef = withFieldSecret(row, 'GMAIL_FOLDER', true);
    expect(asRef.draft.fields.find((field) => field.key === 'GMAIL_FOLDER')?.value).toBe(
      'mcp.gmail.gmail-folder',
    );
    const back = withFieldSecret(asRef, 'GMAIL_FOLDER', false);
    expect(back.draft.fields.find((field) => field.key === 'GMAIL_FOLDER')?.value).toBe('INBOX');
  });

  it('maps a remote server’s headers the same way it maps stdio env', () => {
    const row = rowsOf({
      mcpServers: {
        docs: {
          type: 'http',
          url: 'https://mcp.example.com/mcp',
          headers: { Authorization: 'Bearer sk-live', 'X-Tenant': 'lpm' },
        },
      },
    })[0];
    expect(row?.draft.fields).toEqual([
      { key: 'Authorization', value: 'mcp.docs.authorization', secret: true },
      { key: 'X-Tenant', value: 'lpm', secret: false },
    ]);
  });
});

describe('the imported drafts are savable', () => {
  it('validates against roster’s own integrationsSchema straight out of the importer', () => {
    const rows = rowsOf({
      mcpServers: {
        gmail: { command: 'npx', args: ['-y', 'server-gmail'], env: { GMAIL_TOKEN: 'live' } },
        docs: { type: 'streamable-http', url: 'https://mcp.example.com/mcp' },
        feed: { type: 'sse', url: 'https://mcp.example.com/sse' },
      },
    });
    const parsed = integrationsSchema.safeParse(integrationsBody(rows.map((row) => row.draft)));
    expect(parsed.error?.issues ?? []).toEqual([]);
    expect(parsed.success).toBe(true);
  });
});
