import { Redirect } from 'expo-router';
import { demoToolsEnabled } from '../../src/api/demo';
import { DemoSignInScreen } from '../../src/screens/DemoSignInScreen';

/** Mock mode only; any other build goes back to the normal sign-in. */
export default function DemoSignIn() {
  if (!demoToolsEnabled()) return <Redirect href="/sign-in" />;
  return <DemoSignInScreen />;
}
