/**
 * runner's session status vocabulary, as an array (runner §2.2, DESIGN §9.2).
 *
 * `api/types.ts` states the *type*; a table-driven test needs the *values*, and
 * a second hand-written list in a test file is the kind of copy that silently
 * stops covering a status when one is added. This is the one list.
 */

import type { SessionStatus } from '../api/types';

export const SESSION_STATUSES: readonly SessionStatus[] = [
  'queued',
  'running',
  'paused',
  'done',
  'failed',
  'interrupted',
  'orphaned',
];
