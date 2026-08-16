/**
 * Acceptance tests for foundation milestone M2 (IMPLEMENTATION.md §2).
 *
 * Each `it` below maps to one of the milestone's acceptance bullets; the rest
 * cover the surrounding behaviour the bullets depend on.
 */
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ConfigError,
  CONFIG_EXIT_CODE,
  WORK_EDITION_REMOTE_MESSAGE,
  findInstallRoot,
  loadConfig,
} from './index.js';
import type { LoadConfigOptions, LoadedConfig } from './index.js';

const repoRoot = findInstallRoot(dirname(fileURLToPath(import.meta.url)));

let base: string;
let installRoot: string;
let dataRoot: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'agentmanager-config-'));
  installRoot = join(base, 'install');
  dataRoot = join(base, 'data');
  // The fixture install root is the real shipped config directory, so these
  // tests exercise the files that actually ship rather than a stand-in.
  cpSync(join(repoRoot, 'config'), join(installRoot, 'config'), { recursive: true });
  mkdirSync(join(dataRoot, 'config'), { recursive: true });
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function writeMachineConfig(values: Record<string, unknown> | string): void {
  writeFileSync(
    join(dataRoot, 'config', 'config.json'),
    typeof values === 'string' ? values : JSON.stringify(values, null, 2),
    'utf8',
  );
}

/** `env` defaults to `{}` so the ambient environment never leaks into a test. */
function load(
  options: Omit<LoadConfigOptions, 'installRoot' | 'dataRootOverride'> = {},
): LoadedConfig {
  return loadConfig({ argv: [], env: {}, ...options, installRoot, dataRootOverride: dataRoot });
}

function expectConfigError(run: () => unknown): ConfigError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return error as ConfigError;
  }
  throw new Error('expected loadConfig to throw a ConfigError');
}

describe('layer precedence (M2 acceptance: every layer)', () => {
  it('resolves all five layers, each overriding the one below it', () => {
    writeMachineConfig({ http: { port: 7001 }, logging: { level: 'warn' } });

    const { config, sources } = load({
      env: { AGENTMANAGER_HTTP_PORT: '7002', AGENTMANAGER_RUNNER_QUEUELIMIT: '11' },
      argv: ['--set', 'http.port=7003'],
    });

    // 1: shipped defaults — nothing above sets it.
    expect(config.retention.eventDays).toBe(30);
    expect(sources['retention.eventDays']?.layer).toBe('defaults');

    // 2: edition file — the work edition sets auth.mode over defaults' "subscription".
    expect(config.auth.mode).toBe('env');
    expect(sources['auth.mode']?.layer).toBe('edition');

    // 3: machine-local config.json.
    expect(config.logging.level).toBe('warn');
    expect(sources['logging.level']?.layer).toBe('machine');

    // 4: environment.
    expect(config.runner.queueLimit).toBe(11);
    expect(sources['runner.queueLimit']?.layer).toBe('env');

    // 5: CLI flags.
    expect(config.http.port).toBe(7003);
    expect(sources['http.port']?.layer).toBe('cli');
  });

  it('lets an environment variable override a machine-local value', () => {
    writeMachineConfig({ http: { port: 7001 } });
    const { config, sources } = load({ env: { AGENTMANAGER_HTTP_PORT: '7002' } });

    expect(config.http.port).toBe(7002);
    expect(sources['http.port']).toEqual({ layer: 'env', origin: 'env:AGENTMANAGER_HTTP_PORT' });
  });

  it('lets a CLI --set override an environment variable', () => {
    writeMachineConfig({ http: { port: 7001 } });
    const { config, sources } = load({
      env: { AGENTMANAGER_HTTP_PORT: '7002' },
      argv: ['--set', 'http.port=7003'],
    });

    expect(config.http.port).toBe(7003);
    expect(sources['http.port']).toEqual({ layer: 'cli', origin: 'cli:--set http.port=7003' });
  });

  it('replaces arrays across layers instead of concatenating them', () => {
    writeMachineConfig({ policy: { globalDeny: ['Bash(git push*)', 'Bash(rm*)'] } });
    expect(load().config.policy.globalDeny).toEqual(['Bash(git push*)', 'Bash(rm*)']);

    const overridden = load({ env: { AGENTMANAGER_POLICY_GLOBALDENY: '["Bash(curl*)"]' } });
    expect(overridden.config.policy.globalDeny).toEqual(['Bash(curl*)']);
  });

  it('merges objects key by key, leaving siblings from lower layers intact', () => {
    writeMachineConfig({ logging: { level: 'debug' } });
    const { config } = load();

    expect(config.logging).toEqual({
      level: 'debug',
      maxFileMB: 10,
      maxFiles: 10,
      retentionDays: 14,
    });
  });
});

