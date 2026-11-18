import { RequireAction } from '../../src/nav/guard';
import { ReportsScreen } from '../../src/screens/reports/ReportsScreen';

/** More → Reports (board 23): `reports.view` roles only; anyone else lands on their first tab. */
export default function Reports() {
  return (
    <RequireAction action="reports.view">
      <ReportsScreen />
    </RequireAction>
  );
}
