import { RequireAction } from '../../../src/nav/guard';
import { ProductsScreen } from '../../../src/screens/products/ProductsScreen';

export default function Products() {
  return (
    <RequireAction action="masters.manage">
      <ProductsScreen />
    </RequireAction>
  );
}
