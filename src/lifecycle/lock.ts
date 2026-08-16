/**
 * The single-instance lock of DESIGN §4.2.
 *
 * > "the core opens `run/core.lock` with an **exclusive handle** held for its
 * > lifetime. A second instance fails to acquire, prints the running port from
 * > `run/core.port`, and exits 0. This is more reliable on Windows than PID
 * > files, since the handle dies with the process even on a hard kill."
 *
 * ## What "exclusive handle" means on Windows
 *
 * A Win32 file handle carries a *share mode*. libuv opens files with
 * `FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE` — everything is
 * shared — **unless** `UV_FS_O_EXLOCK` is set, in which case the share mode is
 * zero and the file system object is owned by that handle alone. Any other
 * process attempting to open, read, rename or delete it gets
 * `ERROR_SHARING_VIOLATION`, which libuv reports as `EBUSY`.
 *
 * Node has no named constant for that flag (`fs.constants.O_EXLOCK` exists only
 * on the BSDs), but a numeric `flags` argument is passed to `uv_fs_open`
 * untouched, so {@link EXCLUSIVE_OPEN_FLAGS} is exactly the open the design
 * asks for. Two properties follow, and they are the whole reason §4.2 picks a
 * handle over a PID file:
 *
 * 1. The exclusion is enforced by the kernel, not by a convention two processes
 *    have to agree on.
 * 2. The kernel closes the handle when the process dies **however** it dies —
 *    `TerminateProcess`, a power cut, a debugger detach — so a hard-killed core
 *    leaves a lock file that is instantly acquirable again. There is no stale
 *    lock and therefore no "is PID 1234 still the core, or has Windows recycled
 *    the number?" guesswork. (The *port* file has no such protection, which is
 *    why staleness is a real case there — see `portFile.ts`.)
 *
 * On a platform without the share mode (`UV_FS_O_EXLOCK` is 0 on Linux) the
 * open always succeeds, so the acquisition falls back to a liveness check on
 * the PID recorded in the file. That is the weaker mechanism §4.2 rejects, and
 * it is used **only** where the strong one does not exist; the host is Windows
 * 11 (DESIGN §preamble), where the first path always applies.
 */
import {
  closeSync,
  constants,
  ftruncateSync,
  mkdirSync,
  openSync,
  readSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';

/** `<dataRoot>\run\core.lock` (DESIGN §1.2). */
export const LOCK_FILENAME = 'core.lock';

/**
 * `UV_FS_O_EXLOCK` from `uv.h`. Windows maps it to a zero share mode; the BSDs
 * map it to `O_EXLOCK`; elsewhere it is 0 and the open is unaffected.
 */
const UV_FS_O_EXLOCK = 0x1000_0000;

/** Create-or-open, read/write, no sharing. See the module comment. */
export const EXCLUSIVE_OPEN_FLAGS = UV_FS_O_EXLOCK | constants.O_CREAT | constants.O_RDWR;

/** True where the kernel enforces the exclusive share mode above. */
export const EXCLUSIVE_HANDLES_SUPPORTED = process.platform === 'win32';

/** libuv's report of `ERROR_SHARING_VIOLATION` and its neighbours. */
const CONTENDED_CODES: ReadonlySet<string> = new Set(['EBUSY', 'EACCES', 'EPERM', 'EEXIST']);

/** What the lock holder writes into the file, for forensics after a crash. */
export interface LockOwner {
  readonly pid: number;
  readonly startedAt: string;
}

export interface InstanceLock {
  readonly path: string;
  /** Open for the process lifetime; closing it *is* releasing the lock. */
  readonly fd: number;
  readonly released: boolean;
  /** Closes the handle and removes the file. Idempotent, and never throws. */
  release(): void;
}

export interface LockHeld {
  readonly acquired: true;
  readonly lock: InstanceLock;
}

export interface LockRefused {
  readonly acquired: false;
  /** The errno libuv reported, when the refusal came from the open itself. */
  readonly code?: string;
  readonly message: string;
  /** The PID recorded in the file, when it could be read (never on Windows). */
  readonly owner?: LockOwner;
}

export type LockAttempt = LockHeld | LockRefused;

export interface AcquireLockOptions {
  /** Absolute path to `run/core.lock`. Its directory is created if missing. */
  readonly path: string;
  readonly pid?: number;
  readonly now?: () => Date;
  /** Probes whether a PID is alive. Only consulted on platforms without the share mode. */
  readonly isAlive?: (pid: number) => boolean;
}

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Reads the first 512 bytes of an open lock file without moving the fd. */
function readOwner(fd: number): LockOwner | undefined {
  try {
    const buffer = Buffer.alloc(512);
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    if (read === 0) return undefined;
    const parsed: unknown = JSON.parse(buffer.subarray(0, read).toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const { pid, startedAt } = parsed as { pid?: unknown; startedAt?: unknown };
    if (typeof pid !== 'number' || !Number.isInteger(pid)) return undefined;
    return { pid, startedAt: typeof startedAt === 'string' ? startedAt : '' };
  } catch {
    return undefined;
  }
}

/**
 * Takes the lock, or reports why it could not be taken.
 *
 * Never throws for the contended case — "another core is running" is an
 * expected outcome that ends in exit 0, not an error.
 */
export function acquireInstanceLock(options: AcquireLockOptions): LockAttempt {
  const pid = options.pid ?? process.pid;
  const now = options.now ?? ((): Date => new Date());
  const isAlive = options.isAlive ?? defaultIsAlive;

  mkdirSync(dirname(options.path), { recursive: true });

  let fd: number;
  try {
    fd = openSync(options.path, EXCLUSIVE_OPEN_FLAGS);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== undefined && CONTENDED_CODES.has(code)) {
      return {
        acquired: false,
        code,
        message:
          `Another agentmanager core holds ${options.path} (${code}). ` +
          'The lock is an exclusive file handle, so it is held only while that process lives.',
      };
    }
    throw error;
  }

  // Only meaningful where the kernel does not enforce the share mode: there,
  // the open above told us nothing, so the recorded PID has to.
  if (!EXCLUSIVE_HANDLES_SUPPORTED) {
    const owner = readOwner(fd);
    if (owner !== undefined && owner.pid !== pid && isAlive(owner.pid)) {
      closeSync(fd);
      return {
        acquired: false,
        message:
          `Another agentmanager core (pid ${String(owner.pid)}) holds ${options.path}. ` +
          'This platform has no exclusive share mode, so the PID recorded in the lock was used instead.',
        owner,
      };
    }
  }

  const record: LockOwner = { pid, startedAt: now().toISOString() };
  try {
    ftruncateSync(fd, 0);
    writeSync(fd, `${JSON.stringify(record)}\n`, 0, 'utf8');
  } catch {
    // The content is forensic only — nothing reads it while the lock is held,
    // because nothing *can* on Windows. A failed write must not fail the lock.
  }

  let released = false;
  const lock: InstanceLock = {
    path: options.path,
    fd,
    get released() {
      return released;
    },
    release: () => {
      if (released) return;
      released = true;
      try {
        closeSync(fd);
      } catch {
        // Already closed, or the process is on its way out anyway.
      }
      try {
        unlinkSync(options.path);
      } catch {
        // A leftover file is harmless: acquisition is by handle, not by
        // existence, so the next start opens the same path and takes it.
      }
    },
  };

  return { acquired: true, lock };
}
