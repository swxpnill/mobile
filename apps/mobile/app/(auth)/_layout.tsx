import { Redirect, Stack } from 'expo-router';
import { useSession } from '../../src/auth/session';

/** Sign-in flow. A signed-in user never sees it (e.g. after pressing back). */
export default function AuthLayout() {
  const status = useSession((s) => s.status);
  if (status === 'signedIn') return <Redirect href="/home" />;
  return <Stack screenOptions={{ headerShown: false }} />;
}
