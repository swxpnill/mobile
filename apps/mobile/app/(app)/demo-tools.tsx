import { Redirect } from 'expo-router';
import { demoToolsEnabled } from '../../src/api/demo';
import { DemoToolsScreen } from '../../src/screens/DemoToolsScreen';

/** Mock mode only; a deep link in any other build goes home. */
export default function DemoTools() {
  if (!demoToolsEnabled()) return <Redirect href="/" />;
  return <DemoToolsScreen />;
}
