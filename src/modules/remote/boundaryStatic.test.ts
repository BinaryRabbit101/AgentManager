/**
 * **The static half of remote M10 — the D5/D6 merge gate.**
 *
 * remote IMPLEMENTATION §10 asks for three assertions that are about the *shape of
 * the tree* rather than about the behaviour of a running process, and each of them
 * exists because the behavioural test it backs up can only ever observe the code
 * paths a test happens to drive:
 *
 * > **Static assertions**: no `listen(` call in the tree omits an address argument;
 * > no string literal `0.0.0.0` exists outside a test; the remote module imports no
 * > other feature module directly.
 *
 * ## Why static, and what each one buys
 *
 * `boundary.test.ts` proves that *the remote listener* refuses every forbidden
 * address, and `src/lifecycle/bind.test.ts` proves that a process which somehow
 * bound one dies. Neither can see a **new** socket a future element opens in a code
 * path no test reaches — and `server.listen(port)` with no address binds every
 * interface the host has, silently, in both editions. That single omission is the
 * cheapest possible way to cross D5, so it is checked where it cannot hide: over
 * every shipped source file in the tree.
 *
 * ## How the `listen(` scan works
 *
 * It is a real scan, not a `grep -c`:
 *
 * 1. Walk `src/`, `web/` and `scripts/` for shipped sources — every `.ts`/`.tsx`
 *    /`.mjs` that is not a test, a fixture directory or the SDK spike. Tests are
 *    excluded deliberately: a test *should* be able to bind `127.0.0.1` directly.
 * 2. Strip comments (preserving line structure, so a failure names a real line), so
 *    prose about `listen(` — of which this element's sources contain plenty — is not
 *    mistaken for a call.
 * 3. For each `.listen(` occurrence, extract the **balanced** argument list and split
 *    it on top-level commas.
 * 4. Judge the arity:
 *    - **1 argument** → failure. This is exactly `server.listen(port)`, the form
 *      DESIGN §2.1 names ("a bare `server.listen(port)` (which binds every
 *      interface) are **never** used").
 *    - **2 or more** → the second argument must be present and must not be a
 *      wildcard literal. That is the address, and `src/http/server.ts` is the one
 *      place in the tree that supplies it.
 *    - **0 arguments** → allowed *only* because of rule 5 below.
 * 5. `listen()` with no arguments also binds every interface — on a raw `net.Server`.
 *    So the arity rule is closed by a second assertion: **no shipped source outside
 *    `src/http/server.ts` may call `createServer`**. Every argument-less `listen()`
 *    in the tree is therefore a call on foundation's `HttpListener` wrapper, whose
 *    address was already decided by `mountRoutes`' validated options — which is the
 *    property that makes the empty form safe here and would stop being true the
 *    moment a second file created a server of its own.
 * 6. A positive control asserts the scanner actually found the one real
 *    `server.listen(options.port, options.bind, …)` call site. A tree-wide scan that
 *    silently matched nothing would pass forever.
 *
 * ## Relationship to what already exists
 *
 * Remote's own sources are already checked file-by-file by `module.test.ts`
 * ("remote’s source never binds a socket itself") and `proxy.test.ts`, both of which
 * say in as many words that M10 owns the tree-wide version. This is that version:
 * the same properties, over every element rather than over one, so the next element
 * to open a socket fails this gate rather than shipping.
 *
 * Foundation M11 owns a repository-wide dependency-graph check of its own and is a
 * separate suite; the sibling-import assertion below is scoped to what M10 names
 * (remote) and then widened to every feature module, because the check costs the
 * same either way and `src/modules/runner/boundaries.test.ts` has already pinned
 * runner's half.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

import { repoRoot } from '../__tests__/helpers.js';

/** Where shipped code can live. `migrations/` is SQL; `docs/` is prose. */
const SCAN_ROOTS = ['src', 'web', 'scripts'] as const;

/** Directories that hold test scaffolding rather than shipped code. */
const EXCLUDED_DIRS = new Set(['__tests__', '__spike__', 'e2e', 'node_modules', 'dist', 'app']);

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mjs', '.js'];

/** The one file in the tree that is allowed to create a server (see the header). */
const SERVER_OWNER = join('src', 'http', 'server.ts');

function isTestFile(path: string): boolean {
  return /\.(?:test|spike)\.(?:ts|tsx|mjs|js)$/u.test(path);
}

