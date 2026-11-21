import { ERROR_MESSAGES } from '@tonnage/shared';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, inject, it } from 'vitest';
import { z } from 'zod';
import { createDb } from '../src/db/client.ts';
import { AppError } from '../src/http/errors.ts';
import { buildApp } from '../src/server.ts';
import { buildTestApp, closeTestApps, testEnv } from './helpers.ts';
import { createFakeClock } from '@tonnage/mock-api';

afterEach(closeTestApps);

async function appWithThrowawayRoutes() {
  const t = await buildTestApp();
  t.app.post('/v1/_t/body', { schema: { body: z.object({ mobile: z.string().regex(/^\d{10}$/) }) } }, async () => ({
    ok: true,
  }));
  t.app.get('/v1/_t/missing', async () => {
    throw new AppError(404, 'NOT_FOUND');
  });
  t.app.get('/v1/_t/boom', async () => {
    throw new Error('secret internals');
  });
  await t.app.ready();
  return t.app;
}

describe('error contract', () => {
  it('maps a zod body failure to 422 VALIDATION with paths', async () => {
    const app = await appWithThrowawayRoutes();
    const res = await app.inject({ method: 'POST', url: '/v1/_t/body', payload: { mobile: 'x' } });
    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body).toEqual({
      code: 'VALIDATION',
      message: ERROR_MESSAGES.VALIDATION,
      details: [{ path: ['mobile'], message: expect.any(String) }],
    });
  });

  it('keeps numeric path segments numeric', async () => {
    const t = await buildTestApp();
    t.app.post('/v1/_t/list', { schema: { body: z.object({ items: z.array(z.number()) }) } }, async () => ({}));
    await t.app.ready();
    const res = await t.app.inject({ method: 'POST', url: '/v1/_t/list', payload: { items: [1, 'x'] } });
    expect(res.json().details[0].path).toEqual(['items', 1]);
  });

  it('sends an AppError as exactly code and message', async () => {
    const app = await appWithThrowawayRoutes();
    const res = await app.inject({ method: 'GET', url: '/v1/_t/missing' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ code: 'NOT_FOUND', message: ERROR_MESSAGES.NOT_FOUND });
    expect(Object.keys(res.json()).sort()).toEqual(['code', 'message']);
  });

  it('sends a plain Error as 500 INTERNAL without a stack, and logs it with the request id', async () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _enc, cb) {
        lines.push(String(chunk));
        cb();
      },
    });
    const { db, close } = createDb(inject('appDatabaseUrl'));
    const app = await buildApp({
      env: testEnv({ LOG_LEVEL: 'info' }),
      db,
      clock: createFakeClock(0),
      logStream: stream,
    });
    app.get('/v1/_t/boom', async () => {
      throw new Error('secret internals');
    });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/v1/_t/boom', headers: { 'x-request-id': 'req-77' } });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ code: 'INTERNAL', message: 'Something went wrong' });
    expect(res.body).not.toContain('secret internals');
    expect(res.body).not.toContain('stack');

    const errorLog = lines.map((l) => JSON.parse(l)).find((l) => l.level === 50);
    expect(errorLog).toBeDefined();
    expect(errorLog.reqId).toBe('req-77');
    expect(errorLog.err.message).toBe('secret internals');
    await app.close();
    await close();
  });

  it('maps a 4xx error thrown by a plugin (not ours, not Fastify’s) by status, never to 500', async () => {
    const t = await buildTestApp();
    const cases: [number, number, string][] = [
      [429, 429, 'RATE_LIMITED'],
      [401, 401, 'UNAUTHENTICATED'],
      [403, 403, 'FORBIDDEN'],
      [404, 404, 'NOT_FOUND'],
      [400, 422, 'VALIDATION'],
      [413, 422, 'VALIDATION'],
    ];
    for (const [thrown] of cases) {
      t.app.get(`/v1/_t/status-${thrown}`, async () => {
        throw Object.assign(new Error(`plugin said ${thrown}`), { statusCode: thrown });
      });
    }
    await t.app.ready();
    for (const [thrown, status, code] of cases) {
      const res = await t.app.inject({ method: 'GET', url: `/v1/_t/status-${thrown}` });
      expect(res.statusCode).toBe(status);
      expect(res.json()).toMatchObject({ code, message: ERROR_MESSAGES[code as keyof typeof ERROR_MESSAGES] });
      expect(res.body).not.toContain('plugin said');
    }
  });

  it('answers an unknown route with 404 NOT_FOUND', async () => {
    const app = await appWithThrowawayRoutes();
    const res = await app.inject({ method: 'GET', url: '/v1/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ code: 'NOT_FOUND', message: ERROR_MESSAGES.NOT_FOUND });
  });

  it('answers malformed JSON with 422 VALIDATION', async () => {
    const app = await appWithThrowawayRoutes();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/_t/body',
      headers: { 'content-type': 'application/json' },
      payload: '{"mobile": ',
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: 'VALIDATION', message: ERROR_MESSAGES.VALIDATION });
  });

  it('redacts authorization, code and refreshToken from logs', async () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _enc, cb) {
        lines.push(String(chunk));
        cb();
      },
    });
    const { db, close } = createDb(inject('appDatabaseUrl'));
    const app = await buildApp({ env: testEnv({ LOG_LEVEL: 'info' }), db, clock: createFakeClock(0), logStream: stream });
    app.post('/v1/_t/log', async (req) => {
      req.log.info({ body: req.body, headers: req.headers }, 'received');
      return {};
    });
    await app.ready();
    await app.inject({
      method: 'POST',
      url: '/v1/_t/log',
      headers: { authorization: 'Bearer SECRET-TOKEN' },
      payload: { code: '654321', refreshToken: 'REFRESH-SECRET' },
    });
    const all = lines.join('');
    expect(all).not.toContain('SECRET-TOKEN');
    expect(all).not.toContain('654321');
    expect(all).not.toContain('REFRESH-SECRET');
    await app.close();
    await close();
  });
});
