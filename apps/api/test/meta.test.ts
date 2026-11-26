import { createFakeClock } from '@tonnage/mock-api';
import { metaSchema } from '@tonnage/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, closeTestApps } from './helpers.ts';

afterEach(closeTestApps);

describe('GET /v1/meta', () => {
  it('is public and reports the minimum version and the injected clock', async () => {
    const clock = createFakeClock(Date.parse('2026-11-03T04:30:00Z'));
    const { app } = await buildTestApp({ clock });
    const res = await app.inject({ method: 'GET', url: '/v1/meta' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ minSupportedVersion: '1.0.0', serverTime: '2026-11-03T04:30:00.000Z', apiVersion: '0.2.0' });
    expect(metaSchema.safeParse(res.json()).success).toBe(true);
  });

  it('follows the clock', async () => {
    const clock = createFakeClock(Date.parse('2026-11-03T04:30:00Z'));
    const { app } = await buildTestApp({ clock });
    clock.advance(90_000);
    const res = await app.inject({ method: 'GET', url: '/v1/meta' });
    expect(res.json().serverTime).toBe('2026-11-03T04:31:30.000Z');
  });

  it('honours MIN_SUPPORTED_APP_VERSION', async () => {
    const { app } = await buildTestApp({ env: { MIN_SUPPORTED_APP_VERSION: '1.4.0' } });
    const res = await app.inject({ method: 'GET', url: '/v1/meta' });
    expect(res.json().minSupportedVersion).toBe('1.4.0');
  });

  it('echoes a supplied x-request-id and makes one up otherwise', async () => {
    const { app } = await buildTestApp();
    const given = await app.inject({ method: 'GET', url: '/v1/meta', headers: { 'x-request-id': 'abc-123' } });
    expect(given.headers['x-request-id']).toBe('abc-123');
    const made = await app.inject({ method: 'GET', url: '/v1/meta' });
    expect(made.headers['x-request-id']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});
