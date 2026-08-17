/**
 * The HTTP surface — foundation DESIGN §6.4, milestone M8.
 *
 * One route table, one framework instance, two possible listeners. The headline
 * export is the **route handler contract** in `./types.js`: every feature
 * module and the remote element write handlers against
 * `(req: RequestContext, res: ResponseTools) => HttpResult | void`, and
 * {@link mountRoutes} is the `(routeTable, listenerOptions) => server` function
 * remote calls to put the same table on the tailnet listener.
 */
export type {
  HttpMethod,
  HttpResult,
  Middleware,
  RequestContext,
  RequestOrigin,
  ResponseInit,
  ResponseTools,
  RouteHandler,
  RouteSource,
  SseMessage,
  SseStream,
} from './types.js';

export {
  REQUEST_ID_HEADER,
  bytes,
  empty,
  error,
  json,
  notFound,
  text,
  writeResult,
} from './response.js';

export { Router, splitPath, type RouteMatch } from './router.js';

export {
  BodyTooLargeError,
  DEFAULT_MAX_BODY_BYTES,
  InvalidBodyError,
  createRequestContext,
  normalisePath,
  parseBody,
  readBody,
  type MutableRequestContext,
  type RequestContextOptions,
} from './request.js';

export { SSE_HEARTBEAT_MS, openSse, type SseOptions } from './sse.js';

export { mountRoutes, type HttpListener, type ListenerOptions } from './server.js';

export type { ConfigOrigins, HttpDeps } from './deps.js';

export {
  createHttpModule,
  HTTP_MODULE_ID,
  HTTP_SERVICE,
  type HttpModuleOptions,
  type HttpService,
} from './module.js';

export { ZipReadError, createZip, readZip, type ZipEntry } from './zip.js';

export {
  DEFAULT_TAIL_BYTES,
  listLogFiles,
  matchesLogQuery,
  readLogFiles,
  type LogFileInfo,
  type ReadLogFilesOptions,
} from './logFiles.js';

export { createHealthRoutes, uptimeSeconds } from './routes/health.js';
export { buildEffectiveConfig, createConfigRoutes, sanitiseOrigin } from './routes/config.js';
export { DEFAULT_LOG_LIMIT, MAX_LOG_LIMIT, createLogRoutes, parseLogQuery } from './routes/logs.js';
export { MAX_REPLAY, createEventRoutes, parseTypes, type EventFrame } from './routes/events.js';
export { createServiceRoutes } from './routes/service.js';
export {
  API_PREFIX,
  PLACEHOLDER_INDEX_HTML,
  contentTypeFor,
  createSpaRoutes,
  resolveWebRoot,
  safeJoin,
} from './routes/spa.js';
