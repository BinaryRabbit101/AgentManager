/**
 * The Windows process lifecycle — foundation milestone M9, DESIGN §4.2 and
 * §6.3.
 *
 * Four concerns, one per file, all of them things a *process* has and a library
 * does not:
 *
 * - `lock.ts` — the exclusive-handle single-instance lock on `run/core.lock`.
 * - `portFile.ts` — publication, discovery and staleness of `run/core.port`.
 * - `shutdown.ts` — the `service.shutdownGraceSeconds` budget and the last rites.
 * - `bind.ts` — the post-start bind-time invariant that pins D5/D6.
 *
 * Nothing here imports a module, opens a database or writes a log line: the
 * composition root (`src/main.ts`) wires these to the service it built, which
 * is what keeps every branch above testable without a running core.
 */
export {
  acquireInstanceLock,
  EXCLUSIVE_HANDLES_SUPPORTED,
  EXCLUSIVE_OPEN_FLAGS,
  LOCK_FILENAME,
  type AcquireLockOptions,
  type InstanceLock,
  type LockAttempt,
  type LockHeld,
  type LockOwner,
  type LockRefused,
} from './lock.js';

export {
  alreadyRunningMessage,
  probeCore,
  readPortFile,
  removePortFile,
  writePortFile,
  DEFAULT_PROBE_TIMEOUT_MS,
  PORT_FILENAME,
  type CoreProbe,
  type PortRecord,
  type ProbeOptions,
} from './portFile.js';

export {
  assertBindInvariant,
  isLoopback,
  normaliseAddress,
  observeListeners,
  BindInvariantError,
  BIND_INVARIANT_EXIT_CODE,
  REMOTE_SERVICE,
  type BindInvariantInput,
  type BindInvariantReport,
  type BoundAddress,
  type ListenerObservation,
  type ObservedListener,
  type RemoteService,
} from './bind.js';

export {
  createShutdownController,
  installShutdownSignals,
  SHUTDOWN_SIGNALS,
  type ShutdownController,
  type ShutdownControllerOptions,
  type ShutdownOutcome,
  type ShutdownPath,
  type SignalTarget,
} from './shutdown.js';
