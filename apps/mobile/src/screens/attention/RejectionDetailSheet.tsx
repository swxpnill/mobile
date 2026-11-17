import type { Rejection } from '@tonnage/shared';
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { ApiError } from '../../api/client';
import { useDisplayBasis } from '../../api/hooks/me';
import { useResolveRejection } from '../../api/hooks/rejections';
import { useTruck } from '../../api/hooks/trucks';
import { useSingleFlight, useSubmitKey } from '../../api/submitKey';
import { istClock } from '../../format/time';
import { useTheme } from '../../theme/ThemeProvider';
import { Button, showToast, Text, TextField } from '../../ui';
import { Sheet } from '../../ui/Sheet';
import { messageFor, weightCodeMessage } from '../messages';
import { EVENT_LABEL, chainOf, firstName, hasEarlierOpen, rejectionReason, restoreExplanation, sentLine } from './describe';

const MIN_REASON = 3;

/** Why a restore was refused, in plain words; the rejections stay open. */
function restoreRefused(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === 'ORDER_LOCKED') return 'This order is closed. Reopen it first, then restore.';
    const why = weightCodeMessage(e.code);
    if (why) return `Refused again: ${why.charAt(0).toLowerCase()}${why.slice(1)}. Nothing changed.`;
  }
  return messageFor(e);
}

/** One refused weight: what was sent and why, what Restore will do, or Dismiss with a reason. */
export function RejectionDetailSheet({
  rejection: r,
  list,
  visible,
  onClose,
}: {
  rejection: Rejection;
  /** The open list, for the later weights of the same truck that a restore takes along. */
  list: readonly Rejection[];
  visible: boolean;
  onClose(): void;
}) {
  const { t } = useTheme();
  const basis = useDisplayBasis();
  const truck = useTruck(visible ? r.truckId : undefined);
  const resolve = useResolveRejection();
  const once = useSingleFlight();
  const restoreKey = useSubmitKey();
  const dismissKey = useSubmitKey();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!visible) return;
    setReason('');
    setError(undefined);
  }, [visible, r.id]);

  const chain = chainOf(r, list);
  const busy = resolve.isPending;
  const reasonOk = reason.trim().length >= MIN_REASON;

  const done = (message: string) => {
    showToast(message);
    onClose();
  };

  const failed = (e: unknown, kind: 'restore' | 'dismiss') => {
    if (e instanceof ApiError && e.code === 'ALREADY_RESOLVED') return done('Someone already handled this. Showing the latest.');
    setError(kind === 'restore' ? restoreRefused(e) : messageFor(e));
  };

  const restore = async () => {
    setError(undefined);
    const key = restoreKey.key(r.id);
    try {
      const res = await resolve.mutateAsync({ kind: 'restore', id: r.id, key });
      restoreKey.settle();
      done(`${r.vehicleNo} restored · ${res.truck?.state === 'dispatched' ? 'dispatched' : 'weights saved'}`);
    } catch (e) {
      restoreKey.settle(e);
      failed(e, 'restore');
    }
  };

  const dismiss = async () => {
    if (!reasonOk) return;
    setError(undefined);
    const text = reason.trim();
    // A changed reason is a new request: the key follows what is sent.
    const key = dismissKey.key(`${r.id}:${text}`);
    try {
      await resolve.mutateAsync({ kind: 'dismiss', id: r.id, reason: text, key });
      dismissKey.settle();
      done('Dismissed');
    } catch (e) {
      dismissKey.settle(e);
      failed(e, 'dismiss');
    }
  };

  const others = chain.length - 1;
  return (
    <Sheet visible={visible} title={`${r.vehicleNo} · ${EVENT_LABEL[r.eventType].toLowerCase()} refused`} onClose={onClose} busy={busy}>
      <View style={[styles.card, { backgroundColor: t.ctl }]}>
        <Text weight="semibold" numeric>
          {sentLine(r, basis)}
        </Text>
        <Text color="dgt" style={styles.small}>
          {rejectionReason(r.code)}
        </Text>
        <Text variant="caption">{`Sent by ${r.user.name} · ${r.plantName} · ${istClock(r.createdAt)} · ${r.subOrderNumber}`}</Text>
      </View>

      <Text variant="caption" weight="medium">
        Restore
      </Text>
      <Text>{restoreExplanation(r, chain, truck.data)}</Text>
      {others > 0 ? (
        <Text variant="caption">
          {`${chain.length} weights from ${firstName(r.user.name)}'s phone go back together, in the order they were taken. If any is refused again, nothing changes.`}
        </Text>
      ) : null}
      {hasEarlierOpen(r, list) ? (
        <Text variant="caption" color="wnt">
          An earlier weight of this truck is also waiting. Restore that one first: this one goes back with it.
        </Text>
      ) : null}
      <Button loading={busy && resolve.variables?.kind === 'restore'} disabled={busy} onPress={() => void once(restore)}>
        Restore
      </Button>

      <TextField
        label="Reason to dismiss"
        placeholder="e.g. Truck went back empty"
        value={reason}
        onChangeText={setReason}
        maxLength={200}
        hint={`At least ${MIN_REASON} characters. The weight stays refused.`}
      />
      {error ? (
        <Text color="dgt" accessibilityRole="alert" accessibilityLiveRegion="polite">
          {error}
        </Text>
      ) : null}
      <Button
        variant="secondary"
        disabled={!reasonOk || busy}
        loading={busy && resolve.variables?.kind === 'dismiss'}
        onPress={() => void once(dismiss)}
      >
        Dismiss
      </Button>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  card: { padding: 14, borderRadius: 12, gap: 4 },
  small: { fontSize: 13, lineHeight: 18 },
});
