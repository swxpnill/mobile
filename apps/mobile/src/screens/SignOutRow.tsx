import { useState } from 'react';
import { useSession } from '../auth/session';
import { MenuRow } from '../ui';

/** Red "Sign out" row; ignores repeat taps while signing out. */
export function SignOutRow() {
  const [busy, setBusy] = useState(false);
  return (
    <MenuRow
      icon="logout"
      tone="rd"
      label="Sign out"
      danger
      onPress={() => {
        if (busy) return;
        setBusy(true);
        void useSession
          .getState()
          .signOut()
          .finally(() => setBusy(false));
      }}
    />
  );
}
