/**
 * The log API of DESIGN §5.3 — "how the UI reads logs".
 *
 * > "Through the API, never by reading files. The UI has to work identically
 * > over the tailnet, where the filesystem is not reachable."
 *
 * | Route | Serves |
 * |---|---|
 * | `GET /api/logs` | the ring buffer, falling back to the file tails when `since` predates it |
 * | `GET /api/logs/stream` | the same filters, live, over SSE |
 * | `GET /api/logs/download` | a zip of the current log files — the only file-shaped endpoint |
 * | `PUT /api/logs/level` | the runtime level change, "without a restart" |
 *
 * All four are registered `remote: 'allow'` (the default): reading logs from the
 * tailnet is the whole reason §5.3 insists the UI never touches the filesystem.
 * Records are already redacted — §5.4 redacts at write time, before a record
 * reaches either the file or the ring — so nothing here filters on the way out.
 */
import { readFileSync } from 'node:fs';

import { LOG_LEVELS, isLogLevel, type LogQuery } from '../../logging/index.js';
import type { RouteDefinition } from '../../modules/types.js';
import type { HttpDeps } from '../deps.js';
import { listLogFiles, matchesLogQuery, readLogFiles } from '../logFiles.js';
import type { HttpResult } from '../types.js';
import { createZip, type ZipEntry } from '../zip.js';

/** Default page size for `GET /api/logs`, and the ceiling a caller may ask for. */
export const DEFAULT_LOG_LIMIT = 500;
export const MAX_LOG_LIMIT = 5000;

interface ParsedLogQuery {
  readonly query: LogQuery;
  /** Present instead of `query` when a parameter was unusable. */
  readonly failure?: { readonly parameter: string; readonly message: string };
}

/**
 * Parses the `level`/`component`/`sessionId`/`since`/`limit` parameters shared
 * by `/api/logs` and `/api/logs/stream`, so the two cannot drift.
 */
export function parseLogQuery(
  query: URLSearchParams,
  defaultLimit = DEFAULT_LOG_LIMIT,
): ParsedLogQuery {
  const level = query.get('level') ?? undefined;
  if (level !== undefined && !isLogLevel(level)) {
    return {
      query: {},
      failure: {
        parameter: 'level',
        message: `Unknown level "${level}". Expected one of: ${LOG_LEVELS.join(', ')}.`,
      },
    };
  }

  const since = query.get('since') ?? undefined;
  if (since !== undefined && Number.isNaN(Date.parse(since))) {
    return {
      query: {},
      failure: {
        parameter: 'since',
        message: `"${since}" is not a timestamp. Expected ISO-8601 UTC, e.g. 2026-08-16T10:35:00.000Z.`,
      },
    };
  }

  const rawLimit = query.get('limit');
  let limit = defaultLimit;
  if (rawLimit !== null) {
    const parsed = Number(rawLimit);
    if (!Number.isInteger(parsed) || parsed < 0) {
      return {
        query: {},
        failure: { parameter: 'limit', message: `"${rawLimit}" is not a non-negative integer.` },
      };
    }
    limit = Math.min(parsed, MAX_LOG_LIMIT);
  }

  const component = query.get('component') ?? undefined;
  const sessionId = query.get('sessionId') ?? undefined;

  return {
    query: {
      ...(level === undefined ? {} : { level }),
      ...(component === undefined ? {} : { component }),
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(since === undefined ? {} : { since }),
      limit,
    },
  };
}

export function createLogRoutes(deps: HttpDeps): RouteDefinition[] {
  const { logging } = deps;

  return [
    {
      method: 'GET',
      path: '/api/logs',
      description: 'Ring-buffer log query, falling back to the rotated file tails.',
      handler: (req, res): HttpResult => {
        const parsed = parseLogQuery(req.query);
        if (parsed.failure !== undefined) {
          return res.error(400, 'invalid_request', parsed.failure.message, {
            parameter: parsed.failure.parameter,
          });
        }

        // The ring holds the last 2000 records (§5.3). A `since` older than its
        // oldest record means it cannot answer the question that was asked, so
        // the files — which hold everything the ring holds, and more — answer
        // instead. Reading files *instead of* merging with the ring is what
        // makes duplicate-free a property rather than a de-duplication pass.
        const oldest = logging.ring.toArray()[0]?.ts;
        const fallback =
          parsed.query.since !== undefined &&
          (oldest === undefined || oldest > String(parsed.query.since));

        const records = fallback
          ? readLogFiles(deps.logsDir, parsed.query)
          : logging.ring.query(parsed.query);

        return res.json({
          records,
          count: records.length,
          source: fallback ? 'files' : 'ring',
          level: logging.getLevel(),
          ringSize: logging.ring.size,
          ringCapacity: logging.ring.capacity,
        });
      },
    },

    {
      method: 'GET',
      path: '/api/logs/stream',
      description: 'Live log records over SSE, with the same filters as /api/logs.',
      handler: (req, res): HttpResult | void => {
        const parsed = parseLogQuery(req.query, 0);
        if (parsed.failure !== undefined) {
          return res.error(400, 'invalid_request', parsed.failure.message, {
            parameter: parsed.failure.parameter,
          });
        }

        const stream = res.sse();
        // Subscribe rather than poll: two records written in the same
        // millisecond are indistinguishable by timestamp, so a polling tail
        // would drop or repeat lines.
        const unsubscribe = logging.ring.subscribe((record) => {
          if (!matchesLogQuery(record, parsed.query)) return;
          stream.send({ event: 'log', data: record });
        });
        stream.onClose(unsubscribe);
        req.signal.addEventListener('abort', () => stream.close(), { once: true });
      },
    },

    {
      method: 'GET',
      path: '/api/logs/download',
      description: 'Zip of the current log files (support bundle).',
      handler: (req, res): HttpResult => {
        const wantsArchives = req.query.get('all') === 'true';
        const files = listLogFiles(deps.logsDir).filter((file) => wantsArchives || file.active);

        const entries: ZipEntry[] = [];
        for (const file of files) {
          try {
            entries.push({
              name: file.name,
              data: readFileSync(file.path),
              modified: file.modified,
            });
          } catch (cause) {
            deps.logger.warn(
              { file: file.path, err: cause },
              'log file could not be read for the download bundle; skipping it',
            );
          }
        }

        const stamp = deps.clock().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '');
        return res.bytes(createZip(entries), 'application/zip', {
          headers: {
            'content-disposition': `attachment; filename="agentmanager-logs-${stamp}.zip"`,
            'cache-control': 'no-store',
          },
        });
      },
    },

    {
      method: 'PUT',
      path: '/api/logs/level',
      description: 'Changes the log level at runtime, without a restart.',
      handler: (req, res): HttpResult => {
        const fromBody =
          typeof req.body === 'object' && req.body !== null
            ? (req.body as { level?: unknown }).level
            : undefined;
        const requested = typeof fromBody === 'string' ? fromBody : req.query.get('level');

        if (requested === null || requested === undefined) {
          return res.error(400, 'invalid_request', 'A level is required, as {"level": "debug"}.', {
            levels: [...LOG_LEVELS],
          });
        }
        if (!isLogLevel(requested)) {
          return res.error(400, 'invalid_request', `Unknown level "${requested}".`, {
            levels: [...LOG_LEVELS],
          });
        }

        const previous = logging.getLevel();
        logging.setLevel(requested);
        deps.logger.info(
          { previous, level: requested, requestId: req.requestId, origin: req.origin },
          `log level changed to ${requested}`,
        );
        return res.json({ level: requested, previous });
      },
    },
  ];
}
