import { useLocalSearchParams } from 'expo-router';
import { RequireAction } from '../../../src/nav/guard';
import { PartyDetailScreen } from '../../../src/screens/parties/PartyDetailScreen';

export default function Party() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return (
    <RequireAction action="masters.manage">
      <PartyDetailScreen id={id} />
    </RequireAction>
  );
}
