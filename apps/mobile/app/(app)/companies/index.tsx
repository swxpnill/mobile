import { RequireAction } from '../../../src/nav/guard';
import { ComingNext } from '../../../src/screens/ComingNext';

export default function Companies() {
  return (
    <RequireAction action="companies.manage">
      <ComingNext
        title="Companies & units"
        icon="factory"
        body="Add and edit your companies, GSTINs, order prefixes and plants."
      />
    </RequireAction>
  );
}
