import { afterEach, describe, expect, it, vi } from 'vitest';
import { SAMPLE_WORLD } from '@tonnage/shared';
import { createFakeClock } from './clock.ts';
import { createMemoryStorage, seedState } from './store.ts';
import { createMockApi } from './index.ts';

const START = Date.UTC(2026, 10, 3, 4, 30);
const owner = SAMPLE_WORLD.ids.users.rajesh;
const device = '019a4c00-00ff-7000-8000-000000000001';
const KEY = 'tonnage.mockState';

afterEach(() => {
  vi.useRealTimers();
});

describe('store', () => {
  it('seeds SAMPLE_WORLD: 4 companies, 4 plants, 8 users', () => {
    const s = seedState(createFakeClock(START));
    expect(s.tenants).toHaveLength(1);
    expect(s.companies).toHaveLength(4);
    expect(s.plants).toHaveLength(4);
    expect(s.users).toHaveLength(8);
    expect(s.users.every((u) => u.tenantId === SAMPLE_WORLD.tenant.id)).toBe(true);
    expect(s.users.find((u) => u.id === SAMPLE_WORLD.ids.users.deepak)?.lastSeenAt).toBeNull();
    // seeding copies: mutating state never touches the fixture
    s.users[3]?.plantIds.push('x');
    expect(SAMPLE_WORLD.users[3]?.plantIds).toHaveLength(1);
  });

  it('persists after a mutating request and restores on next createMockApi with the same storage', async () => {
    vi.useFakeTimers();
    const storage = createMemoryStorage();
    const clock = createFakeClock(START);
    const a = await createMockApi({ storage, clock });
    const pair = await a.controls.signInAs(owner, device);
    const res = await a.transport.request({
      method: 'POST',
      path: '/v1/plants',
      headers: { authorization: `Bearer ${pair.accessToken}`, 'idempotency-key': 'k1' },
      body: {
        companyId: SAMPLE_WORLD.ids.companies.AIP,
        name: 'Mandir Hasaud',
        location: 'Raipur',
      },
    });
    expect(res.status).toBe(201);
    expect(await storage.getItem(KEY)).toBeNull(); // debounced
    await vi.advanceTimersByTimeAsync(250);
    expect(await storage.getItem(KEY)).not.toBeNull();

    const b = await createMockApi({ storage, clock });
    const list = await b.transport.request({
      method: 'GET',
      path: `/v1/plants?companyId=${SAMPLE_WORLD.ids.companies.AIP}`,
      headers: { authorization: `Bearer ${pair.accessToken}` }, // sessions survive restarts too
    });
    expect(list.status).toBe(200);
    expect((list.body as { name: string }[]).map((p) => p.name)).toEqual([
      'Siltara',
      'Mandir Hasaud',
    ]);
  });

  it('state changed by a request that fails (OTP lockout, refresh-reuse revocation) survives a restart', async () => {
    vi.useFakeTimers();
    const storage = createMemoryStorage();
    const clock = createFakeClock(START);
    const a = await createMockApi({ storage, clock });
    const post = (api: typeof a, path: string, body: unknown) =>
      api.transport.request({ method: 'POST', path, headers: {}, body });

    // Lock Priya's number with five wrong codes (the 5th is a 429).
    const priya = '+919826100013';
    await post(a, '/v1/auth/request-code', { mobile: priya });
    for (let i = 0; i < 5; i++) {
      await post(a, '/v1/auth/verify', { mobile: priya, code: '000000', deviceId: device });
    }
    // Reuse Rajesh's rotated refresh token after the grace window: a 401 that revokes every token.
    const pair = await a.controls.signInAs(owner, device);
    const rotated = await post(a, '/v1/auth/refresh', {
      refreshToken: pair.refreshToken,
      deviceId: device,
    });
    expect(rotated.status).toBe(200);
    clock.advance(31_000);
    const reuse = await post(a, '/v1/auth/refresh', {
      refreshToken: pair.refreshToken,
      deviceId: device,
    });
    expect(reuse.status).toBe(401);
    await vi.advanceTimersByTimeAsync(250);

    const b = await createMockApi({ storage, clock });
    const locked = await post(b, '/v1/auth/verify', {
      mobile: priya,
      code: '123456',
      deviceId: device,
    });
    expect([locked.status, (locked.body as { code: string }).code]).toEqual([429, 'OTP_LOCKED']);
    const newer = (rotated.body as { refreshToken: string }).refreshToken;
    const revoked = await post(b, '/v1/auth/refresh', { refreshToken: newer, deviceId: device });
    expect(revoked.status).toBe(401);
  });

  it('settings activity records only the keys that actually changed', async () => {
    vi.useFakeTimers();
    const storage = createMemoryStorage();
    const api = await createMockApi({ storage, clock: createFakeClock(START) });
    const pair = await api.controls.signInAs(owner, device);
    const res = await api.transport.request({
      method: 'PATCH',
      path: '/v1/settings',
      headers: { authorization: `Bearer ${pair.accessToken}` },
      // 500 changes; agedOrderDays 10 is the current value; `bogus` is not a setting.
      body: { completionToleranceKg: 500, agedOrderDays: 10, bogus: true },
    });
    expect(res.status).toBe(200);
    await vi.advanceTimersByTimeAsync(250);
    const snapshot = JSON.parse((await storage.getItem(KEY)) ?? '{}') as {
      activity: { action: string; meta: { keys: string[] } }[];
    };
    const entry = snapshot.activity.find((x) => x.action === 'settings.updated');
    expect(entry?.meta).toEqual({ keys: ['completionToleranceKg'] });
  });

  it('GET requests do not persist', async () => {
    vi.useFakeTimers();
    const storage = createMemoryStorage();
    const a = await createMockApi({ storage, clock: createFakeClock(START) });
    await a.transport.request({ method: 'GET', path: '/v1/meta', headers: {} });
    await vi.advanceTimersByTimeAsync(1000);
    expect(await storage.getItem(KEY)).toBeNull();
  });

  it('reset() restores the seed and clears sessions', async () => {
    const storage = createMemoryStorage();
    const api = await createMockApi({ storage, clock: createFakeClock(START) });
    const pair = await api.controls.signInAs(owner, device);
    const auth = { authorization: `Bearer ${pair.accessToken}` };
    const created = await api.transport.request({
      method: 'POST',
      path: '/v1/companies',
      headers: { ...auth, 'idempotency-key': 'k1' },
      body: { code: 'NEW', name: 'New Co', gstin: null, orderPrefix: 'SO-NEW' },
    });
    expect(created.status).toBe(201);
    await api.controls.reset();
    expect(
      (await api.transport.request({ method: 'GET', path: '/v1/me', headers: auth })).status,
    ).toBe(401);
    const fresh = await api.controls.signInAs(owner, device);
    const list = await api.transport.request({
      method: 'GET',
      path: '/v1/companies',
      headers: { authorization: `Bearer ${fresh.accessToken}` },
    });
    expect((list.body as unknown[]).length).toBe(4);
    // reset persisted immediately: a restart does not bring back the old session or company
    const restored = await createMockApi({ storage, clock: createFakeClock(START) });
    const again = await restored.transport.request({
      method: 'GET',
      path: '/v1/me',
      headers: auth,
    });
    expect(again.status).toBe(401);
  });

  it('corrupt snapshot in storage falls back to the seed instead of crashing', async () => {
    const corrupt = [
      '{not json',
      '{"schemaVersion":1}',
      '[]',
      'null',
      '{"schemaVersion":999,"users":[]}',
    ];
    for (const raw of corrupt) {
      const storage = createMemoryStorage({ [KEY]: raw });
      const api = await createMockApi({ storage, clock: createFakeClock(START) });
      const pair = await api.controls.signInAs(owner, device);
      const res = await api.transport.request({
        method: 'GET',
        path: '/v1/companies',
        headers: { authorization: `Bearer ${pair.accessToken}` },
      });
      expect(res.status).toBe(200);
      expect((res.body as unknown[]).length).toBe(4);
    }
  });

  it('a storage that throws on read falls back to the seed', async () => {
    const storage = {
      getItem: () => Promise.reject(new Error('boom')),
      setItem: () => Promise.resolve(),
    };
    const api = await createMockApi({ storage, clock: createFakeClock(START) });
    await expect(api.controls.signInAs(owner, device)).resolves.toHaveProperty('accessToken');
  });
});
