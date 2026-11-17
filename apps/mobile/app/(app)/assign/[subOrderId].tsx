import { useLocalSearchParams } from 'expo-router';
import { RequireAction } from '../../../src/nav/guard';
import { AssignVehicleScreen } from '../../../src/screens/dispatch/AssignVehicleScreen';

/** `/assign/:subOrderId?orderId=…` assigns; with `&truckId=…` it edits that truck. */
export default function Assign() {
  const { subOrderId, orderId, truckId } = useLocalSearchParams<{ subOrderId: string; orderId: string; truckId?: string }>();
  return (
    <RequireAction action={truckId ? 'truck.edit' : 'truck.assign'}>
      <AssignVehicleScreen subOrderId={subOrderId} orderId={orderId} truckId={truckId} />
    </RequireAction>
  );
}
