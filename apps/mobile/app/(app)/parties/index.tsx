import { useLocalSearchParams } from 'expo-router';
import { RequireAction } from '../../../src/nav/guard';
import { PartiesScreen } from '../../../src/screens/parties/PartiesScreen';

const TYPES = ['customer', 'broker', 'transporter'] as const;

export default function Parties() {
  const { type } = useLocalSearchParams<{ type?: string }>();
  const initial = TYPES.find((x) => x === type) ?? 'customer';
  return (
    <RequireAction action="masters.manage">
      <PartiesScreen initialType={initial} />
    </RequireAction>
  );
}
