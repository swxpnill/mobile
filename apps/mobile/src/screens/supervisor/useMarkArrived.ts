import * as Crypto from 'expo-crypto';
import { useCallback, useRef, useState } from 'react';
import { recordCapture, useDeviceStore } from '../../offline/useSync';
import { showToast } from '../../ui';
import { SAVED_ON_PHONE as SAVED, SAVE_FAILED as FAILED } from './saveMessages';

/**
 * TON-57 "Vehicle arrived": one `AT_GATE` in this phone's outbox (offline too), then a sync. Single
 * flight per screen, so a double tap records one arrival. The device store shows the truck as
 * arrived at once (`displayTasks`), which is what enables its tare.
 */
export function useMarkArrived(): { mark(truckId: string): Promise<boolean>; busy: string | null } {
  const store = useDeviceStore((s) => s.store);
  const flight = useRef(false);
  const [busy, setBusy] = useState<string | null>(null);

  const mark = useCallback(
    async (truckId: string) => {
      if (flight.current) return false;
      if (!store) {
        showToast(FAILED);
        return false;
      }
      flight.current = true;
      setBusy(truckId);
      try {
        await recordCapture(store, {
          eventId: Crypto.randomUUID(),
          truckId,
          type: 'AT_GATE',
          payload: {},
          capturedAtDevice: new Date().toISOString(),
        });
        showToast(SAVED);
        return true;
      } catch {
        showToast(FAILED);
        return false;
      } finally {
        flight.current = false;
        setBusy(null);
      }
    },
    [store],
  );

  return { mark, busy };
}
