import { Redirect, Stack } from 'expo-router';
import { useSession } from '../../src/auth/session';

/** Everything behind sign-in. Signing out (or a refused refresh) lands on sign-in. */
export default function AppLayout() {
  const status = useSession((s) => s.status);
  if (status === 'signedOut') return <Redirect href="/sign-in" />;
  return <Stack screenOptions={{ headerShown: false }} />;
}
