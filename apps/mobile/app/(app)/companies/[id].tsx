import { useLocalSearchParams } from 'expo-router';
import { RequireAction } from '../../../src/nav/guard';
import { CompanyFormScreen } from '../../../src/screens/admin/CompanyFormScreen';

/** `/companies/new` adds a company; `/companies/<id>` edits one. */
export default function Company() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return (
    <RequireAction action="companies.manage">
      <CompanyFormScreen id={String(id)} />
    </RequireAction>
  );
}
