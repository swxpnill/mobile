import { useRejectionsOnFocus } from '../../../src/api/hooks/rejections';
import { MoreScreen } from '../../../src/screens/MoreScreen';

/** More stays mounted as a tab: the Needs attention badge refetches whenever it gains focus. */
export default function More() {
  useRejectionsOnFocus();
  return <MoreScreen />;
}
