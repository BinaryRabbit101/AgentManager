import { describe, expect, it } from 'vitest';

import { deepFreeze, isPlainObject, mergePatches, setAtPath } from './merge.js';
import type { ConfigPatch } from './types.js';

function patch(values: Record<string, unknown>, origin: string): ConfigPatch {
  return { values, source: { layer: 'machine', origin } };
}

describe('isPlainObject', () => {
  it('accepts plain data objects only', () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject(Object.create(null) as object)).toBe(true);
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject(null)).toBe(false);
    expect(isPlainObject(new Date())).toBe(false);
    expect(isPlainObject('x')).toBe(false);
  });
});

describe('mergePatches', () => {
  it('merges objects key by key rather than replacing them', () => {
    const merged = mergePatches([
      patch({ http: { bind: '127.0.0.1', port: 7477 } }, 'a'),
      patch({ http: { port: 7480 } }, 'b'),
    ]);
    expect(merged.value).toEqual({ http: { bind: '127.0.0.1', port: 7480 } });
  });

  it('replaces arrays instead of concatenating them (DESIGN §2.1)', () => {
    const merged = mergePatches([
      patch({ policy: { globalDeny: ['Bash(git push*)', 'Bash(rm*)'] } }, 'a'),
      patch({ policy: { globalDeny: ['Bash(curl*)'] } }, 'b'),
    ]);
    expect(merged.value).toEqual({ policy: { globalDeny: ['Bash(curl*)'] } });
  });

  it('replaces an array with an empty array, so a higher layer can clear one', () => {
    const merged = mergePatches([
      patch({ policy: { globalDeny: ['Bash(rm*)'] } }, 'a'),
      patch({ policy: { globalDeny: [] } }, 'b'),
    ]);
    expect(merged.value).toEqual({ policy: { globalDeny: [] } });
  });

  it('tracks the winning source of every leaf key', () => {
    const merged = mergePatches([
      patch({ http: { bind: '127.0.0.1', port: 7477 } }, 'defaults'),
      patch({ http: { port: 7480 } }, 'override'),
    ]);
    expect(merged.sources.get('http.bind')?.origin).toBe('defaults');
    expect(merged.sources.get('http.port')?.origin).toBe('override');
  });

  it('records leaves inside a subtree a layer introduces wholesale', () => {
    const merged = mergePatches([patch({ a: { b: { c: 1 } } }, 'one')]);
    expect([...merged.sources.keys()]).toEqual(['a.b.c']);
  });

  it('drops attribution beneath a subtree that a later layer replaces with a scalar', () => {
    const merged = mergePatches([
      patch({ library: { root: null, watch: true } }, 'one'),
      patch({ library: null }, 'two'),
    ]);
    expect(merged.value).toEqual({ library: null });
    expect([...merged.sources.keys()]).toEqual(['library']);
    expect(merged.sources.get('library')?.origin).toBe('two');
  });

  it('does not mutate the patches it is given', () => {
    const first = { http: { port: 7477 } };
    mergePatches([patch(first, 'one'), patch({ http: { port: 7480 } }, 'two')]);
    expect(first.http.port).toBe(7477);
  });

  it('ignores __proto__ so a config file cannot pollute the prototype chain', () => {
    const merged = mergePatches([
      patch(JSON.parse('{"__proto__":{"polluted":true}}') as Record<string, unknown>, 'evil'),
    ]);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(Object.keys(merged.value)).toEqual([]);
  });
});

describe('setAtPath', () => {
  it('creates the intermediate objects for a dotted path', () => {
    const target: Record<string, unknown> = {};
    setAtPath(target, 'modules.remote.enabled', true);
    expect(target).toEqual({ modules: { remote: { enabled: true } } });
  });

  it('replaces a non-object standing in the way of the path', () => {
    const target: Record<string, unknown> = { http: 'nonsense' };
    setAtPath(target, 'http.port', 7480);
    expect(target).toEqual({ http: { port: 7480 } });
  });
});

describe('deepFreeze', () => {
  it('freezes nested objects and arrays', () => {
    const value = deepFreeze({ nested: { list: ['a'] } });
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.nested)).toBe(true);
    expect(Object.isFrozen(value.nested.list)).toBe(true);
  });
});
