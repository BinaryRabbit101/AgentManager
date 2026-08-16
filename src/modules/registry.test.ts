/**
 * The service registry and the route table (DESIGN §6.1, §6.4).
 *
 * Together these are how modules reach each other without importing each other,
 * and how M8 learns what to mount.
 */
import { describe, expect, it } from 'vitest';

import { ModuleConflictError } from './errors.js';
import { ServiceRegistry } from './registry.js';
import { RouteTable } from './routes.js';
import type { RouteDefinition } from './types.js';

const handler = (): void => {};

function route(path: string, extra: Partial<RouteDefinition> = {}): RouteDefinition {
  return { method: 'GET', path, handler, ...extra };
}

describe('ServiceRegistry', () => {
  it('publishes an api under a name and hands it back', () => {
    const registry = new ServiceRegistry();
    registry.provide('remote', 'remote', { boundAddress: () => null });

    const remote = registry.require<{ boundAddress: () => null }>('remote');
    expect(remote?.boundAddress()).toBeNull();
    expect(registry.has('remote')).toBe(true);
    expect(registry.names()).toEqual(['remote']);
  });

  it('returns undefined for an absent capability, which is the edition gate', () => {
    // §6.2: "any code that would want to ask 'are we home edition?' instead
    // asks whether a capability is present (`ctx.require('remote')` returns
    // undefined)".
    const registry = new ServiceRegistry();
    expect(registry.require('remote')).toBeUndefined();
    expect(registry.has('remote')).toBe(false);
  });

  it('refuses a second provider of the same name, naming the first', () => {
    const registry = new ServiceRegistry();
    registry.provide('storage', 'storage', {});
    expect(() => registry.provide('roster', 'storage', {})).toThrow(ModuleConflictError);
    expect(() => registry.provide('roster', 'storage', {})).toThrow(/already provided by/);
  });
});

describe('RouteTable', () => {
  it('defaults the remote policy to allow', () => {
    // §6.4: "`registerRoutes` accepts optional metadata per route,
    // `{ remote: 'allow' | 'deny' }`, **defaulting to `allow`**."
    const table = new RouteTable();
    table.add('foundation', route('/api/health'));
    expect(table.routes[0]?.remote).toBe('allow');
  });

  it('records a deny at the point of registration', () => {
    const table = new RouteTable();
    table.add('foundation', [
      route('/api/health'),
      route('/api/service/shutdown', { method: 'POST', remote: 'deny' }),
    ]);

    expect(table.deniedRemotely().map((r) => r.path)).toEqual(['/api/service/shutdown']);
  });

  it('accepts a single route, an array, or any object with a routes array', () => {
    const table = new RouteTable();
    table.add('a', route('/one'));
    table.add('b', [route('/two'), route('/three')]);
    table.add('c', { routes: [route('/four')] });

    expect(table.size).toBe(4);
    expect(table.byModule('b').map((r) => r.path)).toEqual(['/two', '/three']);
    expect(table.find('GET', '/four')?.moduleId).toBe('c');
  });

  it('refuses two registrations of the same method and path', () => {
    const table = new RouteTable();
    table.add('foundation', route('/api/health'));
    expect(() => table.add('roster', route('/api/health'))).toThrow(ModuleConflictError);
    expect(table.size).toBe(1);
  });

  it('keeps registration order, which is module topological order', () => {
    const table = new RouteTable();
    table.add('storage', route('/a'));
    table.add('http', route('/b'));
    expect(table.routes.map((r) => r.path)).toEqual(['/a', '/b']);
  });
});
