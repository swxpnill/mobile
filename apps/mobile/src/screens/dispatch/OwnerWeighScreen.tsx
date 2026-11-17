import type { Task } from '@tonnage/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useRef } from 'react';
import { ActivityIndicator } from 'react-native';
import { DISPATCH_KEY, HOME_KEY, ORDERS_KEY, TRUCK_KEY } from '../../api/hooks/orders';
import { useTruck } from '../../api/hooks/trucks';
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
 * the save (one transaction). A pending local weight on this phone wins over the server's state.
 */
export function OwnerWeighScreen({ truckId }: { truckId: string }) {
  const router = useRouter();
  const qc = useQueryClient();
  const { t } = useTheme();
  const truck = useTruck(truckId);
  const snap = useDeviceSnapshot();
  const fixed = useRef<{ task: Task; mode: CaptureMode; tareAt: string | null } | null>(null);

  const server = truck.data ? truckToTask(truck.data) : null;
  const local = snap?.shown.find((x) => x.truckId === truckId);
  const task = local ?? server;
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
        void syncNow().then(() => {
          for (const key of [TRUCK_KEY, DISPATCH_KEY, HOME_KEY, ORDERS_KEY]) void qc.invalidateQueries({ queryKey: key });
        });
      }}
    />
  );
}
