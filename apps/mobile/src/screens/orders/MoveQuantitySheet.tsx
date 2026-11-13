import { type Order, formatLength, isTerminal, parseQtyInput, toDisplayQty, unitLabel } from '@tonnage/shared';
import { useEffect, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { z } from 'zod';
import { ApiError } from '../../api/client';
import { byCode, useCompanies } from '../../api/hooks/companies';
import { useProducts } from '../../api/hooks/masters';
import { useDisplayBasis } from '../../api/hooks/me';
import { useMoveQuantity } from '../../api/hooks/orders';
import { useSingleFlight } from '../../api/submitKey';
import { Button, ChoiceRow, Group, showToast, Text, TextField } from '../../ui';
import { Sheet } from '../../ui/Sheet';
import { MSG, messageFor } from '../messages';

/**
 * Move undispatched quantity from one company's line to another company that makes the same
 * product (spec §5.3, default yes). Only what is neither dispatched nor planned on a truck moves.
 */
export function MoveQuantitySheet({ order, visible, onClose }: { order: Order; visible: boolean; onClose(): void }) {
  const basis = useDisplayBasis();
  const { data: companies } = useCompanies();
  const { data: products } = useProducts({}, visible);
  const move = useMoveQuantity();
  const once = useSingleFlight();
  const [lineId, setLineId] = useState<string>();
  const [toCompanyId, setTo] = useState<string>();
  const [qty, setQty] = useState('');
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (visible) {
      setLineId(undefined);
      setTo(undefined);
      setQty('');
      setError(undefined);
    }
  }, [visible]);

  const sources = useMemo(
    () =>
      order.subOrders
        .filter((s) => !isTerminal(s.status))
        .flatMap((s) => s.lines.map((l) => ({ s, l, availableKg: Math.max(0, l.pendingKg - l.reservedKg) })))
        .filter((x) => x.availableKg > 0),
    [order],
  );
  const from = sources.find((x) => x.l.id === lineId);
  const makers = new Set(products?.find((p) => p.id === from?.l.productId)?.companyIds ?? []);
  const targets = byCode(companies ?? []).filter((c) => c.active && makers.has(c.id) && c.id !== from?.s.companyId);
  const parsed = parseQtyInput(qty, basis);
  const kg = parsed.ok ? parsed.value : 0;
  const unit = unitLabel(basis);

  const run = async () => {
    if (!from || !toCompanyId) return;
    if (!parsed.ok || kg <= 0) return setError('Enter the quantity to move');
    if (kg > from.availableKg) return setError(`At most ${toDisplayQty(from.availableKg, basis, { withUnit: true })} can move`);
    setError(undefined);
    try {
      await move.mutateAsync({ orderId: order.id, body: { fromLineId: from.l.id, toCompanyId, kg, version: order.version } });
      showToast(`${toDisplayQty(kg, basis, { withUnit: true })} moved`);
      onClose();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'MOVE_EXCEEDS_AVAILABLE') {
        const d = z.object({ availableKg: z.number() }).safeParse(e.details);
        setError(d.success ? `At most ${toDisplayQty(d.data.availableKg, basis, { withUnit: true })} can move now` : messageFor(e));
      } else if (e instanceof ApiError && e.code === 'STALE') {
        showToast(MSG.stale);
        onClose();
      } else setError(messageFor(e));
    }
  };

  return (
    <Sheet visible={visible} title="Move quantity" onClose={onClose} busy={move.isPending}>
      {sources.length === 0 ? (
        <Text color="tx2">Nothing can move: every line is dispatched, closed or planned on a truck.</Text>
      ) : (
        <>
          <Text variant="caption" weight="medium">
            From
          </Text>
          <Group>
            {sources.map(({ s, l, availableKg }) => (
              <ChoiceRow
                key={l.id}
                kind="radio"
                title={`${s.companyCode} · ${l.productName} · ${formatLength(l.length)}`}
                detail={`${toDisplayQty(availableKg, basis, { withUnit: true })} can move`}
                checked={l.id === lineId}
                onPress={() => {
                  setLineId(l.id);
                  setTo(undefined);
                }}
              />
            ))}
          </Group>
          {from ? (
            <>
              <Text variant="caption" weight="medium">
                To
              </Text>
              {targets.length === 0 ? (
                <Text color="tx2">No other active company makes this product.</Text>
              ) : (
                <Group>
                  {targets.map((c) => (
                    <ChoiceRow key={c.id} kind="radio" title={c.name} detail={c.code} checked={c.id === toCompanyId} onPress={() => setTo(c.id)} />
                  ))}
                </Group>
              )}
              <TextField
                label="Quantity to move"
                value={qty}
                onChangeText={setQty}
                hint={`In ${unit}. Up to ${toDisplayQty(from.availableKg, basis, { withUnit: true })}.`}
                keyboardType={basis === 'mt' ? 'decimal-pad' : 'number-pad'}
                maxLength={12}
              />
            </>
          ) : null}
          {error ? (
            <Text color="dgt" accessibilityRole="alert">
              {error}
            </Text>
          ) : null}
          <View style={styles.buttons}>
            <Button variant="secondary" disabled={move.isPending} onPress={onClose}>
              Cancel
            </Button>
            <Button
              disabled={!from || !toCompanyId || !parsed.ok || kg <= 0}
              loading={move.isPending}
              onPress={() => void once(run)}
              style={styles.fill}
            >
              {kg > 0 ? `Move ${toDisplayQty(kg, basis, { withUnit: true })}` : 'Move'}
            </Button>
          </View>
        </>
      )}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  buttons: { flexDirection: 'row', gap: 10 },
  fill: { flex: 1, minWidth: 0 },
});
