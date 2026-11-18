import { useLocalSearchParams } from 'expo-router';
import { RequireAction } from '../../../src/nav/guard';
import { TruckDetailScreen } from '../../../src/screens/dispatch/TruckDetailScreen';

export default function Truck() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return (
    <RequireAction action="dispatch.view">
      <TruckDetailScreen id={id} />
    </RequireAction>
  );
}
