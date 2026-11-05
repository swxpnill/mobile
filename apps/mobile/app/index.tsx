import { Redirect } from 'expo-router';
import { useSession } from '../src/auth/session';

/** Entry: signed-in users go home, everyone else to sign-in. */
export default function Index() {
  const status = useSession((s) => s.status);
  return <Redirect href={status === 'signedIn' ? '/home' : '/sign-in'} />;
}
