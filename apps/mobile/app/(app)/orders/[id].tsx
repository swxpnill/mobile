import { useLocalSearchParams } from 'expo-router';
import { RequireAction } from '../../../src/nav/guard';
import { OrderDetailScreen } from '../../../src/screens/orders/OrderDetailScreen';

export default function Order() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return (
    <RequireAction action="order.view">
      <OrderDetailScreen id={id} />
    </RequireAction>
  );
}