/** Every shipped source file under the scan roots, as repo-relative paths. */
function shippedSources(): readonly string[] {
  const found: string[] = [];

  const walk = (absolute: string): void => {
    for (const entry of readdirSync(absolute)) {
      if (EXCLUDED_DIRS.has(entry)) continue;
      const child = join(absolute, entry);
      if (statSync(child).isDirectory()) {
        walk(child);
        continue;
      }
      if (!SOURCE_EXTENSIONS.some((extension) => entry.endsWith(extension))) continue;
      if (isTestFile(entry)) continue;
      found.push(relative(repoRoot, child));
    }
  };

  for (const root of SCAN_ROOTS) walk(join(repoRoot, root));
  return found;
}

/**
 * Removes comments while preserving every line break and column count, so a
 * reported line number is the line a reader will find in the file.
 *
 * The `[^:]` guard in the line-comment pattern is what stops `https://` inside a
 * string literal being eaten as the start of a comment.
 */
function stripComments(source: string): string {
  const blank = (text: string): string => text.replace(/[^\n]/gu, ' ');
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, (match) => blank(match))
    .replace(
      /(^|[^:/])\/\/[^\n]*/gu,
      (match, keep: string) => keep + blank(match.slice(keep.length)),
    );
}

/** The text between a `(` at `open` and its matching `)`, or `undefined`. */
function balancedArguments(source: string, open: number): string | undefined {
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const character = source[index];
    if (character === '(') depth += 1;
    else if (character === ')') {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, index);
    }
  }
  return undefined;
}

