import { useLocalSearchParams } from 'expo-router';
import { RequireAction } from '../../../src/nav/guard';
import { PlantFormScreen } from '../../../src/screens/admin/PlantFormScreen';

/** `/companies/plant?companyId=…` adds a plant; with `&id=…` edits one. */
export default function PlantRoute() {
  const { companyId, id } = useLocalSearchParams<{ companyId: string; id?: string }>();
  return (
    <RequireAction action="companies.manage">
      <PlantFormScreen companyId={String(companyId)} id={id ? String(id) : undefined} />
    </RequireAction>
  );
}
