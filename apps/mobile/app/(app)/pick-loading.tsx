import { RequireAction } from '../../src/nav/guard';
import { LoadingPickerScreen } from '../../src/screens/create/LoadingPickerScreen';

/** Create new → Loading: choose the open sub-order, then `/assign/:subOrderId`. */
export default function PickLoading() {
  return (
    <RequireAction action="truck.assign">
      <LoadingPickerScreen />
    </RequireAction>
  );
}
