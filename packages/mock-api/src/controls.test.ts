import { afterEach, describe, expect, it, vi } from 'vitest';
import { NetworkError, SAMPLE_WORLD, meSchema, tokenPairSchema } from '@tonnage/shared';
import { createFakeClock } from './clock.ts';
import { createMockApi } from './index.ts';

const START = Date.UTC(2026, 10, 3, 4, 30);
const meta = { method: 'GET', path: '/v1/meta', headers: {} } as const;
const device = '019a4c00-00ff-7000-8000-000000000001';

afterEach(() => {
  vi.useRealTimers();
});

describe('controls', () => {
  it('setOffline(true) → transport rejects with NetworkError; false → works again', async () => {
    const api = await createMockApi({ clock: createFakeClock(START) });
    api.controls.setOffline(true);
    await expect(api.transport.request(meta)).rejects.toBeInstanceOf(NetworkError);
    await expect(api.transport.request(meta)).rejects.toMatchObject({ name: 'NetworkError' });
    api.controls.setOffline(false);
    expect((await api.transport.request(meta)).status).toBe(200);
  });

  it('failNext(503, "INTERNAL") affects exactly one request', async () => {
    const api = await createMockApi({ clock: createFakeClock(START) });
    api.controls.failNext(503, 'INTERNAL');
    const first = await api.transport.request(meta);
    expect(first.status).toBe(503);
    expect(first.body).toMatchObject({ code: 'INTERNAL' });
    expect((await api.transport.request(meta)).status).toBe(200);
    expect((await api.transport.request(meta)).status).toBe(200);
  });

  it('latency delays responses by the configured ms (fake timers)', async () => {
    vi.useFakeTimers();
    const api = await createMockApi({ clock: createFakeClock(START), latencyMs: 800 });
    let done = false;
    const p = api.transport.request(meta).then((r) => {
      done = true;
      return r;
    });
    await vi.advanceTimersByTimeAsync(799);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(true);
    expect((await p).status).toBe(200);

    api.controls.setLatency(0);
    done = false;
    const q = api.transport.request(meta).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(true);
    await q;
  });

  it('signInAs returns a token pair usable on GET /v1/me', async () => {
    const api = await createMockApi({ clock: createFakeClock(START) });
    const pair = await api.controls.signInAs(SAMPLE_WORLD.ids.users.kiran, device);
    expect(tokenPairSchema.safeParse(pair).success).toBe(true);
    const res = await api.transport.request({
      method: 'GET',
      path: '/v1/me',
      headers: { authorization: `Bearer ${pair.accessToken}` },
    });
    expect(res.status).toBe(200);
    const me = meSchema.parse(res.body);
    expect(me).toMatchObject({
      name: 'Kiran Rao',
      role: 'plant_head',
      plantIds: [SAMPLE_WORLD.ids.plants.siltara],
    });
    await expect(
      api.controls.signInAs('019a4c00-0003-7000-8000-0000000000ff', device),
    ).rejects.toThrow();
  });

  it('fixtures.createTenant creates a separate tenant whose owner can sign in', async () => {
    const api = await createMockApi({ clock: createFakeClock(START) });
    const t = await api.fixtures.createTenant('Other Group');
    expect(t.tenantId).not.toBe(SAMPLE_WORLD.tenant.id);
    const post = (path: string, body: unknown) =>
      api.transport.request({ method: 'POST', path, headers: {}, body });
    expect((await post('/v1/auth/request-code', { mobile: t.ownerMobile })).status).toBe(200);
    const v = await post('/v1/auth/verify', {
      mobile: t.ownerMobile,
      code: '123456',
      deviceId: device,
    });
    expect(v.status).toBe(200);
    const token = (v.body as { accessToken: string }).accessToken;
    const companies = await api.transport.request({
      method: 'GET',
      path: '/v1/companies',
      headers: { authorization: `Bearer ${token}` },
    });
    expect((companies.body as { id: string }[]).map((c) => c.id)).toEqual([t.companyId]);
    const plants = await api.transport.request({
      method: 'GET',
      path: '/v1/plants',
      headers: { authorization: `Bearer ${token}` },
    });
    expect((plants.body as { id: string }[]).map((p) => p.id)).toEqual([t.plantId]);
  });
});
