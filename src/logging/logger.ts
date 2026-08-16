/**
 * The logging subsystem (foundation DESIGN.md §5).
 *
 * `createLogging` builds the two file streams (`core.log`, `access.log`), the
 * shared ring buffer, the optional pretty stderr stream, and the redacting pino
 * instances in front of them. It takes a plain options object rather than
 * `AppConfig` on purpose — nothing here imports `src/config`, so the loader and
 * the logger can be built and tested independently; the composition root maps
 * `config.logging` onto {@link LoggingOptions} (M7).
 *
 * Every record carries `ts` (ISO-8601 UTC), `level`, `component` and `msg`, plus
 * whichever correlation ids the caller supplied — per call, or bound once on a
 * child logger.
 */
import { pino, type DestinationStream, type Logger, type LoggerOptions, type LogFn } from 'pino';

import { redactLogArguments, redactRecord, redactValue, scrubText } from './redaction.js';
import { LogRing } from './ring.js';
import { RotatingFileWriter, daysToMs } from './rotation.js';
import {
  LOGGING_DEFAULTS,
  type LogLevel,
  type LogRecord,
  type LoggingOptions,
  isLogLevel,
} from './types.js';

/** Correlation ids every component may bind or pass per call (DESIGN §5.1). */
export interface CorrelationIds {
  readonly sessionId?: string;
  readonly assignmentId?: string;
  readonly projectId?: string;
  readonly agentId?: string;
  readonly requestId?: string;
}

export interface Logging {
  /** Service log — boot, module lifecycle, storage, runner decisions, errors. */
  readonly logger: Logger;
  /** Request audit trail; a separate write path onto `access.log`. */
  readonly accessLogger: Logger;
  /** Child of {@link logger} tagged with a component id (and optional ids). */
  child(component: string, bindings?: CorrelationIds & Record<string, unknown>): Logger;
  /** The last `ringSize` records, already redacted, for `GET /api/logs`. */
  readonly ring: LogRing;
  /** Changes the level of both streams and every child, without a restart. */
  setLevel(level: LogLevel): void;
  getLevel(): LogLevel;
  /** Runs the retention pass on both streams (also run once at construction). */
  prune(): void;
  flushAndClose(): Promise<void>;
  readonly paths: { readonly core: string; readonly access: string };
}

const BYTES_PER_MB = 1024 * 1024;

