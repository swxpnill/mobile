import type { Rejection } from '@tonnage/shared';
import { useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { useDisplayBasis } from '../../api/hooks/me';
import { type RejectionFilter, useRejections } from '../../api/hooks/rejections';
import { istClock } from '../../format/time';
import { useTheme } from '../../theme/ThemeProvider';
import { Badge, EmptyState, Group, Row, Screen, SegmentedControl, Text } from '../../ui';
import { BackHeader } from '../admin/parts';
import { messageFor } from '../messages';
import { EVENT_LABEL, rejectionReason, resolutionLine, sentLine } from './describe';
import { RejectionDetailSheet } from './RejectionDetailSheet';

const FILTERS: readonly { value: RejectionFilter; label: string }[] = [
  { value: 'open', label: 'Open' },
  { value: 'all', label: 'All' },
];

/**
 * More → Needs attention (Ruling 8, owner only): weights a phone sent that the server refused.
 * Each opens a sheet to restore it (re-run through the same dispatch code) or dismiss it.
 */
export function NeedsAttentionScreen() {
  const { t } = useTheme();
  const [filter, setFilter] = useState<RejectionFilter>('open');
  const [openId, setOpenId] = useState<string | null>(null);
  const list = useRejections(filter);
  const items = list.data ?? [];
  // The sheet reads from the open list (the chain a restore re-runs); kept while it closes.
  const selected = items.find((x) => x.id === openId);

  let body;
  if (list.isPending) body = <ActivityIndicator color={t.br} accessibilityLabel="Loading" />;
  else if (list.isError && !list.data)
    body = (
      <EmptyState
        icon="alert"
        title="Couldn't load"
        body={messageFor(list.error)}
        actions={[{ label: 'Try again', onPress: () => void list.refetch() }]}
      />
    );
  else if (items.length === 0)
    body = (
      <EmptyState
        icon="check"
        title={filter === 'open' ? 'Nothing needs attention' : 'Nothing here yet'}
        body="Weights the server refuses from a plant phone show here, for you to restore or dismiss."
      />
    );
  else
    body = (
      <Group>
        {items.map((r) => (
          <RejectionRow key={r.id} r={r} onPress={r.status === 'open' ? () => setOpenId(r.id) : undefined} />
        ))}
      </Group>
    );

  return (
    <Screen header={<BackHeader />} refresh={{ refreshing: list.isRefetching, onRefresh: () => void list.refetch() }}>
      <View style={styles.head}>
        <Text variant="title" accessibilityRole="header">
          Needs attention
        </Text>
        <Text variant="caption">Weights a plant phone sent that the server refused</Text>
      </View>
      <SegmentedControl options={FILTERS} value={filter} onChange={(v) => setFilter(v)} size="full" accessibilityLabel="Show" />
      {body}
      {selected ? (
        <RejectionDetailSheet
          rejection={selected}
          list={items}
          visible={openId !== null}
          onClose={() => setOpenId(null)}
        />
      ) : null}
    </Screen>
  );
}

function RejectionRow({ r, onPress }: { r: Rejection; onPress?: () => void }) {
  const basis = useDisplayBasis();
  const why = rejectionReason(r.code);
  const sent = sentLine(r, basis);
  const who = `${r.user.name} · ${r.plantName} · ${istClock(r.createdAt)}`;
  const resolved = resolutionLine(r);
  return (
    <Row
      onPress={onPress}
      accessibilityLabel={[`${r.vehicleNo}, ${EVENT_LABEL[r.eventType].toLowerCase()}`, sent, why, who, resolved]
        .filter(Boolean)
        .join('. ')}
    >
      <View style={styles.fill}>
        <View style={styles.inline}>
          <Text weight="semibold" style={styles.shrink} numberOfLines={1}>
            {r.vehicleNo}
          </Text>
          <Badge kind={r.eventType === 'TARE' ? 'vi' : 'br'}>{EVENT_LABEL[r.eventType]}</Badge>
          {r.status === 'open' ? null : <Badge kind={r.status === 'restored' ? 'ok' : 'nu'}>{r.status === 'restored' ? 'Restored' : 'Dismissed'}</Badge>}
        </View>
        <Text numeric>{sent}</Text>
        <Text color="dgt" style={styles.small}>
          {why}
        </Text>
        <Text variant="caption">{`${who} · ${r.subOrderNumber}`}</Text>
        {resolved ? <Text variant="caption">{resolved}</Text> : null}
      </View>
    </Row>
  );
}

const styles = StyleSheet.create({
  head: { gap: 4 },
  fill: { flex: 1, minWidth: 0, gap: 3 },
  shrink: { flexShrink: 1 },
  inline: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  small: { fontSize: 13, lineHeight: 18 },
});
