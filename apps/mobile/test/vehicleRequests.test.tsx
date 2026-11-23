// Request vehicle (Task 3): the mutation, the per-person offline queue, copy to clipboard.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as Clipboard from 'expo-clipboard';
import * as SecureStore from 'expo-secure-store';
import type { ReactNode } from 'react';
import { z } from 'zod';
import { type Order, SAMPLE_WORLD, type VehicleRequestBody, activityEntrySchema, orderSchema } from '@tonnage/shared';
import { createFakeClock, createMockApi, type MockApi } from '@tonnage/mock-api';
import { api } from '../src/api/client';
import { ME_CACHE_KEY, useMe } from '../src/api/hooks/me';
import { useOrder, useOrderActivity } from '../src/api/hooks/orders';
import { flushQueuedVehicleRequests, useQueuedVehicleRequests, useRequestVehicle } from '../src/api/hooks/vehicleRequests';
import { setMockApi, setTransport } from '../src/api/transport';
import { resetSessionForTests, useSession } from '../src/auth/session';
import { copyText } from '../src/format/clipboard';
import {
  enqueueVehicleRequest,
  flushVehicleRequests,
  clearAllVehicleRequestQueues,
  readVehicleRequestQueue,
  resetVehicleRequestQueueForTests,
} from '../src/offline/vehicleRequestQueue';
import * as Toast from '../src/ui/Toast';

const { ids } = SAMPLE_WORLD;
const RAJESH = ids.users.rajesh;
let mock: MockApi;
let client: QueryClient;

const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;

const postOf = (item: { orderId: string; body: VehicleRequestBody; key: string }) =>
  api(`/v1/orders/${item.orderId}/vehicle-requests`, { method: 'POST', body: item.body, idempotencyKey: item.key }).then(() => undefined);

/** An order with something pending, and a request body for one of its open lines. */
async function pickOrder(kg = 1_000): Promise<{ order: Order; body: VehicleRequestBody }> {
  const list = await api('/v1/orders?status=open', { schema: z.object({ items: z.array(z.object({ id: z.string() })) }).passthrough() });
  for (const { id } of list.items) {
    const order = await api(`/v1/orders/${id}`, { schema: orderSchema });
    const party = order.broker ?? order.customer;
    const line = order.subOrders.flatMap((s) => s.lines).find((l) => l.pendingKg >= kg);
    if (party && line) {
      return {
        order,
        body: {
          partyId: party.id,
          contactName: party.name,
          number: '+919826100501',
          channel: 'whatsapp',
          lines: [{ orderLineId: line.id, kg }],
          totalKg: kg,
        },
      };
    }
  }
  throw new Error('no demo order with pending quantity');
}

const activityOf = async (orderId: string) =>
  (await api(`/v1/orders/${orderId}/activity`, { schema: z.array(activityEntrySchema) })).filter((e) => e.action === 'order.vehicle_requested');

beforeEach(async () => {
  await AsyncStorage.clear();
  (SecureStore as unknown as { __reset(): void }).__reset();
  resetSessionForTests();
  resetVehicleRequestQueueForTests();
  Toast.hideToast();
  jest.clearAllMocks();
  mock = await createMockApi({ clock: createFakeClock(Date.UTC(2026, 10, 3, 4, 30)), seedOrders: true });
  setTransport(null);
  setMockApi(mock);
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { gcTime: Infinity } } });
  const deviceId = await useSession.getState().ensureDeviceId();
  await useSession.getState().signIn(await mock.controls.signInAs(RAJESH, deviceId));
});

afterEach(() => {
  client.clear();
  setMockApi(null);
});

