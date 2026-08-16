/**
 * The minimal logging shape storage accepts.
 *
 * Storage is a critical module (§6.2) that must come up before, and
 * independently of, the pino logger of §5 — and the migration runner is also
 * driven from install scripts and tests where no logger exists. It therefore
 * takes a plain function rather than importing the logging module, and the
 * composition root adapts `ctx.logger` to it.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Structured log sink: level, message, and optional correlation fields. */
export type LogFn = (level: LogLevel, msg: string, data?: Record<string, unknown>) => void;

/** Discards everything. The default when no sink is supplied. */
export const silentLog: LogFn = () => {};
