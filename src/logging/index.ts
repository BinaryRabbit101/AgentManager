/**
 * Public surface of the logging subsystem (foundation DESIGN.md §5).
 *
 * Consumers build one {@link createLogging} instance at boot and take child
 * loggers off it; nothing else in the tree opens a log file or formats a record.
 */
export { createLogging, formatPretty, type CorrelationIds, type Logging } from './logger.js';
export { LogRing, type UnsubscribeLog } from './ring.js';
export {
  RotatingFileWriter,
  daysToMs,
  formatDay,
  parseDay,
  type RotationOptions,
} from './rotation.js';
export {
  CREDENTIAL_QUERY_PARAMS,
  REDACTED,
  isSecretKey,
  redactLogArguments,
  redactRecord,
  redactValue,
  scrubText,
} from './redaction.js';
export {
  LEVEL_SEVERITY,
  LOGGING_DEFAULTS,
  LOG_LEVELS,
  isLogLevel,
  type LogLevel,
  type LogQuery,
  type LogRecord,
  type LoggingOptions,
} from './types.js';
