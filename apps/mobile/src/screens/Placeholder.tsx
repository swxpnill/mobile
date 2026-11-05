import { useMe } from '../api/hooks/me';
import { EmptyState, type IconName, Screen } from '../ui';

/** A tab whose screen is built in a later milestone: what it will hold and when. */
export function Placeholder({
  title,
  icon,
  milestone,
  body,
  greet,
}: {
  title: string;
  icon: IconName;
  milestone: string;
  body: string;
  /** Home greets the user by first name. */
  greet?: boolean;
}) {
  const { data: me } = useMe();
  const first = me?.name.split(' ')[0];
  return (
    <Screen title={greet && first ? `Hello, ${first}` : title} edges={['top']}>
      <EmptyState icon={icon} title={`${title} arrives in ${milestone}`} body={body} />
    </Screen>
  );
}
