import { useLocalSearchParams } from 'expo-router';
import { RequireAction } from '../../../src/nav/guard';
import { WeighTruckScreen } from '../../../src/screens/supervisor/CaptureScreen';

export default function Weigh() {
  const { truckId } = useLocalSearchParams<{ truckId: string }>();
  return (
    <RequireAction action="weighment.capture">
      <WeighTruckScreen truckId={truckId} />
    </RequireAction>
  );
}
