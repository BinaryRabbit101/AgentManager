/**
 * `roles/<role>.md` — the per-seat addendum of DESIGN §4 (IMPLEMENTATION M7).
 *
 * §4's system prompt has four slots and this is the second: "`roles/<role>.md`
 * (only if orchestrator supplied a role)". The file is optional, per role, per
 * agent — a definition that lists `skeptic` in `capabilities.roles` need not
 * carry `roles/skeptic.md`, and an agent that carries the file need not list the
 * role.
 *
 * **Read at load, not at compile.** `compileSession` is a pure function of its
 * inputs so the table tests can drive it without a filesystem (§13), and reading
 * files is the store's job (§2.3). So the store reads every `roles/*.md` while
 * it is already reading `agent.json`, `persona.md` and the skill folder list,
 * and hands the compiler a map; the compiler picks the one the assignment names
 * and ignores the rest. Reading all five costs one `readdir` on a folder the
 * loader has open anyway, and the alternative — a lazy read from inside the
 * compiler — would put a disk touch on the launch path for a file that is
 * usually absent.
 *
 * The bodies are part of the agent's content hash (`store.ts`), so editing a
 * role file by hand is a change the watcher notices, exactly like editing
 * `persona.md`.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { ROLES, type Role } from './schema.js';

/** Per §2.1's folder layout. Re-exported by `store.ts` with the rest. */
export const ROLES_DIRNAME = 'roles';

/** `roles/skeptic.md` — the file one role's addendum lives in. */
export function roleAddendumFile(role: Role): string {
  return `${role}.md`;
}

/** The role a file name names, or `undefined` when it names none. */
export function roleFromAddendumFile(filename: string): Role | undefined {
  const lower = filename.toLowerCase();
  return ROLES.find((role) => roleAddendumFile(role) === lower);
}

/** A role's markdown body by role. Absent roles simply have no key. */
export type RoleAddenda = Readonly<Partial<Record<Role, string>>>;

/**
 * Every `roles/<role>.md` in an agent folder, keyed by role.
 *
 * Never throws: no `roles/` directory is an agent with no addenda, which is the
 * ordinary case, and a file that names no role in the closed v1 vocabulary
 * (§3's `ROLES`) is ignored rather than reported — the folder is hand-editable
 * and a stray note in it is not a fault.
 */
export function readRoleAddenda(agentDir: string): RoleAddenda {
  let entries;
  try {
    entries = readdirSync(join(agentDir, ROLES_DIRNAME), { withFileTypes: true });
  } catch {
    return {};
  }

  const addenda: Partial<Record<Role, string>> = {};
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const role = roleFromAddendumFile(entry.name);
    if (role === undefined) continue;
    try {
      addenda[role] = readFileSync(join(agentDir, ROLES_DIRNAME, entry.name), 'utf8');
    } catch {
      // Unreadable is the same as absent for a file the prompt only appends:
      // the session still starts, one slot lighter.
    }
  }
  return addenda;
}