/** Splits an argument list on commas that are not nested inside brackets. */
function splitArguments(text: string): readonly string[] {
  const args: string[] = [];
  let depth = 0;
  let current = '';
  for (const character of text) {
    if ('([{'.includes(character)) depth += 1;
    else if (')]}'.includes(character)) depth -= 1;
    if (character === ',' && depth === 0) {
      args.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  args.push(current);
  return args.map((argument) => argument.trim()).filter((argument) => argument.length > 0);
}

interface ListenCall {
  readonly file: string;
  readonly line: number;
  readonly text: string;
  readonly args: readonly string[];
}

/** Every `.listen(` call site in the shipped tree, with its parsed arguments. */
function listenCalls(): readonly ListenCall[] {
  const calls: ListenCall[] = [];

  for (const file of shippedSources()) {
    const code = stripComments(readFileSync(join(repoRoot, file), 'utf8'));
    for (const match of code.matchAll(/\blisten\s*\(/gu)) {
      const open = code.indexOf('(', match.index);
      const inside = balancedArguments(code, open);
      if (inside === undefined) continue;
      calls.push({
        file,
        line: code.slice(0, match.index).split('\n').length,
        text: `${match[0]}${inside})`.replace(/\s+/gu, ' '),
        args: splitArguments(inside),
      });
    }
  }

  return calls;
}

const WILDCARD_LITERAL = /^['"`](?:0\.0\.0\.0|::|\*)['"`]$/u;

describe('M10 static — no listen() call in the tree omits an address argument', () => {
  it('has no call site passing only a port, which would bind every interface', () => {
    // DESIGN §2.1: "a bare `server.listen(port)` (which binds every interface) are
    // **never** used. The listener is always `server.listen(port, address)` with a
    // validated literal, and the edition/boundary suite asserts the absence of a
    // bare-port listen call statically."
    const offenders = listenCalls().filter((call) => call.args.length === 1);
    expect(offenders).toEqual([]);
  });

  it('passes a non-wildcard address as the second argument wherever it passes any', () => {
    const offenders = listenCalls()
      .filter((call) => call.args.length >= 2)
      .filter((call) => {
        const address = call.args[1] ?? '';
        return address.length === 0 || WILDCARD_LITERAL.test(address);
      });
    expect(offenders).toEqual([]);
  });

  it('creates a server in exactly one shipped file, so an argument-less listen() cannot be a raw socket', () => {
    // The hole this closes: `listen()` with no arguments binds every interface too,
    // *on a raw `net.Server`*. The tree's argument-less calls are all on foundation's
    // `HttpListener` wrapper — a fact that is only true while `mountRoutes` is the
    // one place a server exists.
    const creators = shippedSources().filter((file) =>
      /\bcreateServer\s*\(/u.test(stripComments(readFileSync(join(repoRoot, file), 'utf8'))),
    );
    expect(creators).toEqual([SERVER_OWNER]);
  });

  it('finds the one real bind site, so the scan is not vacuously empty', () => {
    // A tree-wide scan that matched nothing would pass every assertion above
    // forever. This is the positive control: the call foundation actually makes,
    // with the address in the second position.
    const bindSites = listenCalls().filter((call) => call.args.length >= 2);
    expect(bindSites.length).toBeGreaterThanOrEqual(1);
    expect(bindSites.map((call) => call.file)).toContain(SERVER_OWNER);
    expect(bindSites.find((call) => call.file === SERVER_OWNER)?.args[1]).toContain('bind');
  });
});

describe('M10 static — no wildcard bind literal exists outside a test', () => {
  /** Lines where the literal is being *refused* rather than bound. */
  const REFUSAL_CONTEXT = /===|!==|wildcard|isWildcard/iu;

  it('mentions 0.0.0.0 in shipped code only as something being refused', () => {
    const offenders: { file: string; line: number; source: string }[] = [];

    for (const file of shippedSources()) {
      const code = stripComments(readFileSync(join(repoRoot, file), 'utf8'));
      for (const match of code.matchAll(/['"`]0\.0\.0\.0['"`]/gu)) {
        const line = code.slice(0, match.index).split('\n').length;
        const source = code.split('\n')[line - 1] ?? '';
        if (REFUSAL_CONTEXT.test(source)) continue;
        offenders.push({ file, line, source: source.trim() });
      }
    }

    // Every surviving occurrence is a comparison in `assertBindable`,
    // `config.ts`'s `isWildcardLiteral`, `proxy.ts`'s copy of it, or the refusal
    // message that names it — never an address being handed to a socket.
    expect(offenders).toEqual([]);
  });

  it('ships no configuration layer that binds a wildcard', () => {
    // The other way `0.0.0.0` could reach a socket without appearing in any `.ts`
    // file: `config/defaults.json` or an edition layer setting `http.bind`.
    for (const layer of ['defaults.json', 'edition.home.json', 'edition.work.json']) {
      const text = readFileSync(join(repoRoot, 'config', layer), 'utf8');
      expect(text, layer).not.toContain('0.0.0.0');
    }
  });
});

describe('M10 static — the remote module imports no other feature module directly', () => {
  const FEATURES = ['roster', 'projects', 'runner', 'orchestrator', 'remote'] as const;

  function featureSources(feature: string): readonly string[] {
    return shippedSources().filter((file) =>
      file.startsWith(`${join('src', 'modules', feature)}${sep}`),
    );
  }

  it('reaches every sibling element through the registry or the bus, never an import', () => {
    // Foundation §6.1, and M10's third static criterion. Written for `remote`, which
    // is what the criterion names, and then applied to every feature module because
    // the scan costs the same — `src/modules/runner/boundaries.test.ts` already pins
    // runner's own half at element scope.
    const offenders: { file: string; line: string }[] = [];

    for (const feature of FEATURES) {
      const siblings = FEATURES.filter((other) => other !== feature);
      const forbidden = new RegExp(
        `from\\s+'(?:\\.\\./)(?:${siblings.join('|')})(?:/[^']*)?'`,
        'u',
      );
      for (const file of featureSources(feature)) {
        for (const line of readFileSync(join(repoRoot, file), 'utf8').split(/\r?\n/u)) {
          if (forbidden.test(line)) offenders.push({ file, line: line.trim() });
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('finds remote’s sources, so the scan is not looking at an empty list', () => {
    // The failure mode of a path-prefix filter is matching nothing at all.
    expect(featureSources('remote').length).toBeGreaterThan(10);
    expect(featureSources('remote')).toContain(join('src', 'modules', 'remote', 'index.ts'));
  });

  it('reads no edition anywhere in the remote module — D6 is satisfied by not being loaded', () => {
    // The static counterpart of `boundary.test.ts`'s edition matrix: remote cannot
    // "behave like the work edition" because it is never there to behave at all, and
    // an `if (edition === …)` inside it would mean the gate had moved.
    for (const file of featureSources('remote')) {
      const code = stripComments(readFileSync(join(repoRoot, file), 'utf8'));
      expect(code, file).not.toMatch(/config\.edition|edition ===/u);
    }
  });
});
