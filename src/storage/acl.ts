/**
 * Windows ACL tightening for the data root.
 *
 * DESIGN §1.2/§3 put every secret, transcript and database row under the data
 * root, and §4.4 makes the installer "create the data root tree and tighten its
 * ACL to the current user". The installer is a PowerShell script, but a data
 * root can also come into existence at runtime — a fresh `AGENTMANAGER_HOME`, a
 * relocated root, a dev run — and a directory created by `mkdir` inherits its
 * parent's ACL, which under `%LOCALAPPDATA%` is already user-only but under a
 * user-chosen path may not be. So the tightening is repeated here, at the
 * moment of creation.
 *
 * CLAUDE.md restricts PowerShell to install/setup scripts, so this is `icacls`
 * — a plain Win32 console tool — invoked directly, not a shell script.
 *
 * It is **best-effort by design**: a data root that exists but could not be
 * ACL'd is strictly better than a service that refuses to boot, and the
 * installer path applies the same tightening independently. Every outcome is
 * reported so the caller can log it and surface a degraded-security signal, in
 * the same spirit as the keyfile fallback of §3.1.
 */
import { execFileSync } from 'node:child_process';
import { platform } from 'node:process';

/** Why the ACL was or was not applied. */
export type AclOutcome =
  | { readonly applied: true }
  | { readonly applied: false; readonly reason: 'not-windows' | 'no-principal' | 'failed' };

export interface TightenAclOptions {
  /** Platform to decide against. Defaults to the running platform. */
  readonly platform?: NodeJS.Platform;
  /** Windows principal to grant. Defaults to `%USERDOMAIN%\%USERNAME%` from {@link TightenAclOptions.env}. */
  readonly principal?: string;
  /** Environment the principal is derived from. Defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /** Runs `icacls`. Injectable so tests need not mutate real ACLs. */
  readonly run?: IcaclsRunner;
}

/** Executes `icacls` with the given arguments; throws on a non-zero exit. */
export type IcaclsRunner = (args: readonly string[]) => void;

const defaultRunner: IcaclsRunner = (args) => {
  execFileSync('icacls', [...args], {
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
    timeout: 30_000,
  });
};

/**
 * The Windows principal to grant, from the process environment.
 *
 * `%USERDOMAIN%\%USERNAME%` rather than bare `%USERNAME%`: on a machine joined
 * to a domain the bare name can be ambiguous between the local and domain
 * account, and `icacls` resolves the ambiguity by guessing.
 */
export function currentUserPrincipal(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const user = env['USERNAME']?.trim();
  if (user === undefined || user.length === 0) return undefined;
  const domain = env['USERDOMAIN']?.trim();
  return domain === undefined || domain.length === 0 ? user : `${domain}\\${user}`;
}

/**
 * Grants the current user full control of `directory` and removes inherited
 * access, so nothing but that user (and an administrator willing to take
 * ownership) can read the database, transcripts or secret envelope.
 *
 * The grant is issued **before** inheritance is stripped. In the other order a
 * directory whose only access came from an inherited ACE is briefly — and, if
 * the second call fails, permanently — unreachable by its own owner.
 */
export function tightenDirectoryAcl(
  directory: string,
  options: TightenAclOptions = {},
): AclOutcome {
  const target = options.platform ?? platform;
  if (target !== 'win32') return { applied: false, reason: 'not-windows' };

  const principal = options.principal ?? currentUserPrincipal(options.env ?? process.env);
  if (principal === undefined) return { applied: false, reason: 'no-principal' };

  const run = options.run ?? defaultRunner;
  try {
    // (OI)(CI)F: full control, inherited by files and subdirectories.
    run([directory, '/grant:r', `${principal}:(OI)(CI)F`, '/Q']);
    // /inheritance:r drops ACEs inherited from the parent, leaving the grant above.
    run([directory, '/inheritance:r', '/Q']);
    return { applied: true };
  } catch {
    return { applied: false, reason: 'failed' };
  }
}

/** A human-readable explanation of a non-applied outcome, for the boot log. */
export function describeAclOutcome(outcome: AclOutcome): string {
  if (outcome.applied) return 'data root ACL tightened to the current user';
  switch (outcome.reason) {
    case 'not-windows':
      return 'ACL tightening skipped: not a Windows host';
    case 'no-principal':
      return 'ACL tightening skipped: USERNAME is not set in the environment';
    case 'failed':
      return 'ACL tightening failed: icacls returned an error; the data root keeps its inherited permissions';
  }
}
