/**
 * Data-root bootstrap: create the DESIGN §1.2 tree, then tighten its ACL.
 *
 * Directories only. The contents of those directories belong to whoever owns
 * them — the library's `roster.json`, `.gitignore` and seeded agents are
 * roster's on first run (§4.4), `config/config.json` is the installer's or the
 * config loader's, and `run/core.port` is the lifecycle's. Creating an empty
 * shell here and nothing more is what keeps exactly one component knowing each
 * subtree's shape.
 */
import { mkdirSync, statSync } from 'node:fs';

import {
  describeAclOutcome,
  tightenDirectoryAcl,
  type AclOutcome,
  type TightenAclOptions,
} from './acl.js';
import { silentLog, type LogFn } from './log.js';
import {
  dataRootPaths,
  managedDirectories,
  type DataRootPathOptions,
  type DataRootPaths,
} from './paths.js';

export interface BootstrapOptions extends DataRootPathOptions {
  /** Absolute path to the data root (`AGENTMANAGER_HOME`, or the §1.2 default). */
  readonly dataRoot: string;
  /**
   * Tighten the data root's ACL when this call creates it. Default `true`.
   *
   * Only on creation: re-ACLing an existing root on every boot would undo a
   * deliberate change by the owner (a shared library directory, say) and costs
   * two child processes for nothing. The installer (§4.4) tightens
   * unconditionally, which is the right place for an unconditional policy.
   */
  readonly tightenAcl?: boolean;
  /** ACL knobs, for tests and non-Windows hosts. */
  readonly acl?: TightenAclOptions;
  readonly log?: LogFn;
}

export interface BootstrapResult {
  readonly paths: DataRootPaths;
  /** True when the data root itself did not exist before this call. */
  readonly created: boolean;
  /** Directories this call had to create, in creation order. */
  readonly createdDirectories: readonly string[];
  /** Outcome of the ACL step; `undefined` when it was not attempted. */
  readonly acl?: AclOutcome;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Creates the §1.2 tree under `dataRoot`, returning the resolved layout.
 *
 * Idempotent: a second call creates nothing and reports an empty
 * `createdDirectories`. A missing `run/` or `cache/` on a later boot is
 * recreated by the same pass, which is §1.2's "recreated on boot if missing"
 * without a second mechanism to keep in step.
 */
export function bootstrapDataRoot(options: BootstrapOptions): BootstrapResult {
  const log = options.log ?? silentLog;
  const paths = dataRootPaths(options.dataRoot, options);

  const rootExisted = isDirectory(paths.dataRoot);
  const createdDirectories: string[] = [];

  for (const directory of managedDirectories(paths)) {
    if (isDirectory(directory)) continue;
    mkdirSync(directory, { recursive: true });
    createdDirectories.push(directory);
  }

  if (createdDirectories.length > 0) {
    log('info', 'created data-root directories', {
      dataRoot: paths.dataRoot,
      count: createdDirectories.length,
    });
  }

  if (rootExisted || options.tightenAcl === false) {
    return { paths, created: !rootExisted, createdDirectories };
  }

  const acl = tightenDirectoryAcl(paths.dataRoot, options.acl ?? {});
  log(acl.applied ? 'info' : 'warn', describeAclOutcome(acl), { dataRoot: paths.dataRoot });

  return { paths, created: true, createdDirectories, acl };
}
