/**
 * The Windows ACL steps DESIGN §3.1 requires of the secrets directory and the
 * keyfile: "written with an ACL granting the current user only and inheritance
 * disabled".
 *
 * The directory case is already solved. `src/storage/acl.ts` (M4) tightens the
 * data root the same way, and it is a **pure Win32 helper** — it imports
 * `node:child_process` and `node:process` and nothing else, holds no state, and
 * is not part of storage's module API (§6.1's "feature modules never import
 * each other" is about modules reaching into each other's behaviour, not about
 * a foundation-internal `icacls` wrapper). Re-implementing it here would mean
 * two places to get `/grant:r` and `/inheritance:r` right, and the flags are
 * exactly what the acceptance test asserts. So it is imported, and this module
 * is the single place that does so.
 *
 * The file case has no equivalent there, because storage only ever ACLs
 * directories: a file must not carry the `(OI)(CI)` inheritance flags, which
 * are meaningless on a leaf and make `icacls` output confusing to read.
 */
import { execFileSync } from 'node:child_process';
import { platform as runningPlatform } from 'node:process';

import { currentUserPrincipal, describeAclOutcome, tightenDirectoryAcl } from '../storage/acl.js';
import type { AclOutcome, IcaclsRunner } from '../storage/acl.js';

export { currentUserPrincipal, describeAclOutcome, tightenDirectoryAcl };
export type { AclOutcome, IcaclsRunner };

export interface TightenOptions {
  /** Platform to decide against. Defaults to the running platform. */
  readonly platform?: NodeJS.Platform;
  /** Windows principal to grant. Defaults to `%USERDOMAIN%\%USERNAME%`. */
  readonly principal?: string;
  /** Environment the principal is derived from. Defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /** Runs `icacls`. Injectable so tests need not mutate real ACLs. */
  readonly run?: IcaclsRunner;
}

/** Executes `icacls`; throws on a non-zero exit. Mirrors storage's private default. */
export const defaultIcacls: IcaclsRunner = (args) => {
  execFileSync('icacls', [...args], {
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
    timeout: 30_000,
  });
};

/**
 * Grants the current user full control of `file` and removes inherited access.
 *
 * Grant first, then strip inheritance — the same ordering rule as the directory
 * helper, and for the same reason: a file whose only access came from an
 * inherited ACE would otherwise be locked away from its own owner if the second
 * call failed.
 *
 * Best-effort, like every ACL step in this project: a keyfile that exists but
 * could not be tightened is strictly better than a service that refuses to
 * boot, and the caller logs the outcome.
 */
export function tightenFileAcl(file: string, options: TightenOptions = {}): AclOutcome {
  const target = options.platform ?? runningPlatform;
  if (target !== 'win32') return { applied: false, reason: 'not-windows' };

  const principal = options.principal ?? currentUserPrincipal(options.env ?? process.env);
  if (principal === undefined) return { applied: false, reason: 'no-principal' };

  const run = options.run ?? defaultIcacls;
  try {
    run([file, '/grant:r', `${principal}:F`, '/Q']);
    run([file, '/inheritance:r', '/Q']);
    return { applied: true };
  } catch {
    return { applied: false, reason: 'failed' };
  }
}

/** The directory form, forwarded so callers need only this module. */
export function tightenSecretsDirectoryAcl(
  directory: string,
  options: TightenOptions = {},
): AclOutcome {
  return tightenDirectoryAcl(directory, {
    ...(options.platform === undefined ? {} : { platform: options.platform }),
    ...(options.principal === undefined ? {} : { principal: options.principal }),
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.run === undefined ? {} : { run: options.run }),
  });
}
