/**
 * The driver's types, named once.
 *
 * DESIGN §1.3 names better-sqlite3 as the driver, and §1.3 also says feature
 * modules never see the raw handle — they get repositories (M5). Re-exporting
 * the handle type through one module keeps the `better-sqlite3` import surface
 * inside `src/storage/`, so the day the driver changes there is one import list
 * to review rather than a grep across the tree.
 */
import type BetterSqlite3 from 'better-sqlite3';

/** An open SQLite connection. */
export type Database = BetterSqlite3.Database;
