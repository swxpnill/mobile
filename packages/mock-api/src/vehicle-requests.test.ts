import { afterEach, describe, expect, it, vi } from 'vitest';
import { SAMPLE_MASTERS, SAMPLE_WORLD, orderSchema } from '@tonnage/shared';
import { createFakeClock, MINUTE } from './clock.ts';
import { createMockApi } from './index.ts';
import { createMemoryStorage, parseSnapshot } from './store.ts';

const NOW = Date.UTC(2026, 10, 23, 6, 0);
const DEVICE = '019a4c00-00ff-7000-8000-000000000001';
const KEY = 'tonnage.mockState';

afterEach(() => {
  vi.useRealTimers();
});

async function seeded() {
  const storage = createMemoryStorage();
  const api = await createMockApi({ clock: createFakeClock(NOW), storage, seedOrders: true });
  const token = (await api.controls.signInAs(SAMPLE_WORLD.ids.users.rajesh, DEVICE)).accessToken;
  const get = async (path: string) =>
    api.transport.request({ method: 'GET', path, headers: { authorization: `Bearer ${token}` } });
  const list = (await get('/v1/orders?limit=50')).body as { items: { id: string; number: string }[] };
  const summary = list.items.find((o) => o.number.endsWith('0142'));
  if (!summary) throw new Error('demo order 0142 missing');
  const order = orderSchema.parse((await get(`/v1/orders/${summary.id}`)).body);
  return { api, storage, token, order };
}

describe('vehicle requests in the demo data', () => {
  it("the demo order via R.K. Agarwal has one open request for its KRM line, on his WhatsApp number", async () => {
    const { order } = await seeded();
    const krm = order.subOrders[1]!;
    expect(order.broker?.id).toBe(SAMPLE_MASTERS.ids.parties.rkAgarwal);
    expect(order.vehicleRequests).toEqual([
      {
        id: expect.any(String),
        partyId: SAMPLE_MASTERS.ids.parties.rkAgarwal,
        partyName: 'R.K. Agarwal',
        contactName: 'R.K. Agarwal',
        number: '+919826100501',
        channel: 'whatsapp',
        lines: [{ orderLineId: krm.lines[0]!.id, subOrderId: krm.id, kg: 30_000 }],
        totalKg: 30_000,
        requestedAt: new Date(NOW - 20 * MINUTE).toISOString(),
        requestedBy: { id: SAMPLE_WORLD.ids.users.rajesh, name: 'Rajesh Agrawal' },
      },
    ]);
    expect(krm.lines[0]!.pendingKg).toBeGreaterThanOrEqual(30_000);
  });

  it('hard delete removes the order’s requests from the stored state', async () => {
    vi.useFakeTimers();
    const { api, storage, token, order } = await seeded();
    const del = await api.transport.request({
      method: 'DELETE',
      path: `/v1/orders/${order.id}`,
      headers: { authorization: `Bearer ${token}`, 'idempotency-key': 'del-1' },
      body: { confirmNumber: order.number },
    });
    expect(del.status).toBe(204);
    await vi.advanceTimersByTimeAsync(250);
    const saved = parseSnapshot(await storage.getItem(KEY));
    expect(saved?.vehicleRequests).toEqual([]);
  });
});
