import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

describe('API-selected Fastify header and schema contracts', () => {
  it.each(['enum', 'const'])('normalizes canonical-case header propertyNames %s', async (kind) => {
    // GHSA-389g-gv7q-r4x8; inject is in-process, with no network listener.
    const app = Fastify();
    let calls = 0;
    app.get(
      '/fixture',
      {
        schema: {
          headers: {
            type: 'object',
            propertyNames: {
              not: { [kind]: kind === 'enum' ? ['X-Debug-Override'] : 'X-Debug-Override' },
            },
          },
        },
      },
      async () => {
        calls++;
        return { ok: true };
      },
    );
    try {
      expect((await app.inject({ method: 'GET', url: '/fixture' })).statusCode).toBe(200);
      expect(calls).toBe(1);
      expect(
        (
          await app.inject({
            method: 'GET',
            url: '/fixture',
            headers: { 'X-Debug-Override': 'synthetic' },
          })
        ).statusCode,
      ).toBe(400);
      expect(calls).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('retains validation and serialization of supplied local schema references', async () => {
    // Covers real parent use under the inherited fast-uri3 vs ^4 range exception.
    const app = Fastify();
    let calls = 0;
    app.addSchema({
      $id: 'https://fixture.invalid/schema/value.json',
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    });
    app.post(
      '/fixture',
      {
        schema: {
          body: { $ref: 'https://fixture.invalid/schema/value.json' },
          response: { 200: { $ref: 'https://fixture.invalid/schema/value.json' } },
        },
      },
      async (request) => {
        calls++;
        return request.body;
      },
    );
    try {
      const valid = await app.inject({
        method: 'POST',
        url: '/fixture',
        payload: { name: 'synthetic', extra: 'omit' },
      });
      expect(valid.statusCode).toBe(200);
      expect(valid.json()).toEqual({ name: 'synthetic' });
      const invalid = await app.inject({
        method: 'POST',
        url: '/fixture',
        payload: { name: { invalid: true } },
      });
      expect(invalid.statusCode).toBe(400);
      expect(calls).toBe(1);
    } finally {
      await app.close();
    }
  });
});