describe('edition resolution (M2 acceptance: default edition and its warning)', () => {
  it('resolves to "work" with a warning when no config.json is present', () => {
    const { config, warnings, paths } = load();

    expect(config.edition).toBe('work');
    expect(paths.configFile).toBeNull();
    expect(warnings.map((warning) => warning.code)).toContain('edition-defaulted');
    expect(warnings.find((warning) => warning.code === 'edition-defaulted')?.message).toContain(
      'work',
    );
  });

  it('does not warn when an edition is configured', () => {
    writeMachineConfig({ edition: 'home' });
    const { config, warnings } = load();

    expect(config.edition).toBe('home');
    expect(warnings.map((warning) => warning.code)).not.toContain('edition-defaulted');
  });

  it('applies the work-edition deltas (DESIGN §2.2, §2.3)', () => {
    const { config } = load();

    expect(config.modules.remote.enabled).toBe(false);
    expect(config.http.bind).toBe('127.0.0.1');
    expect(config.auth.mode).toBe('env');
    expect(config.policy.allowPermissionElevation).toBe(false);
    expect(config.runner.maxConcurrent).toBe(1);
    expect(config.orchestrator.notify.enabled).toBe(false);
  });

  it('applies the home-edition deltas (DESIGN §2.2, §2.3)', () => {
    const { config } = load({ argv: ['--edition', 'home'] });

    expect(config.modules.remote.enabled).toBe(true);
    expect(config.remote.bind).toBe('tailscale');
    expect(config.auth.mode).toBe('subscription');
    expect(config.service.autostart).toBe(true);
    expect(config.orchestrator.notify.enabled).toBe(true);
  });

  it('takes the edition from AGENTMANAGER_EDITION', () => {
    expect(load({ env: { AGENTMANAGER_EDITION: 'home' } }).config.edition).toBe('home');
  });

  it('lets --edition override the edition in config.json', () => {
    writeMachineConfig({ edition: 'home' });
    const { config } = load({ argv: ['--edition', 'work'] });

    expect(config.edition).toBe('work');
    // The work edition file, not the home one, was the layer that applied.
    expect(config.auth.mode).toBe('env');
  });

  it('rejects an edition value that is not home or work', () => {
    writeMachineConfig({ edition: 'production' });
    const error = expectConfigError(() => load());

    expect(error.code).toBe('invalid-config');
    expect(error.issues.map((issue) => issue.key)).toContain('edition');
  });
});

describe('cross-key invariant (M2 acceptance: work + remote is rejected)', () => {
  it('rejects edition "work" combined with modules.remote.enabled true', () => {
    writeMachineConfig({ edition: 'work', modules: { remote: { enabled: true } } });
    const error = expectConfigError(() => load());

    expect(error.code).toBe('invalid-config');
    const issue = error.issues.find((candidate) => candidate.key === 'modules.remote.enabled');
    expect(issue?.message).toBe(WORK_EDITION_REMOTE_MESSAGE);
    expect(issue?.layer).toBe('machine');
  });

  it('rejects it however the two keys are set, including from the CLI', () => {
    const error = expectConfigError(() =>
      load({ argv: ['--edition', 'work', '--set', 'modules.remote.enabled=true'] }),
    );

    expect(error.report()).toContain(WORK_EDITION_REMOTE_MESSAGE);
  });

  it('allows the same combination in the home edition', () => {
    expect(load({ argv: ['--edition', 'home'] }).config.modules.remote.enabled).toBe(true);
  });
});

describe('fatal validation (M2 acceptance: malformed config.json, no partial start)', () => {
  it('refuses to start on a config.json that is not valid JSON', () => {
    writeMachineConfig('{ "http": { "port": 7477, } }');
    const error = expectConfigError(() => load());

    expect(error.code).toBe('unreadable-config');
    expect(error.exitCode).toBe(CONFIG_EXIT_CODE);
    expect(error.exitCode).not.toBe(0);
    expect(error.message).toContain('config.json');
  });

  it('reports one line per offending key, naming the layer that set it', () => {
    writeMachineConfig({
      http: { port: 'seven thousand' },
      logging: { level: 'chatty' },
      runner: { maxConcurrent: 0 },
    });
    const error = expectConfigError(() => load());

    expect(error.code).toBe('invalid-config');
    expect(error.exitCode).not.toBe(0);
    expect(error.issues.map((issue) => issue.key).sort()).toEqual([
      'http.port',
      'logging.level',
      'runner.maxConcurrent',
    ]);
    for (const issue of error.issues) {
      expect(issue.layer).toBe('machine');
      expect(issue.origin).toContain('config.json');
    }

    const report = error.report();
    expect(report).toContain('http.port');
    expect(report).toContain('logging.level');
    expect(report).toContain('runner.maxConcurrent');
    expect(report.split('\n')).toHaveLength(4); // headline + one line per key
  });

  it('rejects an unrecognised key by name rather than ignoring it', () => {
    writeMachineConfig({ htpp: { port: 7477 } });
    const error = expectConfigError(() => load());

    expect(error.issues).toEqual([
      expect.objectContaining({ key: 'htpp', message: 'Unrecognised configuration key.' }),
    ]);
  });

  it('rejects an unrecognised nested key set from the CLI', () => {
    const error = expectConfigError(() => load({ argv: ['--set', 'http.prot=7480'] }));

    expect(error.issues.map((issue) => issue.key)).toEqual(['http.prot']);
    expect(error.issues[0]?.layer).toBe('cli');
  });

  it('returns nothing at all when validation fails — there is no partial config', () => {
    writeMachineConfig({ http: { port: -1 } });
    let result: LoadedConfig | undefined;
    expect(() => {
      result = load();
    }).toThrow(ConfigError);
    expect(result).toBeUndefined();
  });
});

