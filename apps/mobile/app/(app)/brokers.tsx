import { RequireAction } from '../../src/nav/guard';
import { BrokerDuesScreen } from '../../src/screens/money/BrokerDuesScreen';

/** More → Broker ledger (Ruling 8): money roles only; anyone else lands on their first tab. */
export default function Brokers() {
  return (
    <RequireAction action="money.view">
      <BrokerDuesScreen />
    </RequireAction>
  );
}
