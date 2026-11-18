import { useLocalSearchParams } from 'expo-router';
import { useMe } from '../../../src/api/hooks/me';
import { RequireAction } from '../../../src/nav/guard';
import { OwnerWeighScreen } from '../../../src/screens/dispatch/OwnerWeighScreen';
import { WeighTruckScreen } from '../../../src/screens/supervisor/CaptureScreen';

/** Supervisors weigh from My tasks (device store); the owner from the truck detail (Ruling 4). */
export default function Weigh() {
  const { truckId } = useLocalSearchParams<{ truckId: string }>();
  const { data: me } = useMe();
  return (
    <RequireAction action="weighment.capture">
      {me?.role === 'owner' ? <OwnerWeighScreen truckId={truckId} /> : <WeighTruckScreen truckId={truckId} />}
    </RequireAction>
  );
}
