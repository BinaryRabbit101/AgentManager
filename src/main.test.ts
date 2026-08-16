import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { PROGRAM_NAME, parseArgs, readVersion, run, type RunIo } from './main.js';

const packageVersion = (
  JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as {
    version: string;
  }
).version;

function capture(): RunIo & { out: (line: string) => void; lines: string[]; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    lines,
    errors,
    out: (line) => void lines.push(line),
    err: (line) => void errors.push(line),
  };
}

describe('parseArgs', () => {
  it('recognises the version flag in both spellings', () => {
    expect(parseArgs(['--version']).version).toBe(true);
    expect(parseArgs(['-v']).version).toBe(true);
  });

  it('recognises the help flag in both spellings', () => {
    expect(parseArgs(['--help']).help).toBe(true);
    expect(parseArgs(['-h']).help).toBe(true);
  });

  it('collects arguments this milestone does not understand', () => {
    expect(parseArgs(['--edition', 'work']).unknown).toEqual(['--edition', 'work']);
  });

  it('treats an empty argument list as no flags', () => {
    expect(parseArgs([])).toEqual({ version: false, help: false, unknown: [] });
  });
});

describe('readVersion', () => {
  it('returns the version declared in package.json', () => {
    expect(readVersion()).toBe(packageVersion);
  });
});

describe('run', () => {
  it('prints just the version and exits 0 for --version', () => {
    const io = capture();
    expect(run(['--version'], io)).toBe(0);
    expect(io.lines).toEqual([packageVersion]);
    expect(io.errors).toEqual([]);
  });

  it('prints usage and exits 0 for --help', () => {
    const io = capture();
    expect(run(['--help'], io)).toBe(0);
    expect(io.lines.join('\n')).toContain('Usage:');
  });

  it('exits 0 with a banner when given no arguments', () => {
    const io = capture();
    expect(run([], io)).toBe(0);
    expect(io.lines.join('\n')).toContain(PROGRAM_NAME);
  });

  it('rejects unknown arguments with exit code 2', () => {
    const io = capture();
    expect(run(['--nope'], io)).toBe(2);
    expect(io.errors.join('\n')).toContain('--nope');
  });
});
