/**
 * AgentManager core entry point.
 *
 * Foundation milestone M1 scope only: the process starts, answers `--version`
 * and `--help`, and exits cleanly. Configuration loading (M2), logging (M3),
 * storage (M4/M5), secrets (M6), the module system and composition root (M7),
 * the HTTP surface (M8) and the Windows process lifecycle (M9) each arrive in
 * their own milestone — see docs/foundation/IMPLEMENTATION.md.
 *
 * Nothing here touches the data root; M1 must not write anything anywhere.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { argv, exit, stderr, stdout } from 'node:process';

const requireFromHere = createRequire(import.meta.url);

/** Reported when package.json cannot be located next to the running bundle. */
export const UNKNOWN_VERSION = '0.0.0-unknown';

export const PROGRAM_NAME = 'agentmanager';

export interface ParsedArgs {
  readonly version: boolean;
  readonly help: boolean;
  /** Arguments this milestone does not understand yet. */
  readonly unknown: readonly string[];
}

/**
 * Parses the argument list (excluding `node` and the script path).
 *
 * Deliberately minimal: the real flag set (`--edition`, `--data-root`, `--set`)
 * belongs to the configuration loader in M2, and is rejected as unknown here
 * rather than silently ignored.
 */
export function parseArgs(args: readonly string[]): ParsedArgs {
  let version = false;
  let help = false;
  const unknown: string[] = [];

  for (const arg of args) {
    switch (arg) {
      case '--version':
      case '-v':
        version = true;
        break;
      case '--help':
      case '-h':
        help = true;
        break;
      default:
        unknown.push(arg);
        break;
    }
  }

  return { version, help, unknown };
}

/** The version string from package.json, or {@link UNKNOWN_VERSION}. */
export function readVersion(): string {
  try {
    const pkg = requireFromHere('../package.json') as { version?: unknown };
    return typeof pkg.version === 'string' && pkg.version.length > 0
      ? pkg.version
      : UNKNOWN_VERSION;
  } catch {
    return UNKNOWN_VERSION;
  }
}

export function helpText(): string {
  return [
    `${PROGRAM_NAME} ${readVersion()}`,
    '',
    'Usage:',
    `  ${PROGRAM_NAME} [options]`,
    '',
    'Options:',
    '  -v, --version   Print the version and exit',
    '  -h, --help      Print this help and exit',
  ].join('\n');
}

export interface RunIo {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

const defaultIo: RunIo = {
  out: (line) => void stdout.write(`${line}\n`),
  err: (line) => void stderr.write(`${line}\n`),
};

/**
 * Runs the CLI and returns the process exit code. Pure with respect to the
 * process: everything observable goes through {@link RunIo}.
 */
export function run(args: readonly string[], io: RunIo = defaultIo): number {
  const parsed = parseArgs(args);

  if (parsed.version) {
    io.out(readVersion());
    return 0;
  }

  if (parsed.help) {
    io.out(helpText());
    return 0;
  }

  if (parsed.unknown.length > 0) {
    io.err(`${PROGRAM_NAME}: unrecognised argument(s): ${parsed.unknown.join(' ')}`);
    io.err(helpText());
    return 2;
  }

  io.out(`${PROGRAM_NAME} ${readVersion()} — skeleton only; no service is started yet.`);
  return 0;
}

/** True when this file is the process entry point rather than an import. */
function isEntryPoint(): boolean {
  const invoked = argv[1];
  if (invoked === undefined) return false;
  try {
    return realpathSync(invoked) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  exit(run(argv.slice(2)));
}
