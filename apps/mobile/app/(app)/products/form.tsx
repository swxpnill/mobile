import { useLocalSearchParams } from 'expo-router';
import { RequireAction } from '../../../src/nav/guard';
import { ProductFormScreen } from '../../../src/screens/products/ProductFormScreen';

/** No params adds a product; `?id=…` edits it. */
export default function ProductForm() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  return (
    <RequireAction action="masters.manage">
      <ProductFormScreen id={id} />
    </RequireAction>
  );
}
