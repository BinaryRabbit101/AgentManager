/**
 * Shared logging types (foundation DESIGN.md §5).
 *
 * Kept free of any dependency on `src/config` on purpose: the logging subsystem
 * takes a plain options object so it can be constructed in tests, in scripts,
 * and from the composition root alike. Wiring `AppConfig.logging` into
 * {@link LoggingOptions} is the composition root's job (M7).
 */

/** Severity vocabulary, ordered from least to most severe. */
export const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

/** Numeric severity, matching pino's own scale. */
export const LEVEL_SEVERITY: Readonly<Record<LogLevel, number>> = Object.freeze({
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
});

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && (LOG_LEVELS as readonly string[]).includes(value);
}

/**
 * One log line, as written to disk and as held in the ring buffer.
 *
 * `ts`/`level`/`component`/`msg` are the four fields every record carries
 * (DESIGN §5.1); the correlation ids are present only when the caller supplied
 * them, either per-call or as child-logger bindings.
 */
export interface LogRecord {
  readonly ts: string;
  readonly level: LogLevel;
  readonly component?: string;
  readonly msg?: string;
  readonly sessionId?: string;
  readonly assignmentId?: string;
  readonly projectId?: string;
  readonly agentId?: string;
  readonly requestId?: string;
  readonly [key: string]: unknown;
}

/** Filter accepted by the ring buffer; mirrors `GET /api/logs` (DESIGN §5.3). */
export interface LogQuery {
  /** Minimum severity: `warn` returns `warn`, `error` and `fatal`. */
  readonly level?: LogLevel;
  readonly component?: string;
  readonly sessionId?: string;
  /** Exclusive lower bound on `ts`. */
  readonly since?: string | Date;
  /** Return at most this many records — the most recent matches. */
  readonly limit?: number;
}

export interface LoggingOptions {
  /** Directory that holds `core.log`, `access.log` and their rotated siblings. */
  readonly logsDir: string;
  /** Starting level; changeable at runtime through {@link Logging.setLevel}. */
  readonly level?: LogLevel;
  /** Rotate the active file once a write would push it past this size. */
  readonly maxFileMB?: number;
  /** Rotated archives retained per stream (the active file is extra). */
  readonly maxFiles?: number;
  /** Hard age cap on rotated archives, in days. */
  readonly retentionDays?: number;
  /** Add the human-readable stderr stream. Defaults to "stderr is a TTY". */
  readonly pretty?: boolean;
  /** Ring buffer capacity. Defaults to 2000 records (DESIGN §5.3). */
  readonly ringSize?: number;
  /** Component tag for the root logger. */
  readonly component?: string;
  /** Injectable clock, so retention tests are not time-dependent. */
  readonly now?: () => Date;
  /** Sink for the pretty stream; defaults to `process.stderr`. */
  readonly writePretty?: (chunk: string) => void;
}

/** Resolved defaults for every optional field of {@link LoggingOptions}. */
export const LOGGING_DEFAULTS: {
  readonly level: LogLevel;
  readonly maxFileMB: number;
  readonly maxFiles: number;
  readonly retentionDays: number;
  readonly ringSize: number;
  readonly component: string;
} = Object.freeze({
  level: 'info',
  maxFileMB: 10,
  maxFiles: 10,
  retentionDays: 14,
  ringSize: 2000,
  component: 'core',
});
