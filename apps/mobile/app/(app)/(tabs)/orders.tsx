import { useLocalSearchParams } from 'expo-router';
import { OrdersScreen } from '../../../src/screens/orders/OrdersScreen';

/** `?aged=1` opens on the orders older than the tenant's aged-order days (from Home). */
export default function OrdersTab() {
  const { aged } = useLocalSearchParams<{ aged?: string }>();
  return <OrdersScreen key={aged ?? 'all'} initialAged={aged === '1'} />;
}
