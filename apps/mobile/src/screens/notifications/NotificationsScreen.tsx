import { type Notification, istDateOf } from '@tonnage/shared';
import { useRouter } from 'expo-router';
import { useCallback, useMemo } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { useDisplayBasis } from '../../api/hooks/me';
import { useMarkAllRead, useMarkRead, useNotifications } from '../../api/hooks/notifications';
import { dayGroupLabel } from '../../format/time';
import { openNotificationLink } from '../../notifications/openLink';
import { useTheme } from '../../theme/ThemeProvider';
import { MIN_TOUCH } from '../../theme/tokens';
import { Button, EmptyState, Group, Header, Screen, Text } from '../../ui';
import { messageFor } from '../messages';
import { NotificationRow } from './NotificationRow';

/** Rows grouped by IST day, newest first: "Today", "Yesterday", "3 Nov". */
export function groupByDay(items: readonly Notification[], nowMs: number): { title: string; items: Notification[] }[] {
  const today = istDateOf(nowMs);
  const out: { title: string; items: Notification[] }[] = [];
  for (const n of items) {
    const title = dayGroupLabel(istDateOf(n.createdAt), today);
    const last = out.at(-1);
    if (last?.title === title) last.items.push(n);
    else out.push({ title, items: [n] });
  }
  return out;
}

/** Canvas board 37. Text follows the person's unit basis without a refetch (spec §5.6). */
export function NotificationsScreen() {
  const router = useRouter();
  const { t } = useTheme();
  const basis = useDisplayBasis();
  const list = useNotifications();
  const markRead = useMarkRead();
  const markAll = useMarkAllRead();

  const items = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data]);
  const groups = useMemo(() => groupByDay(items, Date.now()), [items]);
  const anyUnread = items.some((n) => n.readAt === null);

  const open = useCallback(
    (n: Notification) => {
      if (n.readAt === null) markRead.mutate(n.id);
      openNotificationLink(router, n.deepLink);
    },
    [markRead, router],
  );

  return (
    <Screen
      title="Notifications"
      refresh={{ refreshing: list.isRefetching && !list.isFetchingNextPage, onRefresh: () => void list.refetch() }}
      header={
        <Header
          onBack={() => router.back()}
          right={
            anyUnread ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Mark all read"
                onPress={() => markAll.mutate(undefined)}
                style={({ pressed }) => [styles.action, pressed ? { backgroundColor: t.act } : null]}
              >
                <Text weight="medium" color="brt">
                  Mark all read
                </Text>
              </Pressable>
            ) : null
          }
        />
      }
    >
      {list.isPending ? (
        <ActivityIndicator color={t.br} accessibilityLabel="Loading" />
      ) : list.isError && items.length === 0 ? (
        <View style={styles.gap}>
          <Text color="tx2" accessibilityRole="alert">
            {messageFor(list.error)}
          </Text>
          <Button variant="secondary" onPress={() => void list.refetch()}>
            Try again
          </Button>
        </View>
      ) : items.length === 0 ? (
        <EmptyState icon="bell" title="No notifications yet" body="Orders, trucks and payments that need you show here." />
      ) : (
        <>
          {groups.map((g) => (
            <View key={g.title} style={styles.gap}>
              <Text variant="overline" accessibilityRole="header" style={styles.overline}>
                {g.title}
              </Text>
              <Group>
                {g.items.map((n) => (
                  <NotificationRow key={n.id} n={n} basis={basis} onPress={open} />
                ))}
              </Group>
            </View>
          ))}
          {list.hasNextPage ? (
            <Button variant="secondary" loading={list.isFetchingNextPage} onPress={() => void list.fetchNextPage()}>
              Show older
            </Button>
          ) : null}
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  gap: { gap: 10 },
  overline: { paddingHorizontal: 4 },
  action: { minHeight: MIN_TOUCH, paddingHorizontal: 12, borderRadius: 22, justifyContent: 'center' },
});
