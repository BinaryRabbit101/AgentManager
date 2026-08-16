import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { ConfigSchemaRegistry } from './registry.js';
import {
  WORK_EDITION_REMOTE_MESSAGE,
  createFoundationRegistry,
  foundationConfigShape,
} from './schema.js';

describe('ConfigSchemaRegistry', () => {
  it('composes defaults from every registered namespace', () => {
    const registry = new ConfigSchemaRegistry()
      .register({
        namespace: 'alpha',
        schema: z.strictObject({ size: z.number() }),
        defaults: { size: 1 },
        owner: 'alpha',
      })
      .register({
        namespace: 'beta',
        schema: z.strictObject({ on: z.boolean() }),
        defaults: { on: false },
        owner: 'beta',
      });

    expect(registry.composeDefaults()).toEqual({ alpha: { size: 1 }, beta: { on: false } });
  });

  it('validates against the composed schema, rejecting unknown namespaces', () => {
    const registry = new ConfigSchemaRegistry().register({
      namespace: 'alpha',
      schema: z.strictObject({ size: z.number() }),
      defaults: { size: 1 },
      owner: 'alpha',
    });
    const schema = registry.composeSchema();

    expect(schema.safeParse({ alpha: { size: 2 } }).success).toBe(true);
    expect(schema.safeParse({ alpha: { size: 2 }, gamma: {} }).success).toBe(false);
  });

  it('is the seam a module uses: registering a namespace extends the one schema', () => {
    // Stands in for a feature module contributing its own sub-schema and
    // defaults (DESIGN §2.1) — the loader is not edited to accept it.
    const registry = createFoundationRegistry().register({
      namespace: 'roster',
      schema: z.strictObject({ seedOnFirstRun: z.boolean() }),
      defaults: { seedOnFirstRun: true },
      owner: 'roster',
    });

    expect(registry.composeDefaults()['roster']).toEqual({ seedOnFirstRun: true });
    const parsed = registry
      .composeSchema()
      .safeParse({ ...registry.composeDefaults(), roster: { seedOnFirstRun: false } });
    expect(parsed.success).toBe(true);
  });

  it('refuses two modules claiming the same namespace', () => {
    const registry = new ConfigSchemaRegistry().register({
      namespace: 'alpha',
      schema: z.strictObject({}),
      defaults: {},
      owner: 'first',
    });
    expect(() =>
      registry.register({
        namespace: 'alpha',
        schema: z.strictObject({}),
        defaults: {},
        owner: 'second',
      }),
    ).toThrow(/already registered by "first"/);
  });

  it('runs registered invariants as part of validation', () => {
    const registry = new ConfigSchemaRegistry()
      .register({
        namespace: 'alpha',
        schema: z.strictObject({ size: z.number() }),
        defaults: { size: 1 },
        owner: 'alpha',
      })
      .registerInvariant({
        id: 'alpha-must-be-small',
        check: (config) => {
          const alpha = config['alpha'] as { size: number };
          return alpha.size > 10 ? [{ path: ['alpha', 'size'], message: 'too big' }] : [];
        },
      });

    const parsed = registry.composeSchema().safeParse({ alpha: { size: 11 } });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path).toEqual(['alpha', 'size']);
    expect(parsed.error?.issues[0]?.message).toBe('too big');
  });

  it('refuses a duplicate invariant id', () => {
    const registry = createFoundationRegistry();
    expect(() =>
      registry.registerInvariant({ id: 'work-edition-forbids-remote', check: () => [] }),
    ).toThrow(/already registered/);
  });
});

describe('createFoundationRegistry', () => {
  it('registers exactly the v1 key inventory of DESIGN §2.3', () => {
    expect(
      createFoundationRegistry()
        .contributions.map((c) => c.namespace)
        .sort(),
    ).toEqual(Object.keys(foundationConfigShape).sort());
  });

  it('attributes the orchestrator namespace to the orchestrator element', () => {
    const contribution = createFoundationRegistry().contributions.find(
      (c) => c.namespace === 'orchestrator',
    );
    expect(contribution?.owner).toBe('orchestrator');
  });

  it('carries the work-edition remote invariant', () => {
    expect(createFoundationRegistry().invariants.map((i) => i.id)).toContain(
      'work-edition-forbids-remote',
    );
    expect(WORK_EDITION_REMOTE_MESSAGE).toContain('modules.remote.enabled');
  });
});
