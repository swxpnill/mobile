import { useLocalSearchParams } from 'expo-router';
import { RequireAction } from '../../../src/nav/guard';
import { UserDetailScreen } from '../../../src/screens/admin/UserDetailScreen';

export default function UserRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return (
    <RequireAction action="users.manage">
      <UserDetailScreen id={String(id)} />
    </RequireAction>
  );
}
