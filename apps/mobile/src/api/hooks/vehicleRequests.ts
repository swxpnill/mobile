import {
  type Me,
  NetworkError,
  type Order,
  type VehicleRequest,
  type VehicleRequestBody,
  can,
  meSchema,
  vehicleRequestSchema,
} from '@tonnage/shared';
import { type QueryClient, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import { z } from 'zod';
import { useSession } from '../../auth/session';
import {
  type QueuedVehicleRequest,
  enqueueVehicleRequest,
  flushVehicleRequests,
  useVehicleRequestQueue,
} from '../../offline/vehicleRequestQueue';
import { api } from '../client';
import { useSubmitKey } from '../submitKey';
import { currentIdentity } from './cache';
import { ME_KEY, useMe } from './me';
import { afterOrderChange, orderKey } from './orders';

const createdSchema = z.object({ request: vehicleRequestSchema });
const path = (orderId: string) => `/v1/orders/${orderId}/vehicle-requests`;

async function currentUser(qc: QueryClient): Promise<Me> {
  return qc.getQueryData<Me>(ME_KEY) ?? (await qc.fetchQuery({ queryKey: ME_KEY, queryFn: () => api('/v1/me', { schema: meSchema }) }));
}

/** Shows a request in the order's cache before the server has it (never replaces the server's list). */
function addToOrderCache(qc: QueryClient, orderId: string, request: VehicleRequest): void {
  qc.setQueryData<Order>(orderKey(orderId), (order) =>
    order && !order.vehicleRequests.some((r) => r.id === request.id)
      ? { ...order, vehicleRequests: [request, ...order.vehicleRequests] }
      : order,
  );
}

/** The request as the order will show it once recorded, built from what this phone already knows. */
function optimistic(qc: QueryClient, orderId: string, item: QueuedVehicleRequest, me: Me): VehicleRequest | null {
  const order = qc.getQueryData<Order>(orderKey(orderId));
  if (!order) return null;
  const party = [order.customer, order.broker].find((p) => p?.id === item.body.partyId);
  const subOf = new Map(order.subOrders.flatMap((s) => s.lines.map((l) => [l.id, s.id] as const)));
  return {
    id: `queued-${item.key}`,
    partyId: item.body.partyId,
    partyName: party?.name ?? item.body.contactName,
    contactName: item.body.contactName,
    number: item.body.number,
    channel: item.body.channel,
    lines: item.body.lines.map((l) => ({ orderLineId: l.orderLineId, subOrderId: subOf.get(l.orderLineId) ?? '', kg: l.kg })),
    totalKg: item.body.totalKg,
    requestedAt: item.queuedAt,
    requestedBy: { id: me.id, name: me.name },
  };
}

/**
 * Sends this person's queued vehicle requests (oldest first, each with the key of its first try)
 * and refreshes the order views for what was recorded. Resolves with how many went through.
 * Stops quietly if the person signed out or changed meanwhile.
 */
export async function flushQueuedVehicleRequests(qc: QueryClient, userId: string): Promise<number> {
  const identity = currentIdentity();
  const sent = await flushVehicleRequests(userId, async (item) => {
    // Never send one person's queue under another person's token.
    if (currentIdentity() !== identity) throw new NetworkError('Signed in as someone else');
    await api(path(item.orderId), { method: 'POST', body: item.body, idempotencyKey: item.key });
    afterOrderChange(qc, identity);
  });
  return sent;
}

/**
 * Records a vehicle request on an order. `send` gives 'sent' once the server has it, or 'queued'
 * when the server could not be reached: the request is then kept on this phone with its
 * Idempotency-Key and sent on the next app foreground or after the next successful send (Ruling 5).
 * Any other failure (a refusal, a server error) is thrown for the screen to show.
 */
export function useRequestVehicle(orderId: string): { send(body: VehicleRequestBody): Promise<'sent' | 'queued'> } {
  const qc = useQueryClient();
  const submit = useSubmitKey();
  const ref = useRef({ qc, submit, orderId });
  ref.current = { qc, submit, orderId };
  const api_ = useRef({
    async send(body: VehicleRequestBody): Promise<'sent' | 'queued'> {
      const { qc, submit, orderId } = ref.current;
      const identity = currentIdentity();
      const key = submit.key(JSON.stringify(body));
      try {
        const { request } = await api(path(orderId), { method: 'POST', body, idempotencyKey: key, schema: createdSchema });
        submit.settle();
        if (currentIdentity() === identity) addToOrderCache(qc, orderId, request);
        afterOrderChange(qc, identity);
        const me = qc.getQueryData<Me>(ME_KEY); // the answer is in: never fail the send over the flush
        if (me) void flushQueuedVehicleRequests(qc, me.id).catch(() => undefined);
        return 'sent';
      } catch (e) {
        if (!(e instanceof NetworkError)) {
          submit.settle(e);
          throw e;
        }
        const me = await currentUser(qc);
        const item: QueuedVehicleRequest = { orderId, body, key, queuedAt: new Date().toISOString() };
        await enqueueVehicleRequest(me.id, item);
        submit.settle(); // the queue owns this key now; a new tap is a new request
        const request = optimistic(qc, orderId, item, me);
        if (request && currentIdentity() === identity) addToOrderCache(qc, orderId, request);
        return 'queued';
      }
    },
  });
  return api_.current;
}

/** This order's requests waiting on this phone to be sent ("· waiting to send"), oldest first. */
export function useQueuedVehicleRequests(orderId: string): (VehicleRequestBody & { queuedAt: string; key: string })[] {
  return useVehicleRequestQueue(useMe().data?.id, orderId);
}

/**
 * Mounted once behind sign-in: sends the queue when the app comes to the foreground (and at
 * launch) for people who can request vehicles.
 */
export function useVehicleRequestFlusher(): void {
  const qc = useQueryClient();
  const status = useSession((s) => s.status);
  const { data: me } = useMe();
  const userId = status === 'signedIn' && me && can(me.role, 'truck.assign') ? me.id : undefined;

  useEffect(() => {
    if (!userId) return;
    const flush = () => void flushQueuedVehicleRequests(qc, userId).catch(() => undefined);
    flush();
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') flush();
    });
    return () => sub.remove();
  }, [qc, userId]);
}
