import { RequireAction } from '../../../src/nav/guard';
import { ComingNext } from '../../../src/screens/ComingNext';

export default function Users() {
  return (
    <RequireAction action="users.manage">
      <ComingNext
        title="Users & roles"
        icon="shield"
        body="Invite staff, set their role and plants, deactivate access."
      />
    </RequireAction>
  );
}