describe('immutability (M2 acceptance: the resolved config is frozen)', () => {
  it('freezes the config deeply, so mutation attempts throw', () => {
    const { config } = load();
    const mutable = config as unknown as {
      edition: string;
      http: { port: number };
      policy: { globalDeny: string[] };
    };

    expect(Object.isFrozen(config)).toBe(true);
    expect(() => {
      mutable.edition = 'home';
    }).toThrow(TypeError);
    expect(() => {
      mutable.http.port = 1;
    }).toThrow(TypeError);
    expect(() => {
      mutable.policy.globalDeny.push('Bash(rm*)');
    }).toThrow(TypeError);
  });

  it('freezes the source map too', () => {
    const { sources } = load();
    expect(Object.isFrozen(sources)).toBe(true);
  });
});

describe('roots and warnings', () => {
  it('locates config.json under the data root and reports the paths it used', () => {
    writeMachineConfig({ edition: 'home' });
    const { paths } = load();

    expect(paths.installRoot).toBe(installRoot);
    expect(paths.dataRoot).toBe(dataRoot);
    expect(paths.configFile).toBe(join(dataRoot, 'config', 'config.json'));
    expect(paths.editionFile).toBe(join(installRoot, 'config', 'edition.home.json'));
  });

  it('resolves AGENTMANAGER_HOME before layer 3, and reads config.json from there', () => {
    const alternate = join(base, 'elsewhere');
    mkdirSync(join(alternate, 'config'), { recursive: true });
    writeFileSync(
      join(alternate, 'config', 'config.json'),
      JSON.stringify({ http: { port: 7999 } }),
      'utf8',
    );

    const result = loadConfig({
      argv: [],
      env: { AGENTMANAGER_HOME: alternate },
      installRoot,
    });

    expect(result.paths.dataRoot).toBe(alternate);
    expect(result.config.http.port).toBe(7999);
    expect(result.config.dataRoot).toBe(alternate);
  });

  it('surfaces an unknown AGENTMANAGER_* variable as a warning rather than failing', () => {
    const { warnings } = load({ env: { AGENTMANAGER_HTTPP_PORT: '1' } });

    expect(warnings.map((warning) => warning.code)).toContain('unknown-env-var');
  });

  it('defaults the data root to %LOCALAPPDATA%\\AgentManager (DESIGN §1.2)', () => {
    const localAppData = join(base, 'local');
    mkdirSync(join(localAppData, 'AgentManager', 'config'), { recursive: true });

    const { paths } = loadConfig({ argv: [], env: { LOCALAPPDATA: localAppData }, installRoot });
    expect(paths.dataRoot).toBe(join(localAppData, 'AgentManager'));
  });

  it('warns when config.json sets a dataRoot other than the one it was found under', () => {
    const localAppData = join(base, 'local');
    const discovered = join(localAppData, 'AgentManager');
    mkdirSync(join(discovered, 'config'), { recursive: true });
    writeFileSync(
      join(discovered, 'config', 'config.json'),
      JSON.stringify({ dataRoot: join(base, 'somewhere-else') }),
      'utf8',
    );

    const { warnings, paths } = loadConfig({
      argv: [],
      env: { LOCALAPPDATA: localAppData },
      installRoot,
    });

    expect(paths.dataRoot).toBe(discovered);
    expect(warnings.map((warning) => warning.code)).toContain(
      'data-root-ignored-for-config-location',
    );
  });

  it('fails when the shipped defaults are missing, rather than inventing them', () => {
    rmSync(join(installRoot, 'config', 'defaults.json'));
    const error = expectConfigError(() => load());

    expect(error.code).toBe('unreadable-config');
    expect(error.message).toContain('defaults.json');
  });
});
