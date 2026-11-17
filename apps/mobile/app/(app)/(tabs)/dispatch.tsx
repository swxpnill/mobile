import { RequireAction } from '../../../src/nav/guard';
import { DispatchScreen } from '../../../src/screens/dispatch/DispatchScreen';

export default function DispatchTab() {
  return (
    <RequireAction action="dispatch.view">
      <DispatchScreen />
    </RequireAction>
  );
}
