import { useRouter } from 'expo-router';
import { EmptyState, Header, type IconName, Screen } from '../ui';

/** A pushed screen whose content is built in the next task. */
export function ComingNext({ title, icon, body }: { title: string; icon: IconName; body: string }) {
  const router = useRouter();
  return (
    <Screen title={title} header={<Header onBack={() => router.back()} />}>
      <EmptyState icon={icon} title="Arrives in the next step" body={body} />
    </Screen>
  );
}
