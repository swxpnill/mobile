import { RequireAction } from '../../src/nav/guard';
import { NotificationsScreen } from '../../src/screens/notifications/NotificationsScreen';

/** Everyone's own notifications (board 37). */
export default function Notifications() {
  return (
    <RequireAction action="self.view">
      <NotificationsScreen />
    </RequireAction>
  );
}
