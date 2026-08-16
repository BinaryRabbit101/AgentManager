import { describe, expect, it } from 'vitest';

import { ConfigError } from './errors.js';
import {
  buildEnvLayer,
  parseCliArgs,
  parseScalarValue,
  resolveEnvKeyPath,
  readJsonLayer,
} from './layers.js';
import { mergePatches } from './merge.js';
import { createFoundationRegistry } from './schema.js';

const keyTree = createFoundationRegistry().composeDefaults();

describe('parseScalarValue', () => {
  it('parses values that are valid JSON', () => {
    expect(parseScalarValue('7480')).toBe(7480);
    expect(parseScalarValue('true')).toBe(true);
    expect(parseScalarValue('null')).toBeNull();
    expect(parseScalarValue('["a","b"]')).toEqual(['a', 'b']);
  });

  it('keeps everything else as a string', () => {
    expect(parseScalarValue('127.0.0.1')).toBe('127.0.0.1');
    expect(parseScalarValue('tailscale')).toBe('tailscale');
    expect(parseScalarValue('C:\\Users\\me\\projects')).toBe('C:\\Users\\me\\projects');
  });
});

describe('parseCliArgs', () => {
  it('parses --set in both spellings', () => {
    const spaced = mergePatches(parseCliArgs(['--set', 'http.port=7480']).patches);
    const inline = mergePatches(parseCliArgs(['--set=http.port=7480']).patches);
    expect(spaced.value).toEqual({ http: { port: 7480 } });
    expect(inline.value).toEqual({ http: { port: 7480 } });
  });

  it('parses --edition and --data-root, exposing both before the merge', () => {
    const parsed = parseCliArgs(['--edition', 'home', '--data-root', 'D:\\am']);
    expect(parsed.edition).toBe('home');
    expect(parsed.dataRoot).toBe('D:\\am');
    expect(mergePatches(parsed.patches).value).toEqual({ edition: 'home', dataRoot: 'D:\\am' });
  });

  it('gives each flag its own source, so a key names the flag that set it', () => {
    const merged = mergePatches(
      parseCliArgs(['--set', 'http.port=7480', '--edition=home']).patches,
    );
    expect(merged.sources.get('http.port')?.origin).toBe('cli:--set http.port=7480');
    expect(merged.sources.get('edition')?.origin).toBe('cli:--edition home');
  });

  it('ignores arguments the loader does not own', () => {
    expect(parseCliArgs(['--version', '--help', 'extra']).patches).toEqual([]);
  });

  it('rejects a --set without an assignment', () => {
    expect(() => parseCliArgs(['--set', 'http.port'])).toThrow(ConfigError);
  });

  it('rejects a flag given without a value', () => {
    expect(() => parseCliArgs(['--edition'])).toThrow(ConfigError);
    expect(() => parseCliArgs(['--data-root', '--set=a=1'])).toThrow(ConfigError);
  });
});

describe('resolveEnvKeyPath', () => {
  it('matches case- and underscore-insensitively (DESIGN §2.1 examples)', () => {
    expect(resolveEnvKeyPath(keyTree, ['HTTP', 'PORT'])).toEqual([['http', 'port']]);
    expect(resolveEnvKeyPath(keyTree, ['RUNNER', 'MAXCONCURRENT'])).toEqual([
      ['runner', 'maxConcurrent'],
    ]);
    expect(resolveEnvKeyPath(keyTree, ['MODULES', 'REMOTE', 'ENABLED'])).toEqual([
      ['modules', 'remote', 'enabled'],
    ]);
  });

  it('matches a key whose own name contains underscores', () => {
    expect(
      resolveEnvKeyPath(keyTree, ['AGENTENV', 'CLAUDE', 'CODE', 'DISABLE', 'AUTO', 'MEMORY']),
    ).toEqual([['agentEnv', 'CLAUDE_CODE_DISABLE_AUTO_MEMORY']]);
  });

  it('returns nothing for a name that matches no key', () => {
    expect(resolveEnvKeyPath(keyTree, ['NOPE'])).toEqual([]);
    expect(resolveEnvKeyPath(keyTree, ['HTTP', 'NOPE'])).toEqual([]);
  });
});

describe('buildEnvLayer', () => {
  it('reads AGENTMANAGER_* variables into typed values', () => {
    const layer = buildEnvLayer(
      {
        AGENTMANAGER_HTTP_PORT: '7480',
        AGENTMANAGER_HTTP_BIND: '127.0.0.1',
        AGENTMANAGER_MODULES_REMOTE_ENABLED: 'true',
        PATH: 'ignored',
      },
      keyTree,
    );
    expect(mergePatches(layer.patches).value).toEqual({
      http: { port: 7480, bind: '127.0.0.1' },
      modules: { remote: { enabled: true } },
    });
    expect(layer.warnings).toEqual([]);
  });

  it('treats AGENTMANAGER_HOME as the data root (DESIGN §1.2)', () => {
    const layer = buildEnvLayer({ AGENTMANAGER_HOME: 'D:\\am' }, keyTree);
    expect(layer.dataRoot).toBe('D:\\am');
    expect(mergePatches(layer.patches).value).toEqual({ dataRoot: 'D:\\am' });
  });

  it('lets AGENTMANAGER_HOME win over AGENTMANAGER_DATAROOT and says so', () => {
    const layer = buildEnvLayer(
      { AGENTMANAGER_HOME: 'D:\\home', AGENTMANAGER_DATAROOT: 'D:\\other' },
      keyTree,
    );
    expect(layer.dataRoot).toBe('D:\\home');
    expect(mergePatches(layer.patches).value).toEqual({ dataRoot: 'D:\\home' });
    expect(layer.warnings.map((warning) => warning.code)).toEqual(['data-root-conflict']);
  });

  it('exposes AGENTMANAGER_EDITION before the merge', () => {
    expect(buildEnvLayer({ AGENTMANAGER_EDITION: 'home' }, keyTree).edition).toBe('home');
  });

  it('warns about an unrecognised variable instead of failing', () => {
    const layer = buildEnvLayer({ AGENTMANAGER_NOT_A_KEY: '1' }, keyTree);
    expect(layer.patches).toEqual([]);
    expect(layer.warnings[0]?.code).toBe('unknown-env-var');
    expect(layer.warnings[0]?.key).toBe('AGENTMANAGER_NOT_A_KEY');
  });

  it('names the environment variable as the source of each key', () => {
    const merged = mergePatches(buildEnvLayer({ AGENTMANAGER_HTTP_PORT: '7480' }, keyTree).patches);
    expect(merged.sources.get('http.port')).toEqual({
      layer: 'env',
      origin: 'env:AGENTMANAGER_HTTP_PORT',
    });
  });
});

describe('readJsonLayer', () => {
  it('returns undefined for a file that does not exist', () => {
    expect(readJsonLayer('./definitely-not-here-config.json')).toBeUndefined();
  });
});
