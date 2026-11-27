import { type LedgerEntry, type Party, can, istDateOf, toDisplayRate } from '@tonnage/shared';
import { useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { useDisplayBasis, useMe } from '../../api/hooks/me';
import { type LedgerView, useBrokerLedger } from '../../api/hooks/money';
import { useTheme } from '../../theme/ThemeProvider';
import { Avatar, Badge, Button, IconButton, Screen, SegmentedControl, Text } from '../../ui';
import { BackHeader } from '../admin/parts';
import { messageFor } from '../messages';
import { Action, Contacts, call, firstNumbers, partyStyles, whatsapp } from '../parties/partyParts';
import { DueCard } from './DueCard';
import { LedgerEntrySheet } from './LedgerEntrySheet';
import { LedgerList } from './LedgerList';
import { RecordPaymentSheet } from './RecordPaymentSheet';
import { TourTarget } from '../../onboarding/TourTarget';
import { useFirstTip } from '../../onboarding/useFirstTip';

const VIEWS: readonly { value: LedgerView; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'earnings', label: 'Earnings' },
  { value: 'payments', label: 'Payments' },
];
const EMPTY: Record<LedgerView, string> = {
  all: 'No entries yet',
  earnings: 'No earnings yet',
  payments: 'No payments yet',
};

/** Board 06: a broker's header and contacts (as board 05), what is due, and the ledger. */
export function BrokerProfileScreen({ party }: { party: Party }) {
  useFirstTip('ledger.recordPayment');
  const router = useRouter();
  const { t } = useTheme();
  const basis = useDisplayBasis();
  const { data: me } = useMe();
  const canPay = me !== undefined && can(me.role, 'broker.pay');
  const [view, setView] = useState<LedgerView>('all');
  const [paying, setPaying] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const ledger = useBrokerLedger(party.id, view);
  const entries = useMemo(() => ledger.data?.pages.flatMap((p) => p.items) ?? [], [ledger.data]);
  const summary = ledger.data?.pages[0]?.summary;
  const today = istDateOf(Date.now());
  const { first, firstWa } = firstNumbers(party);
  const open = entries.find((e) => e.id === openId) ?? null;

  const onPressEntry = useCallback((e: LedgerEntry) => setOpenId(e.id), []);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = ledger;
  const onEndReached = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const rate = party.defaultCommissionPerMt;
  const subtitle = [party.city, rate != null ? `default ${toDisplayRate(rate, basis, { withUnit: true })}` : null]
    .filter(Boolean)
    .join(' · ');

  const header = (
    <View style={styles.header}>
      <View style={partyStyles.head}>
        <Avatar name={party.name} tone={party.active ? 'vi' : 'nu'} size={56} />
        <View style={partyStyles.fill}>
          <Text variant="subtitle" weight="semibold" accessibilityRole="header">
            {party.name}
          </Text>
          <View style={partyStyles.inline}>
            <Badge kind="vi">Broker</Badge>
            {!party.active ? <Badge kind="nu">Inactive</Badge> : null}
            <Text variant="caption" style={partyStyles.fill} numberOfLines={2}>
              {subtitle}
            </Text>
          </View>
        </View>
      </View>

      <View style={partyStyles.actions}>
        <Action icon="phone" label="Call" disabled={!first} onPress={() => first && call(first.number)} />
        <Action icon="message" label="WhatsApp" color="okt" disabled={!firstWa} onPress={() => firstWa && whatsapp(firstWa.number)} />
        {/* The statement PDF arrives with the exports (Task 7). */}
        <Action icon="file" label="Statement" color="vi" disabled accessibilityLabel="Statement, coming soon" onPress={() => undefined} />
      </View>

      {summary ? (
        <DueCard summary={summary} basis={basis} />
      ) : ledger.isPending ? (
        <ActivityIndicator color={t.br} accessibilityLabel="Loading the ledger" style={styles.loading} />
      ) : null}

      <Contacts p={party} />

      <Text variant="heading" accessibilityRole="header" style={styles.ledgerTitle}>
        Ledger
      </Text>
      <SegmentedControl size="full" accessibilityLabel="Ledger view" options={VIEWS} value={view} onChange={(v: LedgerView) => setView(v)} />
    </View>
  );

  const empty = ledger.isPending ? null : ledger.isError ? (
    <View style={styles.gap}>
      <Text color="tx2" accessibilityRole="alert">
        {messageFor(ledger.error)}
      </Text>
      <Button variant="secondary" onPress={() => void ledger.refetch()}>
        Try again
      </Button>
    </View>
  ) : (
    <Text color="tx2" style={styles.empty}>
      {EMPTY[view]}
    </Text>
  );

  return (
    <Screen
      scroll={false}
      contentStyle={styles.screen}
      header={
        <BackHeader
          right={<IconButton icon="pencil" label="Edit broker" onPress={() => router.push({ pathname: '/parties/form', params: { id: party.id } })} />}
        />
      }
      footer={
        canPay ? (
          <TourTarget id="ledger.recordPayment">
            <Button disabled={!summary} onPress={() => setPaying(true)}>
              Record payment
            </Button>
          </TourTarget>
        ) : undefined
      }
    >
      <LedgerList
        entries={entries}
        basis={basis}
        today={today}
        header={header}
        empty={empty ?? <View />}
        onEndReached={onEndReached}
        loadingMore={isFetchingNextPage}
        onPressEntry={onPressEntry}
        bottomInset={24}
        refresh={{ refreshing: ledger.isRefetching && !isFetchingNextPage, onRefresh: () => void ledger.refetch() }}
      />
      {canPay && summary ? (
        <RecordPaymentSheet
          broker={{ id: party.id, name: party.name }}
          dueRupees={summary.dueRupees}
          visible={paying}
          onClose={() => setPaying(false)}
        />
      ) : null}
      <LedgerEntrySheet
        entry={open}
        reversed={open?.reversesId ? entries.find((e) => e.id === open.reversesId) : undefined}
        basis={basis}
        canReverse={canPay}
        onClose={() => setOpenId(null)}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  screen: { paddingHorizontal: 0, paddingTop: 0, paddingBottom: 0, gap: 0 },
  header: { gap: 18, paddingTop: 4 },
  loading: { paddingVertical: 32 },
  ledgerTitle: { marginTop: 4 },
  gap: { gap: 12, paddingTop: 12 },
  empty: { textAlign: 'center', paddingVertical: 24 },
});