describe('useRequestVehicle', () => {
  it('online: send gives "sent", the request is in the order cache and in the activity', async () => {
    const { order, body } = await pickOrder();
    const { result } = await renderHook(
      () => ({ send: useRequestVehicle(order.id).send, order: useOrder(order.id), activity: useOrderActivity(order.id) }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.order.data).toBeDefined());
    let outcome: string | undefined;
    await act(async () => {
      outcome = await result.current.send(body);
    });
    expect(outcome).toBe('sent');
    await waitFor(() => expect(result.current.order.data?.vehicleRequests.map((r) => r.totalKg)).toContain(body.totalKg));
    await waitFor(() => expect(result.current.activity.data?.filter((e) => e.action === 'order.vehicle_requested')).toHaveLength(1));
    expect(await readVehicleRequestQueue(RAJESH)).toEqual([]);
  });

  it('Offline: send gives "queued" with the request shown at once; back online, a flush records exactly one with the same key', async () => {
    const { order, body } = await pickOrder();
    const { result } = await renderHook(
      () => ({ send: useRequestVehicle(order.id).send, order: useOrder(order.id), queued: useQueuedVehicleRequests(order.id) }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.order.data).toBeDefined());

    mock.controls.setOffline(true);
    let outcome: string | undefined;
    await act(async () => {
      outcome = await result.current.send(body);
    });
    expect(outcome).toBe('queued');
    await waitFor(() =>
      expect(result.current.order.data?.vehicleRequests[0]).toMatchObject({ totalKg: body.totalKg, contactName: body.contactName }),
    );
    await waitFor(() => expect(result.current.queued).toHaveLength(1));
    expect(result.current.queued[0]).toMatchObject({ ...body, queuedAt: expect.any(String), key: expect.any(String) });
    const [stored] = await readVehicleRequestQueue(RAJESH);
    expect(stored!.key).toBe(result.current.queued[0]!.key);

    mock.controls.setOffline(false);
    expect(await activityOf(order.id)).toHaveLength(0);
    const keys: string[] = [];
    let sent = -1;
    await act(async () => {
      sent = await flushVehicleRequests(RAJESH, (item) => {
        keys.push(item.key);
        return postOf(item);
      });
    });
    expect(sent).toBe(1);
    expect(keys).toEqual([stored!.key]);
    expect(await activityOf(order.id)).toHaveLength(1);
    await waitFor(() => expect(result.current.queued).toEqual([]));

    // A retry after a lost answer reuses the stored key: the server replays, no second request.
    await postOf({ orderId: order.id, body, key: stored!.key });
    expect(await activityOf(order.id)).toHaveLength(1);
  });

  it('flushQueuedVehicleRequests sends the signed-in person\'s queue once Offline is off', async () => {
    const { order, body } = await pickOrder();
    const { result } = await renderHook(() => ({ vr: useRequestVehicle(order.id), me: useMe() }), { wrapper });
    await waitFor(() => expect(result.current.me.data).toBeDefined());
    mock.controls.setOffline(true);
    await act(async () => {
      await result.current.vr.send(body);
    });
    mock.controls.setOffline(false);
    let sent = -1;
    await act(async () => {
      sent = await flushQueuedVehicleRequests(client, RAJESH);
    });
    expect(sent).toBe(1);
    expect(await activityOf(order.id)).toHaveLength(1);
    expect(await readVehicleRequestQueue(RAJESH)).toEqual([]);
  });
});

