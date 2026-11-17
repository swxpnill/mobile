import { RequireAction } from '../../src/nav/guard';
import { NeedsAttentionScreen } from '../../src/screens/attention/NeedsAttentionScreen';

/** More → Needs attention (Ruling 8): owner only; anyone else lands on their first tab. */
export default function Attention() {
  return (
    <RequireAction action="rejections.manage">
      <NeedsAttentionScreen />
    </RequireAction>
  );
}
