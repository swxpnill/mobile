import { RequireAction } from '../../../src/nav/guard';
import { CompaniesScreen } from '../../../src/screens/admin/CompaniesScreen';

export default function Companies() {
  return (
    <RequireAction action="companies.manage">
      <CompaniesScreen />
    </RequireAction>
  );
}