describe('the offline queue', () => {
  it('a queued item the server refuses (422) is dropped with a toast, and the next one still goes', async () => {
    const { order, body } = await pickOrder();
    const tooMuch: VehicleRequestBody = { ...body, lines: [{ orderLineId: body.lines[0]!.orderLineId, kg: 900_000_000 }], totalKg: 900_000_000 };
    const toast = jest.spyOn(Toast, 'showToast');
    await enqueueVehicleRequest(RAJESH, { orderId: order.id, body: tooMuch, key: 'k-bad', queuedAt: '2026-11-03T04:30:00.000Z' });
    await enqueueVehicleRequest(RAJESH, { orderId: order.id, body, key: 'k-good', queuedAt: '2026-11-03T04:31:00.000Z' });
    const sent = await flushVehicleRequests(RAJESH, postOf);
    expect(sent).toBe(1);
    expect(await readVehicleRequestQueue(RAJESH)).toEqual([]);
    expect(toast).toHaveBeenCalledWith(expect.stringMatching(/^Couldn't record the vehicle request: .+/));
    expect(await activityOf(order.id)).toHaveLength(1);
  });

  it('a network failure keeps the item and everything behind it, in order', async () => {
    const { order, body } = await pickOrder();
    await enqueueVehicleRequest(RAJESH, { orderId: order.id, body, key: 'k1', queuedAt: '2026-11-03T04:30:00.000Z' });
    await enqueueVehicleRequest(RAJESH, { orderId: order.id, body, key: 'k2', queuedAt: '2026-11-03T04:31:00.000Z' });
    mock.controls.setOffline(true);
    const sent = await flushVehicleRequests(RAJESH, postOf);
    expect(sent).toBe(0);
    expect((await readVehicleRequestQueue(RAJESH)).map((i) => i.key)).toEqual(['k1', 'k2']);
  });

  it('is kept per person: another person never sees or sends it', async () => {
    const { order, body } = await pickOrder();
    await enqueueVehicleRequest(RAJESH, { orderId: order.id, body, key: 'k1', queuedAt: '2026-11-03T04:30:00.000Z' });
    expect(await readVehicleRequestQueue(ids.users.priya)).toEqual([]);
    expect(await AsyncStorage.getItem(`tonnage-vehicle-requests-${RAJESH}`)).toContain('k1');
  });
});

describe('refused queued items and the cache', () => {
  it('a 422-dropped item leaves no phantom request in the order cache', async () => {
    const { order, body } = await pickOrder();
    const tooMuch: VehicleRequestBody = { ...body, lines: [{ orderLineId: body.lines[0]!.orderLineId, kg: 900_000_000 }], totalKg: 900_000_000 };
    const { result } = await renderHook(() => ({ vr: useRequestVehicle(order.id), order: useOrder(order.id), me: useMe() }), { wrapper });
    await waitFor(() => expect(result.current.me.data && result.current.order.data).toBeDefined());
    mock.controls.setOffline(true);
    await act(async () => {
      expect(await result.current.vr.send(tooMuch)).toBe('queued');
    });
    const phantom = () => (client.getQueryData(['order', order.id]) as Order).vehicleRequests.filter((r) => r.id.startsWith('queued-'));
    expect(phantom()).toHaveLength(1);
    mock.controls.setOffline(false);
    await act(async () => {
      await flushQueuedVehicleRequests(client, RAJESH);
    });
    expect(await readVehicleRequestQueue(RAJESH)).toEqual([]);
    expect(phantom()).toEqual([]);
  });

  it('offline with no profile in memory, send still queues (falls back to the kept profile)', async () => {
    const { order, body } = await pickOrder();
    const me = await api('/v1/me');
    await AsyncStorage.setItem(ME_CACHE_KEY, JSON.stringify(me));
    const { result } = await renderHook(() => useRequestVehicle(order.id), { wrapper });
    mock.controls.setOffline(true);
    let outcome: string | undefined;
    await act(async () => {
      outcome = await result.current.send(body);
    });
    expect(outcome).toBe('queued');
    expect(await readVehicleRequestQueue(RAJESH)).toHaveLength(1);
  });

  it("clearAllVehicleRequestQueues empties every person's queue", async () => {
    const { order, body } = await pickOrder();
    const item = { orderId: order.id, body, key: 'k1', queuedAt: '2026-11-03T04:30:00.000Z' };
    await enqueueVehicleRequest(RAJESH, item);
    await enqueueVehicleRequest(ids.users.priya, { ...item, key: 'k2' });
    await clearAllVehicleRequestQueues();
    expect(await readVehicleRequestQueue(RAJESH)).toEqual([]);
    expect(await readVehicleRequestQueue(ids.users.priya)).toEqual([]);
    expect((await AsyncStorage.getAllKeys()).filter((k) => k.startsWith('tonnage-vehicle-requests-'))).toEqual([]);
  });
});

describe('copyText', () => {
  it('puts the text on the clipboard', async () => {
    await copyText('Namaste');
    expect(Clipboard.setStringAsync).toHaveBeenCalledWith('Namaste');
  });
});
