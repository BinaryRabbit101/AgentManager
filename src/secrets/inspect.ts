/**
 * Reading what the secrets directory holds **without opening a store**.
 *
 * `Test-AgentManagerHealth.ps1` has to report "secret provider in use" (DESIGN
 * §4.4) on a machine where the core may not be running, and `agentmanager
 * health` answers it. Constructing a {@link SecretStore} to find out would be
 * the wrong tool twice over: under `auto` it can *create* a master key as a side
 * effect of the keyfile fallback, so a diagnostic would change the thing it is
 * diagnosing, and under `dpapi` it would load a native binding for a question
 * that is answered by a directory listing.
 *
 * So this reads the envelope's public fields only. §3.1's format keeps key
 * names, `provider`, `setAt` and the four-character `preview` in plaintext
 * precisely so `list()` "never decrypts" — the same property is what makes an
 * offline inspection safe. Nothing here touches a ciphertext.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { SECRETS_FILENAME } from './envelope.js';
import { MASTER_KEY_FILENAME } from './keyfile.js';
import type { SecretKey, SecretProvider } from './types.js';

/** One envelope entry, metadata only. */
export interface SecretEntrySummary {
  readonly key: SecretKey;
  /** Which cipher wrote it — after an `auto` fallback a file can hold both. */
  readonly provider: Exclude<SecretProvider, 'env'>;
  readonly setAt: string;
  /** Last four characters of the value, as §3.2's `list()` returns. */
  readonly preview: string;
}

export interface SecretsDirectorySummary {
  readonly directory: string;
  readonly envelopeFile: string;
  readonly envelopeExists: boolean;
  /** Set when the envelope is present but unreadable; the entries are then empty. */
  readonly envelopeError?: string;
  readonly entries: readonly SecretEntrySummary[];
  /**
   * `state/secrets/master.key` exists, i.e. the store has run in `keyfile` mode
   * at some point (§3.1's fallback, or a deliberate `keyfile` provider).
   */
  readonly masterKeyPresent: boolean;
  /**
   * The provider that actually wrote the entries on disk, when they agree; `null`
   * for an empty envelope and `'mixed'` when a fallback left both kinds behind.
   */
  readonly providerOnDisk: Exclude<SecretProvider, 'env'> | 'mixed' | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Summarises `<dataRoot>\state\secrets\`. Never throws, never decrypts, never writes. */
export function inspectSecretsDirectory(secretsDir: string): SecretsDirectorySummary {
  const directory = resolve(secretsDir);
  const envelopeFile = resolve(directory, SECRETS_FILENAME);
  const masterKeyPresent = existsSync(resolve(directory, MASTER_KEY_FILENAME));
  const envelopeExists = existsSync(envelopeFile);

  const base = { directory, envelopeFile, envelopeExists, masterKeyPresent };
  if (!envelopeExists) return { ...base, entries: [], providerOnDisk: null };

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(envelopeFile, 'utf8'));
  } catch (error) {
    return {
      ...base,
      entries: [],
      providerOnDisk: null,
      envelopeError: error instanceof Error ? error.message : String(error),
    };
  }

  const rawEntries = isRecord(parsed) ? parsed['entries'] : undefined;
  if (!isRecord(rawEntries)) {
    return {
      ...base,
      entries: [],
      providerOnDisk: null,
      envelopeError: 'the envelope has no "entries" object',
    };
  }

  const entries: SecretEntrySummary[] = [];
  for (const [key, value] of Object.entries(rawEntries)) {
    if (!isRecord(value)) continue;
    const provider = value['provider'];
    if (provider !== 'dpapi' && provider !== 'keyfile') continue;
    entries.push({
      key,
      provider,
      setAt: typeof value['setAt'] === 'string' ? value['setAt'] : '',
      preview: typeof value['preview'] === 'string' ? value['preview'] : '',
    });
  }
  entries.sort((a, b) => a.key.localeCompare(b.key));

  const providers = new Set(entries.map((entry) => entry.provider));
  const providerOnDisk =
    providers.size === 0 ? null : providers.size > 1 ? 'mixed' : [...providers][0]!;

  return { ...base, entries, providerOnDisk };
}
