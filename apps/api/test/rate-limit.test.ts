import { ERROR_MESSAGES } from '@tonnage/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, closeTestApps } from './helpers.ts';

afterEach(closeTestApps);

describe('rate limit on /v1/auth/*', () => {
  it('the 11th request in a minute from one address → 429 RATE_LIMITED in the contract shape', async () => {
    const t = await buildTestApp({ env: { RATE_LIMIT: 'on' } });
    await t.reset();
    // Different (unknown) numbers, so no request is refused for any other reason.
    for (let i = 0; i < 10; i++) {
      const res = await t.app.inject({
        method: 'POST',
        url: '/v1/auth/request-code',
        payload: { mobile: `98000000${String(i).padStart(2, '0')}` },
      });
      expect(res.statusCode).toBe(200);
    }
    const res = await t.app.inject({
      method: 'POST',
      url: '/v1/auth/request-code',
      payload: { mobile: '9800000099' },
    });
    expect(res.statusCode).toBe(429);
    expect(res.json()).toEqual({ code: 'RATE_LIMITED', message: ERROR_MESSAGES.RATE_LIMITED });

    // Only auth is limited.
    const meta = await t.app.inject({ method: 'GET', url: '/v1/meta' });
    expect(meta.statusCode).toBe(200);
  });

  it('is off when RATE_LIMIT=off', async () => {
    const t = await buildTestApp({ env: { RATE_LIMIT: 'off' } });
    await t.reset();
    for (let i = 0; i < 11; i++) {
      const res = await t.app.inject({
        method: 'POST',
        url: '/v1/auth/request-code',
        payload: { mobile: `98000001${String(i).padStart(2, '0')}` },
      });
      expect(res.statusCode).toBe(200);
    }
  });
});
