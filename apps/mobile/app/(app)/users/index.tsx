import { RequireAction } from '../../../src/nav/guard';
import { UsersScreen } from '../../../src/screens/admin/UsersScreen';

export default function Users() {
  return (
    <RequireAction action="users.manage">
      <UsersScreen />
    </RequireAction>
  );
}
