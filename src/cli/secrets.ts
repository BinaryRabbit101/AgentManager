/**
 * `agentmanager secrets set <key> --stdin` and `agentmanager secrets list`.
 *
 * The verb `Setup-Auth.ps1` exists to feed (DESIGN §4.4): the script reads the
 * token from the console into a `SecureString` and "pipe[s] it over stdin to
 * `agentmanager secrets set claude.oauthToken --stdin`". Everything unusual
 * about this file follows from §3.5's rule that a secret is "passed to [child]
 * processes through the environment block only — never a command line (visible
 * in Task Manager), never a temp file":
 *
 * - **`--stdin` is mandatory, not a convenience.** A positional value is
 *   rejected with an explanation rather than accepted, because accepting it
 *   would put the token in this process's command line — where Task Manager,
 *   `wmic process get commandline`, ETW process-start events and the parent
 *   shell's history can all read it — and no amount of care afterwards takes it
 *   back out.
 * - **Nothing derived from the value is printed.** Not even the four-character
 *   preview §3.2 allows `list()` to show: `set` is the moment the plaintext is
 *   in hand, and a console that is being screen-shared or logged is exactly the
 *   channel the SecureString dance upstream was protecting.
 * - **No logger is attached.** The store's own `LogFn` defaults to discarding,
 *   and this command leaves it there, so a `set` writes nothing to `core.log`
 *   for §5.4's redactor to have to catch.
 */
import { createSecretStore, inspectSecretsDirectory, isSecretKey } from '../secrets/index.js';

import { resolveInstall } from './resolve.js';
import { COMMAND_FAILURE_EXIT_CODE, USAGE_EXIT_CODE, hasFlag, type CommandInput } from './types.js';

export const SECRETS_USAGE = [
  'Usage:',
  '  agentmanager secrets set <key> --stdin      Store a secret read from standard input',
  '  agentmanager secrets list [--json]          List stored secret keys (metadata only)',
  '',
  'A secret value is never a command-line argument: it is read from standard input,',
  'so it never appears in the process command line, the shell history or a log file.',
].join('\n');

/**
 * Normalises what arrived on stdin.
 *
 * A UTF-8 BOM (PowerShell 5.1's `Out-File` default) and the trailing newline a
 * pipe almost always adds are stripped, then the whole thing is trimmed: no key
 * in §3.3's namespace holds a value with meaningful surrounding whitespace, and
 * a token with an invisible `\r` glued to it fails authentication in a way that
 * is very hard to see.
 */
export function normaliseSecretInput(raw: string): string {
  return raw.replace(/^\uFEFF/, '').trim();
}

async function runSet(input: CommandInput): Promise<number> {
  const { ctx } = input;
  const key = input.words[2];

  if (key === undefined) {
    ctx.io.err('agentmanager secrets set: a key is required (e.g. claude.oauthToken).');
    ctx.io.err(SECRETS_USAGE);
    return USAGE_EXIT_CODE;
  }
  if (!isSecretKey(key)) {
    ctx.io.err(
      `agentmanager secrets set: ${JSON.stringify(key)} is not a valid secret key. ` +
        'Keys are dot-separated segments of letters, digits and hyphens (DESIGN §3.3).',
    );
    return USAGE_EXIT_CODE;
  }
  if (input.words.length > 3) {
    // The important refusal. See the file header.
    ctx.io.err(
      'agentmanager secrets set: a secret value is never passed as an argument — it would be ' +
        'visible in the process command line. Pipe it to standard input and pass --stdin.',
    );
    return USAGE_EXIT_CODE;
  }
  if (!hasFlag(input, '--stdin')) {
    ctx.io.err('agentmanager secrets set: --stdin is required; the value is read from stdin.');
    ctx.io.err(SECRETS_USAGE);
    return USAGE_EXIT_CODE;
  }

  const value = normaliseSecretInput(await ctx.stdin());
  if (value.length === 0) {
    ctx.io.err(
      `agentmanager secrets set: nothing was read from standard input, so ${key} was not changed.`,
    );
    return USAGE_EXIT_CODE;
  }

  const { loaded, paths } = resolveInstall(input);
  const store = await createSecretStore({
    secretsDir: paths.secrets,
    provider: loaded.config.secrets.provider,
    env: ctx.env,
    now: ctx.clock,
    ...(ctx.secretsAcl === undefined ? {} : { acl: ctx.secretsAcl }),
  });

  await store.set(key, value);

  // Deliberately says nothing about the value — not its length, not its shape,
  // not its preview.
  ctx.io.out(`stored secret "${key}" (provider: ${store.provider}).`);
  if (store.degraded !== undefined) {
    ctx.io.err(
      `warning: secrets are protected by the ${store.degraded.provider} provider rather than the ` +
        `requested "${store.degraded.requested}" — ${store.degraded.reason}`,
    );
  }
  return 0;
}

function runList(input: CommandInput): number {
  const { ctx } = input;
  const { paths } = resolveInstall(input);
  // The offline reader, not `store.list()`: listing must not construct a store,
  // because under `auto` that can create a master key as a side effect.
  const summary = inspectSecretsDirectory(paths.secrets);

  if (hasFlag(input, '--json')) {
    ctx.io.out(JSON.stringify(summary, null, 2));
    return summary.envelopeError === undefined ? 0 : COMMAND_FAILURE_EXIT_CODE;
  }

  if (summary.envelopeError !== undefined) {
    ctx.io.err(
      `agentmanager secrets list: ${summary.envelopeFile} is unreadable — ${summary.envelopeError}`,
    );
    return COMMAND_FAILURE_EXIT_CODE;
  }
  if (summary.entries.length === 0) {
    ctx.io.out(`No secrets stored in ${summary.directory}.`);
    return 0;
  }

  ctx.io.out(`${String(summary.entries.length)} secret(s) in ${summary.directory}:`);
  for (const entry of summary.entries) {
    ctx.io.out(`  ${entry.key}  set ${entry.setAt}  provider=${entry.provider}  …${entry.preview}`);
  }
  return 0;
}

export async function runSecretsCommand(input: CommandInput): Promise<number> {
  const subcommand = input.words[1];
  switch (subcommand) {
    case 'set':
      return runSet(input);
    case 'list':
      return runList(input);
    case undefined:
      input.ctx.io.err('agentmanager secrets: a subcommand is required.');
      input.ctx.io.err(SECRETS_USAGE);
      return USAGE_EXIT_CODE;
    default:
      input.ctx.io.err(`agentmanager secrets: unknown subcommand ${JSON.stringify(subcommand)}.`);
      input.ctx.io.err(SECRETS_USAGE);
      return USAGE_EXIT_CODE;
  }
}
