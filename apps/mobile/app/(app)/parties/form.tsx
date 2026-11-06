import { useLocalSearchParams } from 'expo-router';
import { RequireAction } from '../../../src/nav/guard';
import { PartyFormScreen } from '../../../src/screens/parties/PartyFormScreen';

const TYPES = ['customer', 'broker', 'transporter'] as const;

/** `?type=broker` adds one; `?id=…` edits that party. */
export default function PartyForm() {
  const { id, type } = useLocalSearchParams<{ id?: string; type?: string }>();
  return (
    <RequireAction action="masters.manage">
      <PartyFormScreen id={id} type={TYPES.find((x) => x === type) ?? 'customer'} />
    </RequireAction>
  );
}
