import { useSession } from '../auth/session';
import { tourStore } from './tourStore';
import { WelcomeScreen } from './WelcomeScreen';

/**
 * Welcome back lives in the root shell, beside the lock screen and above the router's stack, so
 * the signed-in stack's slide-in never moves it and its first frame lines up with the splash.
 */
export function WelcomeHost() {
  const status = useSession((s) => s.status);
  const welcome = tourStore((s) => s.welcome);
  return status === 'signedIn' && welcome ? <WelcomeScreen /> : null;
}
