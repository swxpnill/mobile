import { useLocalSearchParams } from 'expo-router';
import { RequireAction } from '../../src/nav/guard';
import { WizardScreen } from '../../src/screens/new-order/WizardScreen';

/** `?orderId=` edits an order; `?draftId=` resumes a draft (or a duplicate); `?partyId=` starts one for that party. */
export default function OrderForm() {
  const { orderId, draftId, partyId } = useLocalSearchParams<{ orderId?: string; draftId?: string; partyId?: string }>();
  return (
    <RequireAction action={orderId ? 'order.edit' : 'order.create'}>
      <WizardScreen orderId={orderId} draftId={draftId} partyId={partyId} />
    </RequireAction>
  );
}
