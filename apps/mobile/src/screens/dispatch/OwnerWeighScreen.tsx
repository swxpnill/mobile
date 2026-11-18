import type { Task } from '@tonnage/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useRef } from 'react';
import { ActivityIndicator } from 'react-native';
import { currentIdentity } from '../../api/hooks/cache';
import { TRUCK_KEY, orderKey } from '../../api/hooks/orders';
import { afterTruckChange, useTruck } from '../../api/hooks/trucks';
import { useSession } from '../../auth/session';
import { useDeviceSnapshot } from '../../offline/useDeviceData';
import { syncNow } from '../../offline/useSync';
import { useTheme } from '../../theme/ThemeProvider';
import { EmptyState, Screen } from '../../ui';
import { type CaptureMode, CaptureScreen } from '../supervisor/CaptureScreen';
import { messageFor } from '../messages';
import { isOpenState, truckToTask } from './truckStateMeta';

/**
 * The owner weighs from the truck detail (Ruling 4) with the supervisor's capture screen, through
 * this phone's outbox. The owner's pull covers every plant, so the truck is usually on the phone
 * already; one assigned a moment ago is not yet, so the server's truck goes into the store with
 * the save (one transaction).
 *
 * Which copy decides tare or gross: the phone's copy only when it carries an unsent local weight
 * (`localPending`) or is at least as new as the server's (`version`); otherwise the server's,
 * so a stale "assigned" copy never opens tare for a truck that is already loading. Without the
 * server's answer (offline, or the fetch failed) the phone's copy is all there is.
 */
function pick(local: (Task & { localPending: boolean }) | undefined, server: Task | null): Task | null {
  if (local && (local.localPending || !server || local.version >= server.version)) return local;
  return server;
}
/** The owner's capture route (`/weigh/:truckId` for the owner); `pick` chooses the copy. */
export function OwnerWeighScreen({ truckId }: { truckId: string }) {
  const router = useRouter();
  const qc = useQueryClient();
  const { t } = useTheme();
  const truck = useTruck(truckId);
  const snap = useDeviceSnapshot();
  const fixed = useRef<{ task: Task; mode: CaptureMode; tareAt: string | null } | null>(null);

  const server = truck.data ? truckToTask(truck.data) : null;
  const local = snap?.shown.find((x) => x.truckId === truckId);
  // Wait for the server's copy unless the phone has an unsent weight or the fetch has failed.
  const settled = truck.data !== undefined || truck.isError || local?.localPending === true;
  const task = settled ? pick(local, server) : null;
  if (!fixed.current && task && snap !== null) {
    fixed.current = { task, mode: task.state === 'loading' ? 'gross' : 'tare', tareAt: task.tareKg === null ? null : task.tareAt };
  }
  const shown = fixed.current;

  if (!shown) {
    if (truck.isPending || snap === null)
      return (
        <Screen>
          <ActivityIndicator color={t.br} accessibilityLabel="Loading" />
        </Screen>
      );
    return (
      <Screen>
        <EmptyState
          icon="truck"
          title="Not found"
          body={truck.isError ? messageFor(truck.error) : 'This truck is no longer open.'}
          actions={[{ label: 'Back', onPress: () => router.back() }]}
        />
      </Screen>
    );
  }
  if (!isOpenState(shown.task.state)) {
    return (
      <Screen>
        <EmptyState
          icon="truck"
          title="Nothing to weigh"
          body="This truck is already dispatched or cancelled."
          actions={[{ label: 'Back', onPress: () => router.back() }]}
        />
      </Screen>
    );
  }
  return (
    <CaptureScreen
      task={shown.task}
      mode={shown.mode}
      tareAt={shown.tareAt}
      ensureTask={server ?? undefined}
      onSaved={() => {
        router.back();
        const identity = currentIdentity();
        const orderId = truck.data?.orderId;
        void syncNow().then(() => {
          // The server's truck after the sync is not in hand: refetch it rather than set it.
          afterTruckChange(qc, identity);
          if (useSession.getState().identity !== identity) return;
          void qc.invalidateQueries({ queryKey: TRUCK_KEY });
          if (orderId) void qc.invalidateQueries({ queryKey: orderKey(orderId) });
        });
      }}
    />
  );
}