export function createLogging(options: LoggingOptions): Logging {
  const level = options.level ?? LOGGING_DEFAULTS.level;
  const now = options.now ?? (() => new Date());
  const maxFileMB = options.maxFileMB ?? LOGGING_DEFAULTS.maxFileMB;
  const maxBytes = Math.max(1, Math.floor(maxFileMB * BYTES_PER_MB));
  const maxFiles = options.maxFiles ?? LOGGING_DEFAULTS.maxFiles;
  const retentionMs = daysToMs(options.retentionDays ?? LOGGING_DEFAULTS.retentionDays);
  const ring = new LogRing(options.ringSize ?? LOGGING_DEFAULTS.ringSize);
  const rootComponent = options.component ?? LOGGING_DEFAULTS.component;

  // Explicit rather than inferred so tests are never at the mercy of whether the
  // runner happens to be attached to a terminal (DESIGN §5.1 asks for the dev
  // stream only when the core was started from a console).
  const pretty = options.pretty ?? process.stderr.isTTY === true;
  const writePretty = options.writePretty ?? ((chunk: string) => void process.stderr.write(chunk));
  const emitPretty = pretty
    ? (record: LogRecord): void => {
        writePretty(formatPretty(record));
      }
    : undefined;

  const rotation = { dir: options.logsDir, maxBytes, maxFiles, retentionMs, now };
  const writers = {
    core: new RotatingFileWriter({ ...rotation, baseName: 'core' }),
    access: new RotatingFileWriter({ ...rotation, baseName: 'access' }),
  };

  // `base: null` rather than `base: { component }`. pino concatenates the root's
  // base bindings with each child's, so a component in both put **two**
  // `component` keys on every child line — valid JSONL, but `JSON.parse` keeps
  // only the last and any other reader may keep either (flagged at M7). The
  // child binding is now the single source: even the root stream's own logger
  // below is a child carrying exactly one. `null` also keeps pino's default
  // `pid`/`hostname` bindings off the record, which `base: { component }` did
  // implicitly and the record contract of §5.1 does not include.
  const loggerOptions = (): LoggerOptions => ({
    level,
    base: null,
    formatters: {
      level: (label: string) => ({ level: label }),
      log: redactRecord,
    },
    // pino runs `formatters.log` before its serializers, so by this point an
    // `err` value is already the redacted plain object of `redactError`. The
    // standard serializer would rewrite its `type` to the constructor name of
    // that plain object ("Object"); redaction is idempotent, so it stands in.
    serializers: { err: redactValue },
    timestamp: () => `,"ts":"${now().toISOString()}"`,
    hooks: {
      logMethod(this: Logger, args: Parameters<LogFn>, method: LogFn): void {
        Reflect.apply(method, this, redactLogArguments(args));
      },
    },
  });

  // The two stream roots carry no bindings at all; every logger handed out is a
  // child of one of them, tagged with its component exactly once.
  const coreRoot = pino(loggerOptions(), destination(writers.core, ring, emitPretty));
  const accessRoot = pino(loggerOptions(), destination(writers.access, ring, emitPretty));
  const logger = coreRoot.child({ component: rootComponent });
  const accessLogger = accessRoot.child({ component: 'access' });

  // pino copies the level onto a child at creation, so a later change on the
  // parent does not reach children already made. Keeping the list is what makes
  // `PUT /api/logs/level` (DESIGN §5.3) actually affect the modules doing the
  // logging. Children are per-module and per-stream, so the list stays small.
  const children: Logger[] = [];
  let currentLevel = level;

  return {
    logger,
    accessLogger,
    ring,
    paths: { core: writers.core.path, access: writers.access.path },

    child(component, bindings) {
      const extra =
        bindings === undefined ? {} : (redactValue(bindings) as Record<string, unknown>);
      const created = coreRoot.child({ ...extra, component });
      children.push(created);
      return created;
    },

    setLevel(next) {
      if (!isLogLevel(next)) throw new RangeError(`unknown log level: ${String(next)}`);
      currentLevel = next;
      // The roots as well as their children: a child made *after* a level change
      // inherits from its root, so leaving the roots behind would silently
      // resurrect the old level for every module that logs late (§5.3).
      coreRoot.level = next;
      accessRoot.level = next;
      logger.level = next;
      accessLogger.level = next;
      for (const created of children) created.level = next;
    },

    getLevel() {
      return currentLevel;
    },

    prune() {
      writers.core.prune();
      writers.access.prune();
    },

    flushAndClose() {
      // Writes are synchronous, so there is nothing buffered to flush; the
      // promise exists because callers (module `stop()`) are async.
      writers.core.close();
      writers.access.close();
      return Promise.resolve();
    },
  };
}

/**
 * The pino destination: redact-as-a-backstop, write, tee.
 *
 * The line has already been through the formatter and the log-method hook; the
 * second scrub catches anything pino itself contributed (a serializer's output,
 * child bindings a caller attached directly through `logger.child`). It runs
 * before both the file write and the ring buffer, so neither ever holds a raw
 * credential (DESIGN §5.4).
 */
function destination(
  writer: RotatingFileWriter,
  ring: LogRing,
  emitPretty: ((record: LogRecord) => void) | undefined,
): DestinationStream {
  return {
    write(line: string): void {
      const clean = scrubText(line);
      writer.write(clean);
      const record = parseRecord(clean);
      if (record === undefined) return;
      ring.push(record);
      emitPretty?.(record);
    },
  };
}

function parseRecord(line: string): LogRecord | undefined {
  try {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    return parsed as LogRecord;
  } catch {
    return undefined;
  }
}

/**
 * The dev stderr stream: `HH:MM:SS.mmm LEVEL [component] msg key=value`.
 *
 * Hand-rolled because DESIGN §5.1 makes pino the *only* logging dependency —
 * pino-pretty would be a second one for twenty lines of formatting.
 */
export function formatPretty(record: LogRecord): string {
  const { ts, level, component, msg, ...rest } = record;
  const time = ts.length >= 23 ? ts.slice(11, 23) : ts;
  const label = level.toUpperCase().padEnd(5);
  const fields = Object.entries(rest)
    .map(([key, value]) => `${key}=${formatField(value)}`)
    .join(' ');
  const tail = fields.length > 0 ? ` ${fields}` : '';
  return `${time} ${label} [${component ?? '-'}] ${msg ?? ''}${tail}\n`;
}

function formatField(value: unknown): string {
  if (typeof value === 'string') return value.includes(' ') ? JSON.stringify(value) : value;
  try {
    return JSON.stringify(value) ?? '[undefined]';
  } catch {
    return '[unserialisable]';
  }
}
