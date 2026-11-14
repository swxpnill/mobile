import { useState } from 'react';
import { useSession } from '../auth/session';
import { useSyncStatus } from '../offline/useSync';
import { MenuRow } from '../ui';
import { SignOutGuardSheet } from './supervisor/SignOutGuardSheet';
import { weights } from './supervisor/usePlantTitle';

/**
 * Red "Sign out" row; ignores repeat taps while signing out. With weights not sent yet it says
 * so and opens the guard sheet instead (Ruling 11).
 */
export function SignOutRow() {
  const [busy, setBusy] = useState(false);
  const [guard, setGuard] = useState(false);
  const pending = useSyncStatus((s) => s.pending);
  const note = pending > 0 ? `${weights(pending)} not sent yet` : undefined;

  function signOut() {
    if (busy) return;
    setBusy(true);
    setGuard(false);
    void useSession
      .getState()
      .signOut()
      .finally(() => setBusy(false));
  }

  return (
    <>
      <MenuRow
        icon="logout"
        tone="rd"
        label="Sign out"
        value={note}
        accessibilityLabel={note ? `Sign out, ${note}` : undefined}
        danger
        onPress={() => (pending > 0 ? setGuard(true) : signOut())}
      />
      <SignOutGuardSheet visible={guard} onClose={() => setGuard(false)} onConfirm={signOut} />
    </>
  );
}
