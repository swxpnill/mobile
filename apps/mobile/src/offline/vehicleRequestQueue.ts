import AsyncStorage from '@react-native-async-storage/async-storage';
import { type VehicleRequestBody, vehicleRequestBodySchema } from '@tonnage/shared';
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { z } from 'zod';
import { ApiError } from '../api/client';
import { showToast } from '../ui/Toast';
import { createWriteQueue } from './writeQueue';

/** A "Request vehicle" record saved while the server could not be reached (Ruling 5). */
export interface QueuedVehicleRequest {
  orderId: string;
  body: VehicleRequestBody;
  /** The Idempotency-Key of the first try: a retry after a lost answer must not record a second request. */
  key: string;
  queuedAt: string;
}

const itemSchema = z.object({ orderId: z.string(), body: vehicleRequestBodySchema, key: z.string(), queuedAt: z.string() });
/** One queue per person on this phone: signing out or switching person keeps it, nobody else sees it. */
const QUEUE_PREFIX = 'tonnage-vehicle-requests-';
export const vehicleRequestQueueKey = (userId: string) => `${QUEUE_PREFIX}${userId}`;

const cache = new Map<string, QueuedVehicleRequest[]>();
const listeners = new Set<() => void>();
let version = 0;
const serial = createWriteQueue();
const flushing = new Map<string, Promise<number>>();

function notify(): void {
  version += 1;
  for (const l of listeners) l();
}

async function load(userId: string): Promise<QueuedVehicleRequest[]> {
  const hit = cache.get(userId);
  if (hit) return hit;
  const raw = await AsyncStorage.getItem(vehicleRequestQueueKey(userId));
  const items = raw ? parseQueue(raw) : [];
  cache.set(userId, items);
  return items;
}

/**
 * The stored queue, keeping every entry that still matches the contract. Corrupt text or an entry
 * that can never be sent is dropped (and logged once), never retried forever; the rest survives.
 */
function parseQueue(raw: string): QueuedVehicleRequest[] {
  let stored: unknown;
  try {
    stored = JSON.parse(raw);
  } catch {
    console.warn('Vehicle request queue: stored text is not JSON; it was dropped');
    return [];
  }
  const entries = Array.isArray(stored) ? stored : [];
  const items = entries.flatMap((e) => {
    const parsed = itemSchema.safeParse(e);
    return parsed.success ? [parsed.data] : [];
  });
  const dropped = Array.isArray(stored) ? entries.length - items.length : 1;
  if (dropped > 0) console.warn(`Vehicle request queue: dropped ${dropped} unreadable entr${dropped === 1 ? 'y' : 'ies'}`);
  return items;
}

/** How many requests wait in this person's queue, or null before it has been read from storage. */
export const queuedVehicleRequestCount = (userId: string): number | null => cache.get(userId)?.length ?? null;

async function save(userId: string, items: QueuedVehicleRequest[]): Promise<void> {
  await AsyncStorage.setItem(vehicleRequestQueueKey(userId), JSON.stringify(items));
  cache.set(userId, items);
  notify();
}

export const readVehicleRequestQueue = (userId: string): Promise<QueuedVehicleRequest[]> => serial(() => load(userId));

export const enqueueVehicleRequest = (userId: string, item: QueuedVehicleRequest): Promise<void> =>
  serial(async () => save(userId, [...(await load(userId)), item]));

const remove = (userId: string, key: string): Promise<void> =>
  serial(async () => save(userId, (await load(userId)).filter((i) => i.key !== key)));

/** Refusals that would never succeed on a retry. */
const NEVER = new Set([403, 404, 422]);

/**
 * Sends the queue in order with `send` (which must use `item.key` as the Idempotency-Key).
 * An item leaves the queue on success, or on a refusal that can never succeed (422, 404, 403:
 * a toast says why). Anything else (no connection, a server error, a request still in progress)
 * stops the run and keeps the item and those behind it. Resolves with how many were recorded.
 * One run per person at a time: a second call joins the one in progress.
 */
export function flushVehicleRequests(
  userId: string,
  send: (item: QueuedVehicleRequest) => Promise<void>,
  onDropped?: (item: QueuedVehicleRequest) => void,
): Promise<number> {
  const running = flushing.get(userId);
  if (running) return running;
  const run = (async () => {
    let sent = 0;
    for (;;) {
      const [item] = await readVehicleRequestQueue(userId);
      if (!item) return sent;
      try {
        await send(item);
        sent += 1;
      } catch (e) {
        if (!(e instanceof ApiError) || !NEVER.has(e.status)) return sent;
        showToast(`Couldn't record the vehicle request: ${e.message}`);
        onDropped?.(item);
      }
      await remove(userId, item.key);
    }
  })().finally(() => flushing.delete(userId));
  flushing.set(userId, run);
  return run;
}

/** The queued requests of one order for this person, oldest first; re-renders when the queue changes. */
export function useVehicleRequestQueue(
  userId: string | undefined,
  orderId: string,
): (VehicleRequestBody & { queuedAt: string; key: string })[] {
  const v = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    () => version,
  );
  useEffect(() => {
    if (userId) void readVehicleRequestQueue(userId).then(notify, () => undefined);
  }, [userId]);
  return useMemo(
    () =>
      (userId ? (cache.get(userId) ?? []) : [])
        .filter((i) => i.orderId === orderId)
        .map((i) => ({ ...i.body, queuedAt: i.queuedAt, key: i.key })),
    // `v` is the queue's change counter: the cache is read again whenever it moves.
    [userId, orderId, v],
  );
}

/** Reset demo data: every person's queue on this phone goes (the orders they point at are gone). */
export async function clearAllVehicleRequestQueues(): Promise<void> {
  await serial(async () => {
    const keys = (await AsyncStorage.getAllKeys()).filter((k) => k.startsWith(QUEUE_PREFIX));
    if (keys.length) await AsyncStorage.multiRemove(keys);
    cache.clear();
    notify();
  });
}

export function resetVehicleRequestQueueForTests(): void {
  cache.clear();
  flushing.clear();
  version = 0;
}
