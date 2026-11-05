import { RequireAction } from '../../../src/nav/guard';
import { InviteScreen } from '../../../src/screens/admin/InviteScreen';

export default function Invite() {
  return (
    <RequireAction action="users.manage">
      <InviteScreen />
    </RequireAction>
  );
}
