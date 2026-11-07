import { RequireAction } from '../../../src/nav/guard';
import { WizardScreen } from '../../../src/screens/new-order/WizardScreen';

export default function NewTab() {
  return (
    <RequireAction action="order.create">
      <WizardScreen inTab />
    </RequireAction>
  );
}
