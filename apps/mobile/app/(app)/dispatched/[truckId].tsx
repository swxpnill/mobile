import { useLocalSearchParams } from 'expo-router';
import { RequireAction } from '../../../src/nav/guard';
import { DispatchedScreen } from '../../../src/screens/supervisor/DispatchedScreen';

export default function Dispatched() {
  const { truckId } = useLocalSearchParams<{ truckId: string }>();
  return (
    <RequireAction action="weighment.capture">
      <DispatchedScreen truckId={truckId} />
    </RequireAction>
  );
}
